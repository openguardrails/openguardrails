from typing import List, Optional
import json
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
from database.connection import get_db
from database.models import DetectionResult
from models.responses import DetectionResultResponse, PaginatedResponse
from utils.logger import setup_logger
from utils.url_signature import generate_signed_media_url
from config import settings

logger = setup_logger()
router = APIRouter(tags=["Results"])

@router.get("/results")
async def get_detection_results(
    request: Request,
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1, description="页码"),
    per_page: int = Query(20, ge=1, le=100, description="每页数量"),
    risk_level: Optional[str] = Query(None, description="整体风险等级过滤"),
    security_risk_level: Optional[str] = Query(None, description="提示词攻击风险等级过滤"),
    compliance_risk_level: Optional[str] = Query(None, description="内容合规风险等级过滤"),
    category: Optional[str] = Query(None, description="风险类别过滤"),
    start_date: Optional[str] = Query(None, description="开始日期"),
    end_date: Optional[str] = Query(None, description="结束日期"),
    content_search: Optional[str] = Query(None, description="检测内容搜索"),
    request_id_search: Optional[str] = Query(None, description="请求ID搜索")
):
    """Get detection results"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context and auth_context.get('data'):
            tenant_id = auth_context['data'].get('tenant_id')
        
        # Build query conditions
        filters = []
        
        # Add user filter conditions
        if tenant_id is not None:
            try:
                import uuid
                tenant_uuid = uuid.UUID(str(tenant_id))
                filters.append(DetectionResult.tenant_id == tenant_uuid)
            except ValueError:
                # If tenant_id format is invalid, return empty result
                raise HTTPException(status_code=400, detail="Invalid user ID format")
        
        # Risk level filter - support overall risk level or specific type risk level
        if risk_level:
            # Overall risk level filter: find records that match any type
            filters.append(or_(
                DetectionResult.security_risk_level == risk_level,
                DetectionResult.compliance_risk_level == risk_level
            ))
        
        if security_risk_level:
            filters.append(DetectionResult.security_risk_level == security_risk_level)
        
        if compliance_risk_level:
            filters.append(DetectionResult.compliance_risk_level == compliance_risk_level)
        
        # Category filter - find in security_categories, compliance_categories, or data_categories
        if category:
            # Use PostgreSQL JSONB contains operator (@>) for search
            # Cast JSON to JSONB and check if it contains the category
            filters.append(or_(
                cast(DetectionResult.security_categories, JSONB).contains([category]),
                cast(DetectionResult.compliance_categories, JSONB).contains([category]),
                cast(DetectionResult.data_categories, JSONB).contains([category])
            ))
        
        if start_date:
            filters.append(DetectionResult.created_at >= start_date + ' 00:00:00')
        
        if end_date:
            filters.append(DetectionResult.created_at <= end_date + ' 23:59:59')
        
        if content_search:
            filters.append(DetectionResult.content.like(f'%{content_search}%'))
        
        if request_id_search:
            filters.append(DetectionResult.request_id.like(f'%{request_id_search}%'))
        
        # Build base query
        base_query = db.query(DetectionResult)
        if filters:
            base_query = base_query.filter(and_(*filters))
        else:
            # If no filter conditions, also must limit user
            if tenant_id is not None:
                try:
                    import uuid
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    base_query = base_query.filter(DetectionResult.tenant_id == tenant_uuid)
                except ValueError:
                    # If tenant_id format is invalid, return empty result
                    raise HTTPException(status_code=400, detail="Invalid user ID format")
        
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
                has_image=result.has_image if hasattr(result, 'has_image') else False,
                image_count=result.image_count if hasattr(result, 'image_count') else 0,
                image_paths=result.image_paths if hasattr(result, 'image_paths') else [],
                image_urls=image_urls  # New signed URLs
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

@router.get("/results/{result_id}", response_model=DetectionResultResponse)
async def get_detection_result(result_id: int, request: Request, db: Session = Depends(get_db)):
    """Get single detection result detail (ensure current user can only view their own results)"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context and auth_context.get('data'):
            tenant_id = auth_context['data'].get('tenant_id')
        
        result = db.query(DetectionResult).filter_by(id=result_id).first()
        if not result:
            raise HTTPException(status_code=404, detail="Detection result not found")
        
        # Permission check: can only view own records
        if tenant_id is not None:
            # Convert string type tenant_id to UUID for comparison
            try:
                import uuid
                tenant_uuid = uuid.UUID(str(tenant_id))
                if result.tenant_id != tenant_uuid:
                    raise HTTPException(status_code=403, detail="Forbidden")
            except ValueError:
                raise HTTPException(status_code=403, detail="Invalid user ID format")
        
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
            has_image=result.has_image if hasattr(result, 'has_image') else False,
            image_count=result.image_count if hasattr(result, 'image_count') else 0,
            image_paths=result.image_paths if hasattr(result, 'image_paths') else [],
            image_urls=image_urls  # New signed URLs
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get detection result error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get detection result")

@router.get("/results/export")
async def export_detection_results(
    request: Request,
    db: Session = Depends(get_db),
    risk_level: Optional[str] = Query(None, description="整体风险等级过滤"),
    security_risk_level: Optional[str] = Query(None, description="提示词攻击风险等级过滤"),
    compliance_risk_level: Optional[str] = Query(None, description="内容合规风险等级过滤"),
    category: Optional[str] = Query(None, description="风险类别过滤"),
    start_date: Optional[str] = Query(None, description="开始日期"),
    end_date: Optional[str] = Query(None, description="结束日期"),
    content_search: Optional[str] = Query(None, description="检测内容搜索"),
    request_id_search: Optional[str] = Query(None, description="请求ID搜索")
):
    """Export detection results to Excel"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context and auth_context.get('data'):
            tenant_id = auth_context['data'].get('tenant_id')

        # Build query conditions (same as get_detection_results)
        filters = []

        if tenant_id is not None:
            try:
                import uuid
                tenant_uuid = uuid.UUID(str(tenant_id))
                filters.append(DetectionResult.tenant_id == tenant_uuid)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid user ID format")

        if risk_level:
            filters.append(or_(
                DetectionResult.security_risk_level == risk_level,
                DetectionResult.compliance_risk_level == risk_level
            ))

        if security_risk_level:
            filters.append(DetectionResult.security_risk_level == security_risk_level)

        if compliance_risk_level:
            filters.append(DetectionResult.compliance_risk_level == compliance_risk_level)

        if category:
            filters.append(or_(
                cast(DetectionResult.security_categories, JSONB).contains([category]),
                cast(DetectionResult.compliance_categories, JSONB).contains([category]),
                cast(DetectionResult.data_categories, JSONB).contains([category])
            ))

        if start_date:
            filters.append(DetectionResult.created_at >= start_date + ' 00:00:00')

        if end_date:
            filters.append(DetectionResult.created_at <= end_date + ' 23:59:59')

        if content_search:
            filters.append(DetectionResult.content.like(f'%{content_search}%'))

        if request_id_search:
            filters.append(DetectionResult.request_id.like(f'%{request_id_search}%'))

        # Build query
        base_query = db.query(DetectionResult)
        if filters:
            base_query = base_query.filter(and_(*filters))
        else:
            if tenant_id is not None:
                try:
                    import uuid
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    base_query = base_query.filter(DetectionResult.tenant_id == tenant_uuid)
                except ValueError:
                    raise HTTPException(status_code=400, detail="Invalid user ID format")

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