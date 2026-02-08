from typing import List, Optional, Tuple
import json
import uuid
from pathlib import Path
from io import BytesIO
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_, text, cast
from sqlalchemy.dialects.postgresql import JSONB
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill
from database.connection import get_admin_db
from database.models import DetectionResult, Tenant, Application
from models.responses import DetectionResultResponse, PaginatedResponse
from utils.logger import setup_logger
from utils.url_signature import generate_signed_media_url
from config import settings

logger = setup_logger()
router = APIRouter(tags=["Results"])

def get_current_user_and_application_from_request(request: Request, db: Session) -> Tuple[Tenant, uuid.UUID]:
    """
    Get current tenant and application_id from request
    Returns: (Tenant, application_id)
    """
    # First, always get auth context to verify user
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']

    # Get current user's tenant_id
    tenant_id = data.get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

    try:
        tenant_uuid = uuid.UUID(str(tenant_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid tenant ID format")

    tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # 0) Check for X-Application-ID header (highest priority - from frontend selector)
    header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
    if header_app_id:
        try:
            header_app_uuid = uuid.UUID(str(header_app_id))
            app = db.query(Application).filter(
                Application.id == header_app_uuid,
                Application.tenant_id == tenant.id,  # Must belong to current user's tenant
                Application.is_active == True
            ).first()
            if app:
                return tenant, header_app_uuid
        except (ValueError, AttributeError):
            pass

    # 1) Check application_id in auth token (from API call with specific application)
    application_id_value = data.get('application_id')
    if application_id_value:
        try:
            application_uuid = uuid.UUID(str(application_id_value))
            # Verify application exists, is active, and belongs to current tenant
            app = db.query(Application).filter(
                Application.id == application_uuid,
                Application.tenant_id == tenant.id,
                Application.is_active == True
            ).first()
            if app:
                return tenant, application_uuid
        except (ValueError, AttributeError):
            pass

    # 2) Fallback: get default application for this tenant (ordered by creation time)
    default_app = db.query(Application).filter(
        Application.tenant_id == tenant.id,
        Application.is_active == True
    ).order_by(Application.created_at.asc()).first()

    if not default_app:
        raise HTTPException(status_code=404, detail="No active application found for user")

    return tenant, default_app.id

@router.get("/results")
async def get_detection_results(
    request: Request,
    db: Session = Depends(get_admin_db),
    page: int = Query(1, ge=1, description="页码"),
    per_page: int = Query(20, ge=1, le=100, description="每页数量"),
    risk_level: Optional[str] = Query(None, description="整体风险等级过滤"),
    security_risk_level: Optional[str] = Query(None, description="提示词攻击风险等级过滤"),
    compliance_risk_level: Optional[str] = Query(None, description="内容合规风险等级过滤"),
    data_risk_level: Optional[str] = Query(None, description="数据泄漏风险等级过滤"),
    category: Optional[str] = Query(None, description="风险类别过滤"),
    data_entity_type: Optional[str] = Query(None, description="数据泄漏实体类型过滤"),
    start_date: Optional[str] = Query(None, description="开始日期"),
    end_date: Optional[str] = Query(None, description="结束日期"),
    content_search: Optional[str] = Query(None, description="检测内容搜索"),
    request_id_search: Optional[str] = Query(None, description="请求ID搜索")
):
    """Get detection results"""
    try:
        # Get user and application context
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Build query conditions
        filters = []

        # Add application filter condition
        # Include:
        # 1. Records from current application (application_id == application_id)
        # 2. DMA records from current tenant (application_id is None AND is_direct_model_access = True AND tenant_id = current_user.id)
        filters.append(or_(
            DetectionResult.application_id == application_id,
            and_(
                DetectionResult.application_id.is_(None),
                DetectionResult.is_direct_model_access == True,
                DetectionResult.tenant_id == str(current_user.id)
            )
        ))
        
        # Risk level filter - support overall risk level or specific type risk level
        if risk_level:
            if risk_level == "no_risk":
                # For no_risk: all three risk types must be no_risk
                filters.append(and_(
                    DetectionResult.security_risk_level == "no_risk",
                    DetectionResult.compliance_risk_level == "no_risk",
                    DetectionResult.data_risk_level == "no_risk"
                ))
            elif risk_level == "any_risk":
                # For any_risk: at least one risk type is not no_risk
                filters.append(or_(
                    DetectionResult.security_risk_level != "no_risk",
                    DetectionResult.compliance_risk_level != "no_risk",
                    DetectionResult.data_risk_level != "no_risk"
                ))
            else:
                # For other risk levels: find records that match any type
                filters.append(or_(
                    DetectionResult.security_risk_level == risk_level,
                    DetectionResult.compliance_risk_level == risk_level,
                    DetectionResult.data_risk_level == risk_level
                ))

        if security_risk_level:
            if security_risk_level == "any_risk":
                # Filter for any security risk (not no_risk)
                filters.append(DetectionResult.security_risk_level != "no_risk")
            else:
                filters.append(DetectionResult.security_risk_level == security_risk_level)

        if compliance_risk_level:
            if compliance_risk_level == "any_risk":
                # Filter for any compliance risk (not no_risk)
                filters.append(DetectionResult.compliance_risk_level != "no_risk")
            else:
                filters.append(DetectionResult.compliance_risk_level == compliance_risk_level)

        if data_risk_level:
            if data_risk_level == "any_risk":
                # Filter for any data leak risk (not no_risk)
                filters.append(DetectionResult.data_risk_level != "no_risk")
            else:
                filters.append(DetectionResult.data_risk_level == data_risk_level)
        
        # Category filter - find in security_categories, compliance_categories, or data_categories
        if category:
            # Use PostgreSQL JSONB contains operator (@>) for search
            # Cast JSON to JSONB and check if it contains the category
            filters.append(or_(
                cast(DetectionResult.security_categories, JSONB).contains([category]),
                cast(DetectionResult.compliance_categories, JSONB).contains([category]),
                cast(DetectionResult.data_categories, JSONB).contains([category])
            ))

        # Data entity type filter - find in data_categories
        if data_entity_type:
            filters.append(cast(DetectionResult.data_categories, JSONB).contains([data_entity_type]))
        
        if start_date:
            filters.append(DetectionResult.created_at >= start_date + ' 00:00:00')
        
        if end_date:
            filters.append(DetectionResult.created_at <= end_date + ' 23:59:59')
        
        if content_search:
            filters.append(DetectionResult.content.like(f'%{content_search}%'))
        
        if request_id_search:
            filters.append(DetectionResult.request_id.like(f'%{request_id_search}%'))
        
        # Build base query
        base_query = db.query(DetectionResult).filter(and_(*filters))
        
        # Get total
        total = base_query.count()
        
        # Paginated query
        offset = (page - 1) * per_page
        results = base_query.order_by(
            DetectionResult.created_at.desc()
        ).offset(offset).limit(per_page).all()
        
        # Convert to response model
        items = []
        for result in results:
            # Generate signed image URLs
            image_urls = []
            if hasattr(result, 'image_paths') and result.image_paths:
                for image_path in result.image_paths:
                    try:
                        # Extract tenant_id and filename from path
                        # Path format: /mnt/data/openguardrails-data/media/{tenant_id}/{filename}
                        path_parts = Path(image_path).parts
                        filename = path_parts[-1]
                        extracted_tenant_id = path_parts[-2]

                        # Generate signed URL
                        signed_url = generate_signed_media_url(
                            tenant_id=extracted_tenant_id,
                            filename=filename,
                            expires_in_seconds=86400  # 24 hours valid
                        )
                        image_urls.append(signed_url)
                    except Exception as e:
                        logger.error(f"Failed to generate signed URL for {image_path}: {e}")

            items.append(DetectionResultResponse(
                id=result.id,
                request_id=result.request_id,
                content=result.content[:200] + "..." if len(result.content) > 200 else result.content,
                suggest_action=result.suggest_action,
                suggest_answer=result.suggest_answer,
                hit_keywords=result.hit_keywords,
                created_at=result.created_at,
                ip_address=result.ip_address,
                security_risk_level=result.security_risk_level,
                security_categories=result.security_categories,
                compliance_risk_level=result.compliance_risk_level,
                compliance_categories=result.compliance_categories,
                data_risk_level=result.data_risk_level if hasattr(result, 'data_risk_level') else "no_risk",
                data_categories=result.data_categories if hasattr(result, 'data_categories') else [],
                has_image=result.has_image if hasattr(result, 'has_image') else False,
                image_count=result.image_count if hasattr(result, 'image_count') else 0,
                image_paths=result.image_paths if hasattr(result, 'image_paths') else [],
                image_urls=image_urls,  # New signed URLs
                is_direct_model_access=result.is_direct_model_access if hasattr(result, 'is_direct_model_access') else False
            ))
        
        pages = (total + per_page - 1) // per_page
        
        return PaginatedResponse(
            items=items,
            total=total,
            page=page,
            per_page=per_page,
            pages=pages
        )
        
    except Exception as e:
        logger.error(f"Get detection results error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get detection results")

@router.get("/results/export")
async def export_detection_results(
    request: Request,
    db: Session = Depends(get_admin_db),
    risk_level: Optional[str] = Query(None, description="整体风险等级过滤"),
    security_risk_level: Optional[str] = Query(None, description="提示词攻击风险等级过滤"),
    compliance_risk_level: Optional[str] = Query(None, description="内容合规风险等级过滤"),
    data_risk_level: Optional[str] = Query(None, description="数据泄漏风险等级过滤"),
    category: Optional[str] = Query(None, description="风险类别过滤"),
    data_entity_type: Optional[str] = Query(None, description="数据泄漏实体类型过滤"),
    start_date: Optional[str] = Query(None, description="开始日期"),
    end_date: Optional[str] = Query(None, description="结束日期"),
    content_search: Optional[str] = Query(None, description="检测内容搜索"),
    request_id_search: Optional[str] = Query(None, description="请求ID搜索")
):
    """Export detection results to Excel"""
    try:
        # Get user and application context
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Build query conditions (same as get_detection_results)
        filters = []

        # Add application filter condition
        # Include:
        # 1. Records from current application (application_id == application_id)
        # 2. DMA records from current tenant (application_id is None AND is_direct_model_access = True AND tenant_id = current_user.id)
        filters.append(or_(
            DetectionResult.application_id == application_id,
            and_(
                DetectionResult.application_id.is_(None),
                DetectionResult.is_direct_model_access == True,
                DetectionResult.tenant_id == str(current_user.id)
            )
        ))

        if risk_level:
            if risk_level == "no_risk":
                # For no_risk: all three risk types must be no_risk
                filters.append(and_(
                    DetectionResult.security_risk_level == "no_risk",
                    DetectionResult.compliance_risk_level == "no_risk",
                    DetectionResult.data_risk_level == "no_risk"
                ))
            elif risk_level == "any_risk":
                # For any_risk: at least one risk type is not no_risk
                filters.append(or_(
                    DetectionResult.security_risk_level != "no_risk",
                    DetectionResult.compliance_risk_level != "no_risk",
                    DetectionResult.data_risk_level != "no_risk"
                ))
            else:
                # For other risk levels: find records that match any type
                filters.append(or_(
                    DetectionResult.security_risk_level == risk_level,
                    DetectionResult.compliance_risk_level == risk_level,
                    DetectionResult.data_risk_level == risk_level
                ))

        if security_risk_level:
            if security_risk_level == "any_risk":
                # Filter for any security risk (not no_risk)
                filters.append(DetectionResult.security_risk_level != "no_risk")
            else:
                filters.append(DetectionResult.security_risk_level == security_risk_level)

        if compliance_risk_level:
            if compliance_risk_level == "any_risk":
                # Filter for any compliance risk (not no_risk)
                filters.append(DetectionResult.compliance_risk_level != "no_risk")
            else:
                filters.append(DetectionResult.compliance_risk_level == compliance_risk_level)

        if data_risk_level:
            if data_risk_level == "any_risk":
                # Filter for any data leak risk (not no_risk)
                filters.append(DetectionResult.data_risk_level != "no_risk")
            else:
                filters.append(DetectionResult.data_risk_level == data_risk_level)

        if category:
            filters.append(or_(
                cast(DetectionResult.security_categories, JSONB).contains([category]),
                cast(DetectionResult.compliance_categories, JSONB).contains([category]),
                cast(DetectionResult.data_categories, JSONB).contains([category])
            ))

        # Data entity type filter - find in data_categories
        if data_entity_type:
            filters.append(cast(DetectionResult.data_categories, JSONB).contains([data_entity_type]))

        if start_date:
            filters.append(DetectionResult.created_at >= start_date + ' 00:00:00')

        if end_date:
            filters.append(DetectionResult.created_at <= end_date + ' 23:59:59')

        if content_search:
            filters.append(DetectionResult.content.like(f'%{content_search}%'))

        if request_id_search:
            filters.append(DetectionResult.request_id.like(f'%{request_id_search}%'))

        # Build query
        base_query = db.query(DetectionResult).filter(and_(*filters))

        # Get all results (limit to 10000 for safety)
        results = base_query.order_by(
            DetectionResult.created_at.desc()
        ).limit(10000).all()

        # Create Excel workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Detection Results"

        # Define headers
        headers = [
            "Request ID",
            "Detection Content",
            "Prompt Attack Risk",
            "Prompt Attack Categories",
            "Content Compliance Risk",
            "Content Compliance Categories",
            "Data Leak Risk",
            "Data Leak Categories",
            "Suggested Action",
            "Suggested Answer",
            "Hit Keywords",
            "Has Image",
            "Image Count",
            "IP Address",
            "Detection Time"
        ]

        # Write headers with styling
        header_fill = PatternFill(start_color="366092", end_color="366092", fill_type="solid")
        header_font = Font(color="FFFFFF", bold=True)

        for col_num, header in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col_num, value=header)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center", vertical="center")

        # Write data
        for row_num, result in enumerate(results, 2):
            ws.cell(row=row_num, column=1, value=result.request_id)
            ws.cell(row=row_num, column=2, value=result.content)
            ws.cell(row=row_num, column=3, value=result.security_risk_level or "no_risk")
            ws.cell(row=row_num, column=4, value=", ".join(result.security_categories or []))
            ws.cell(row=row_num, column=5, value=result.compliance_risk_level or "no_risk")
            ws.cell(row=row_num, column=6, value=", ".join(result.compliance_categories or []))
            ws.cell(row=row_num, column=7, value=result.data_risk_level or "no_risk")
            ws.cell(row=row_num, column=8, value=", ".join(result.data_categories or []))
            ws.cell(row=row_num, column=9, value=result.suggest_action)
            ws.cell(row=row_num, column=10, value=result.suggest_answer or "")
            ws.cell(row=row_num, column=11, value=", ".join(result.hit_keywords or []))
            ws.cell(row=row_num, column=12, value="Yes" if (hasattr(result, 'has_image') and result.has_image) else "No")
            ws.cell(row=row_num, column=13, value=result.image_count if hasattr(result, 'image_count') else 0)
            ws.cell(row=row_num, column=14, value=result.ip_address or "")
            ws.cell(row=row_num, column=15, value=result.created_at.strftime('%Y-%m-%d %H:%M:%S') if result.created_at else "")

        # Adjust column widths
        column_widths = [30, 50, 20, 30, 20, 30, 20, 30, 15, 50, 30, 12, 12, 15, 20]
        for col_num, width in enumerate(column_widths, 1):
            ws.column_dimensions[ws.cell(row=1, column=col_num).column_letter].width = width

        # Save to BytesIO
        excel_file = BytesIO()
        wb.save(excel_file)
        excel_file.seek(0)

        # Generate filename with timestamp
        filename = f"detection_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"

        # Return as streaming response
        return StreamingResponse(
            excel_file,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f"attachment; filename={filename}"
            }
        )

    except Exception as e:
        logger.error(f"Export detection results error: {e}")
        raise HTTPException(status_code=500, detail="Failed to export detection results")

