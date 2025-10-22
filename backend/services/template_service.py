"""
Answer template service
Use to manage answer templates for tenants, including creating default templates for new tenants
"""
from sqlalchemy.orm import Session
from database.models import ResponseTemplate
import uuid
from typing import Optional


def create_user_default_templates(db: Session, tenant_id: uuid.UUID) -> int:
    """
    Create user-level templates for new tenants from system templates

    Note: For backward compatibility, function name remains create_user_default_templates, parameter name remains tenant_id, but tenant_id is actually processed

    Args:
        db: Database session
        tenant_id: Tenant ID (actually tenant_id, parameter name for backward compatibility)
    Returns:
        Number of created templates
    """
    tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
    try:
        # Check if tenant already has templates
        existing_count = db.query(ResponseTemplate).filter_by(tenant_id=tenant_id).count()
        if existing_count > 0:
            return existing_count

        # Get all system-level templates (tenant_id is None)
        system_templates = db.query(ResponseTemplate).filter(
            ResponseTemplate.tenant_id.is_(None),
            ResponseTemplate.is_default == True
        ).all()

        created_count = 0
        for template in system_templates:
            # Create corresponding template for tenant
            tenant_template = ResponseTemplate(
                tenant_id=tenant_id,
                category=template.category,
                risk_level=template.risk_level,
                template_content=template.template_content,
                is_default=template.is_default,
                is_active=template.is_active
            )
            db.add(tenant_template)
            created_count += 1

        db.commit()
        return created_count

    except Exception as e:
        db.rollback()
        raise e


def get_user_template(db: Session, tenant_id: uuid.UUID, category: str, risk_level: str) -> Optional[ResponseTemplate]:
    """
    Get tenant-specific answer templates
    If tenant has no corresponding template, return system default template

    Note: For backward compatibility, function name remains get_user_template, parameter name remains tenant_id, but tenant_id is actually processed
    """
    tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
    # First find tenant templates
    tenant_template = db.query(ResponseTemplate).filter(
        ResponseTemplate.tenant_id == tenant_id,
        ResponseTemplate.category == category,
        ResponseTemplate.risk_level == risk_level,
        ResponseTemplate.is_active == True
    ).first()

    if tenant_template:
        return tenant_template

    # If tenant has no templates, find system default template
    system_template = db.query(ResponseTemplate).filter(
        ResponseTemplate.tenant_id.is_(None),
        ResponseTemplate.category == category,
        ResponseTemplate.risk_level == risk_level,
        ResponseTemplate.is_active == True
    ).first()

    return system_template


def get_default_template(db: Session, tenant_id: Optional[uuid.UUID] = None) -> Optional[ResponseTemplate]:
    """
    Get default template (when no specific category template is found)

    Note: For backward compatibility, parameter name remains tenant_id, but tenant_id is actually processed
    """
    tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
    if tenant_id:
        # First find tenant default template
        tenant_default = db.query(ResponseTemplate).filter(
            ResponseTemplate.tenant_id == tenant_id,
            ResponseTemplate.category == "default",
            ResponseTemplate.is_active == True
        ).first()

        if tenant_default:
            return tenant_default

    # Find system default template
    system_default = db.query(ResponseTemplate).filter(
        ResponseTemplate.tenant_id.is_(None),
        ResponseTemplate.category == "default",
        ResponseTemplate.is_active == True
    ).first()

    return system_default