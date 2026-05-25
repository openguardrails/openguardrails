from typing import Dict, List, Any
import uuid
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, case
from database.models import DetectionResult, TenantDetectionStats
from utils.logger import setup_logger

logger = setup_logger()

class StatsService:
    """Stats analysis service.

    Step 7.4: dashboard summary + daily trends now read from
    `tenant_detection_stats` (per-(tenant, app, date) rollup), so they
    don't scan `detection_results` regardless of how big it grows.
    `get_category_distribution` still reads `detection_results` because
    category data is best-served by `detection_result_categories` (Step
    4.2 — already portable, not yet a separate rollup).
    """

    def __init__(self, db: Session):
        self.db = db

    def _scoped_stats_query(self, tenant_id: uuid.UUID = None, application_id: uuid.UUID = None):
        q = self.db.query(TenantDetectionStats)
        if tenant_id is not None:
            q = q.filter(TenantDetectionStats.tenant_id == tenant_id)
        if application_id is not None:
            q = q.filter(TenantDetectionStats.application_id == application_id)
        return q

    def get_dashboard_stats(self, tenant_id: uuid.UUID = None, application_id: uuid.UUID = None) -> Dict[str, Any]:
        """Get dashboard stats data (rollup-backed).

        Args:
            tenant_id: Tenant ID to filter by (required for data isolation)
            application_id: Optional Application ID to further narrow results
        """
        try:
            agg = self._scoped_stats_query(tenant_id, application_id).with_entities(
                func.coalesce(func.sum(TenantDetectionStats.total_count), 0).label('total'),
                func.coalesce(func.sum(TenantDetectionStats.security_count), 0).label('sec'),
                func.coalesce(func.sum(TenantDetectionStats.compliance_count), 0).label('comp'),
                func.coalesce(func.sum(TenantDetectionStats.data_count), 0).label('data'),
                func.coalesce(func.sum(TenantDetectionStats.high_risk_count), 0).label('high'),
                func.coalesce(func.sum(TenantDetectionStats.medium_risk_count), 0).label('med'),
                func.coalesce(func.sum(TenantDetectionStats.low_risk_count), 0).label('low'),
                func.coalesce(func.sum(TenantDetectionStats.no_risk_count), 0).label('safe'),
            ).one()

            return {
                "total_requests": int(agg.total),
                "security_risks": int(agg.sec),
                "compliance_risks": int(agg.comp),
                "data_leaks": int(agg.data),
                "high_risk_count": int(agg.high),
                "medium_risk_count": int(agg.med),
                "low_risk_count": int(agg.low),
                "safe_count": int(agg.safe),
                "risk_distribution": {
                    "high_risk": int(agg.high),
                    "medium_risk": int(agg.med),
                    "low_risk": int(agg.low),
                    "no_risk": int(agg.safe),
                },
                "daily_trends": self._get_daily_trends(7, tenant_id=tenant_id, application_id=application_id),
            }

        except Exception as e:
            logger.error(f"Get dashboard stats error: {e}")
            return self._get_empty_stats()
    
    def _get_highest_risk_level(self, security_risk: str, compliance_risk: str, data_risk: str = "no_risk") -> str:
        """Get highest risk level from three risk levels"""
        risk_priority = {
            "high_risk": 4,
            "medium_risk": 3,
            "low_risk": 2,
            "no_risk": 1
        }

        sec_priority = risk_priority.get(security_risk, 1)
        comp_priority = risk_priority.get(compliance_risk, 1)
        data_priority = risk_priority.get(data_risk, 1)

        max_priority = max(sec_priority, comp_priority, data_priority)
        for risk, priority in risk_priority.items():
            if priority == max_priority:
                return risk

        return "no_risk"
    
    def _get_daily_trends(self, days: int, tenant_id: uuid.UUID = None, application_id: uuid.UUID = None) -> List[Dict[str, Any]]:
        """Get daily trends from the rollup table (Step 7.4).

        At most `days` rows from `tenant_detection_stats` per tenant/app
        per day — the previous implementation scanned every row in
        `detection_results`. UTC date buckets; the dashboard handles
        timezone presentation.
        """
        try:
            end_date = datetime.now().date()
            start_date = end_date - timedelta(days=days - 1)

            # Sum per day across all applications for this tenant.
            rows = self._scoped_stats_query(tenant_id, application_id).with_entities(
                TenantDetectionStats.date.label('date'),
                func.coalesce(func.sum(TenantDetectionStats.total_count), 0).label('total'),
                func.coalesce(func.sum(TenantDetectionStats.high_risk_count), 0).label('high'),
                func.coalesce(func.sum(TenantDetectionStats.medium_risk_count), 0).label('med'),
                func.coalesce(func.sum(TenantDetectionStats.low_risk_count), 0).label('low'),
                func.coalesce(func.sum(TenantDetectionStats.no_risk_count), 0).label('safe'),
            ).filter(
                TenantDetectionStats.date >= start_date,
            ).group_by(TenantDetectionStats.date).all()

            by_date = {r.date: r for r in rows}

            trends = []
            for i in range(days):
                d = start_date + timedelta(days=i)
                r = by_date.get(d)
                if r is not None:
                    trends.append({
                        "date": d.isoformat(),
                        "total": int(r.total),
                        "high_risk": int(r.high),
                        "medium_risk": int(r.med),
                        "low_risk": int(r.low),
                        "safe": int(r.safe),
                    })
                else:
                    trends.append({
                        "date": d.isoformat(),
                        "total": 0,
                        "high_risk": 0,
                        "medium_risk": 0,
                        "low_risk": 0,
                        "safe": 0,
                    })
            return trends

        except Exception as e:
            logger.error(f"Get daily trends error: {e}")
            return []
    
    def get_category_distribution(self, start_date: str = None, end_date: str = None, tenant_id: uuid.UUID = None, application_id: uuid.UUID = None, tz_offset: int = None) -> List[Dict[str, Any]]:
        """Get risk category distribution statistics

        Args:
            start_date: Start date for filtering (YYYY-MM-DD)
            end_date: End date for filtering (YYYY-MM-DD)
            tenant_id: Tenant ID to filter by
            application_id: Application ID to filter by
            tz_offset: Client timezone offset in minutes (JS getTimezoneOffset)
        """
        try:
            # Build query conditions - query records with security or compliance risks
            query = self.db.query(DetectionResult).filter(
                (DetectionResult.security_risk_level != "no_risk") |
                (DetectionResult.compliance_risk_level != "no_risk")
            )

            # Always filter by tenant for data isolation
            if tenant_id is not None:
                query = query.filter(DetectionResult.tenant_id == str(tenant_id))
            if application_id is not None:
                query = query.filter(DetectionResult.application_id == application_id)
            if start_date:
                start_dt = datetime.strptime(start_date, '%Y-%m-%d')
                if tz_offset is not None:
                    start_dt = start_dt + timedelta(minutes=tz_offset)
                query = query.filter(DetectionResult.created_at >= start_dt)
            if end_date:
                end_dt = datetime.strptime(end_date, '%Y-%m-%d').replace(hour=23, minute=59, second=59)
                if tz_offset is not None:
                    end_dt = end_dt + timedelta(minutes=tz_offset)
                query = query.filter(DetectionResult.created_at <= end_dt)
            
            # Get categories field of all related records
            results = query.with_entities(
                DetectionResult.security_categories,
                DetectionResult.compliance_categories
            ).all()
            
            # Count category distribution
            category_count = {}
            import json
            
            for security_cats, compliance_cats in results:
                # Process security categories
                if security_cats:
                    try:
                        if isinstance(security_cats, str):
                            sec_categories = json.loads(security_cats)
                        else:
                            sec_categories = security_cats if isinstance(security_cats, list) else []
                        
                        for category in sec_categories:
                            if category and category.strip():
                                category_count[category] = category_count.get(category, 0) + 1
                    except (json.JSONDecodeError, TypeError):
                        pass
                
                # Process compliance categories
                if compliance_cats:
                    try:
                        if isinstance(compliance_cats, str):
                            comp_categories = json.loads(compliance_cats)
                        else:
                            comp_categories = compliance_cats if isinstance(compliance_cats, list) else []
                        
                        for category in comp_categories:
                            if category and category.strip():
                                category_count[category] = category_count.get(category, 0) + 1
                    except (json.JSONDecodeError, TypeError):
                        pass
            
            # Convert to frontend needed format and sort
            category_data = [
                {"name": name, "value": value} 
                for name, value in category_count.items()
            ]
            category_data.sort(key=lambda x: x['value'], reverse=True)
            
            # Only return top 10 categories
            return category_data[:10]
            
        except Exception as e:
            logger.error(f"Get category distribution error: {e}")
            return []

    def _get_empty_stats(self) -> Dict[str, Any]:
        """Get empty stats data"""
        return {
            "total_requests": 0,
            "security_risks": 0,
            "compliance_risks": 0,
            "data_leaks": 0,
            "high_risk_count": 0,
            "medium_risk_count": 0,
            "low_risk_count": 0,
            "safe_count": 0,
            "risk_distribution": {
                "high_risk": 0,
                "medium_risk": 0,
                "low_risk": 0,
                "no_risk": 0
            },
            "daily_trends": []
        }