@router.get("/results/{result_id}", response_model=DetectionResultResponse)
async def get_detection_result(result_id: int, request: Request, db: Session = Depends(get_admin_db)):
    """Get single detection result detail (ensure current application can only view their own results)"""
    try:
        # Get user and application context
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        result = db.query(DetectionResult).filter_by(id=result_id).first()
        if not result:
            raise HTTPException(status_code=404, detail="Detection result not found")

        # Permission check: can only view application's own records OR tenant's DMA records
        if result.application_id == application_id:
            # This is an application-level record, access granted
            pass
        elif result.application_id is None and result.is_direct_model_access and str(result.tenant_id) == str(current_user.id):
            # This is a DMA record from current tenant, access granted
            pass
        else:
            # Not authorized to view this record
            raise HTTPException(status_code=403, detail="Forbidden")

        # Generate signed image URLs
        image_urls = []
        if hasattr(result, 'image_paths') and result.image_paths:
            for image_path in result.image_paths:
                try:
                    # Extract tenant_id and filename from path
                    # Path format: /mnt/data/openguardrails-data/media/{tenant_id}/{filename}
                    path_parts = Path(image_path).parts
                    filename = path_parts[-1]
                    extracted_tenant_id = path_parts[-2]

                    # Generate signed URL
                    signed_url = generate_signed_media_url(
                        tenant_id=extracted_tenant_id,
                        filename=filename,
                        expires_in_seconds=86400  # 24 hours valid
                    )
                    image_urls.append(signed_url)
                except Exception as e:
                    logger.error(f"Failed to generate signed URL for {image_path}: {e}")

        return DetectionResultResponse(
            id=result.id,
            request_id=result.request_id,
            content=result.content,
            suggest_action=result.suggest_action,
            suggest_answer=result.suggest_answer,
            hit_keywords=result.hit_keywords,
            created_at=result.created_at,
            ip_address=result.ip_address,
            security_risk_level=result.security_risk_level,
            security_categories=result.security_categories,
            compliance_risk_level=result.compliance_risk_level,
            compliance_categories=result.compliance_categories,
            data_risk_level=result.data_risk_level if hasattr(result, 'data_risk_level') else "no_risk",
            data_categories=result.data_categories if hasattr(result, 'data_categories') else [],
            has_image=result.has_image if hasattr(result, 'has_image') else False,
            image_count=result.image_count if hasattr(result, 'image_count') else 0,
            image_paths=result.image_paths if hasattr(result, 'image_paths') else [],
            image_urls=image_urls,  # New signed URLs
            is_direct_model_access=result.is_direct_model_access if hasattr(result, 'is_direct_model_access') else False
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get detection result error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get detection result")