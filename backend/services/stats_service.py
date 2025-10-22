from typing import Dict, List, Any
import uuid
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, case
from database.models import DetectionResult
from utils.logger import setup_logger

logger = setup_logger()

class StatsService:
    """Stats analysis service"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def get_dashboard_stats(self, tenant_id: str = None) -> Dict[str, Any]:
        """Get dashboard stats data

        Note: Parameter name remains tenant_id for backward compatibility, but tenant_id is actually processed
        """
        try:
            # Build base query, support tenant filter
            base_query = self.db.query(DetectionResult)
            if tenant_id is not None:
                # Convert incoming tenant_id (actually tenant_id) to UUID for comparison
                try:
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    base_query = base_query.filter(DetectionResult.tenant_id == tenant_uuid)
                except ValueError:
                    # Invalid tenant_id, return empty stats
                    return self._get_empty_stats()
            
            # Total requests
            total_requests = base_query.count()
            
            # Security risks (security_risk_level non-no_risk)
            security_risks = base_query.filter(
                DetectionResult.security_risk_level != "no_risk"
            ).count()

            # Compliance risks (compliance_risk_level non-no_risk)
            compliance_risks = base_query.filter(
                DetectionResult.compliance_risk_level != "no_risk"
            ).count()

            # Data leak risks (data_risk_level non-no_risk)
            data_leaks = base_query.filter(
                DetectionResult.data_risk_level != "no_risk"
            ).count()

            # Comprehensive statistics for each risk level (take highest risk level)
            results_query = self.db.query(
                DetectionResult.security_risk_level,
                DetectionResult.compliance_risk_level,
                DetectionResult.data_risk_level
            )
            if tenant_id is not None:
                try:
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    results_query = results_query.filter(DetectionResult.tenant_id == tenant_uuid)
                except ValueError:
                    return self._get_empty_stats()
            results = results_query.all()
            
            high_risk_count = 0
            medium_risk_count = 0
            low_risk_count = 0
            safe_count = 0

            for sec_risk, comp_risk, data_risk in results:
                # Take highest value from three risk levels
                overall_risk = self._get_highest_risk_level(sec_risk, comp_risk, data_risk)

                if overall_risk == "high_risk":
                    high_risk_count += 1
                elif overall_risk == "medium_risk":
                    medium_risk_count += 1
                elif overall_risk == "low_risk":
                    low_risk_count += 1
                else:
                    safe_count += 1
            
            # Risk distribution
            risk_distribution = {
                "high_risk": high_risk_count,
                "medium_risk": medium_risk_count,
                "low_risk": low_risk_count,
                "no_risk": safe_count
            }
            
            # Recent 7 days trends
            daily_trends = self._get_daily_trends(7, tenant_id)
            
            return {
                "total_requests": total_requests,
                "security_risks": security_risks,
                "compliance_risks": compliance_risks,
                "data_leaks": data_leaks,
                "high_risk_count": high_risk_count,
                "medium_risk_count": medium_risk_count,
                "low_risk_count": low_risk_count,
                "safe_count": safe_count,
                "risk_distribution": risk_distribution,
                "daily_trends": daily_trends
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
    
    def _get_daily_trends(self, days: int, tenant_id: str = None) -> List[Dict[str, Any]]:
        """Get daily trends data

        Note: Parameter name remains tenant_id for backward compatibility, but tenant_id is actually processed
        """
        try:
            end_date = datetime.now().date()
            start_date = end_date - timedelta(days=days-1)

            # Get records within specified date range, support tenant filter
            query = self.db.query(
                func.date(DetectionResult.created_at).label('date'),
                DetectionResult.security_risk_level,
                DetectionResult.compliance_risk_level,
                DetectionResult.data_risk_level
            ).filter(
                func.date(DetectionResult.created_at) >= start_date
            )

            # If tenant ID is provided, perform tenant filter
            if tenant_id is not None:
                try:
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    query = query.filter(DetectionResult.tenant_id == tenant_uuid)
                except ValueError:
                    # Invalid tenant_id, return empty data
                    return []
            
            daily_records = query.all()
            
            # Group by date and count risk levels
            daily_data = {}
            for record in daily_records:
                date_str = str(record.date)
                if date_str not in daily_data:
                    daily_data[date_str] = {
                        'total': 0,
                        'high_risk': 0,
                        'medium_risk': 0,
                        'low_risk': 0,
                        'safe': 0
                    }
                
                # Take highest risk level
                overall_risk = self._get_highest_risk_level(record.security_risk_level, record.compliance_risk_level, record.data_risk_level)
                daily_data[date_str]['total'] += 1
                
                if overall_risk == 'high_risk':
                    daily_data[date_str]['high_risk'] += 1
                elif overall_risk == 'medium_risk':
                    daily_data[date_str]['medium_risk'] += 1
                elif overall_risk == 'low_risk':
                    daily_data[date_str]['low_risk'] += 1
                else:
                    daily_data[date_str]['safe'] += 1
            
            # Create complete date range
            trends = []
            for i in range(days):
                current_date = start_date + timedelta(days=i)
                date_str = str(current_date)
                
                if date_str in daily_data:
                    trends.append({
                        "date": current_date.isoformat(),
                        "total": daily_data[date_str]['total'],
                        "high_risk": daily_data[date_str]['high_risk'],
                        "medium_risk": daily_data[date_str]['medium_risk'],
                        "low_risk": daily_data[date_str]['low_risk'],
                        "safe": daily_data[date_str]['safe']
                    })
                else:
                    trends.append({
                        "date": current_date.isoformat(),
                        "total": 0,
                        "high_risk": 0,
                        "medium_risk": 0,
                        "low_risk": 0,
                        "safe": 0
                    })
            
            return trends
            
        except Exception as e:
            logger.error(f"Get daily trends error: {e}")
            return []
    
    def get_category_distribution(self, start_date: str = None, end_date: str = None, tenant_id: str = None) -> List[Dict[str, Any]]:
        """Get risk category distribution statistics

        Note: Parameter name remains tenant_id for backward compatibility, but tenant_id is actually processed
        """
        try:
            # Build query conditions - query records with security or compliance risks
            query = self.db.query(DetectionResult).filter(
                (DetectionResult.security_risk_level != "no_risk") |
                (DetectionResult.compliance_risk_level != "no_risk")
            )

            if tenant_id is not None:
                try:
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    query = query.filter(DetectionResult.tenant_id == tenant_uuid)
                except ValueError:
                    return []
            if start_date:
                query = query.filter(func.date(DetectionResult.created_at) >= start_date)
            if end_date:
                query = query.filter(func.date(DetectionResult.created_at) <= end_date)
            
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