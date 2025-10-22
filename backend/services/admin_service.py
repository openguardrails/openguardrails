import secrets
import hashlib
import uuid
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Union
from sqlalchemy.orm import Session
from sqlalchemy import func
from passlib.context import CryptContext

from database.models import Tenant, TenantSwitch, DetectionResult
from utils.user import generate_api_key
from config import settings
from utils.logger import setup_logger

logger = setup_logger()

class AdminService:
    """Super Admin Service"""
    
    def __init__(self):
        self.pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
    
    def create_super_admin_if_not_exists(self, db: Session) -> Tenant:
        """Create super admin tenant (if not exists).
        If it already exists, ensure its password matches the configuration in .env, and the account is active and verified.
        """
        try:
            # Check if super admin already exists
            existing_admin = db.query(Tenant).filter(
                Tenant.email == settings.super_admin_username,
                Tenant.is_super_admin == True
            ).first()
            
            if existing_admin:
                # Ensure status is active and verified
                desired_hash = self.pwd_context.hash(settings.super_admin_password)
                # Only update if password mismatch to avoid duplicate hash
                try:
                    password_mismatch = not self.pwd_context.verify(settings.super_admin_password, existing_admin.password_hash)
                except Exception:
                    password_mismatch = True

                updated = False
                if password_mismatch:
                    existing_admin.password_hash = desired_hash
                    updated = True
                if not existing_admin.is_active:
                    existing_admin.is_active = True
                    updated = True
                if not existing_admin.is_verified:
                    existing_admin.is_verified = True
                    updated = True
                if not existing_admin.is_super_admin:
                    existing_admin.is_super_admin = True
                    updated = True

                if updated:
                    db.commit()
                    db.refresh(existing_admin)
                    logger.info("Super admin ensured active/verified and password synced to .env")
                
                # Check and create default template for super admin (if not exists)
                try:
                    from services.template_service import create_user_default_templates
                    template_count = create_user_default_templates(db, existing_admin.id)
                    if template_count > 0:
                        logger.info(f"Created {template_count} default templates for existing super admin {existing_admin.email}")
                except Exception as e:
                    logger.error(f"Failed to create default templates for existing super admin {existing_admin.email}: {e}")
                    # Not affect super admin running, just record error
                
                if not updated:
                    logger.info("Super admin already exists and up to date")
                return existing_admin
            
            # Generate API key
            api_key = self._generate_api_key()

            # Create super admin tenant
            super_admin = Tenant(
                email=settings.super_admin_username,
                password_hash=self.pwd_context.hash(settings.super_admin_password),
                is_active=True,
                is_verified=True,
                is_super_admin=True,
                api_key=api_key
            )
            
            db.add(super_admin)
            db.commit()
            db.refresh(super_admin)
            
            # Create default template for super admin
            try:
                from services.template_service import create_user_default_templates
                template_count = create_user_default_templates(db, super_admin.id)
                logger.info(f"Created {template_count} default templates for super admin {super_admin.email}")
            except Exception as e:
                logger.error(f"Failed to create default templates for super admin {super_admin.email}: {e}")
                # Not affect super admin creation process, just record error
            
            logger.info(f"Super admin created: {super_admin.email} (API Key: {api_key})")
            return super_admin
            
        except Exception as e:
            logger.error(f"Error creating super admin: {e}")
            db.rollback()
            raise
    
    def _generate_api_key(self) -> str:
        """Generate unique API key (prefix: sk-xxai-)"""
        return generate_api_key()
    
    def is_super_admin(self, tenant: Tenant) -> bool:
        """Check if tenant is super admin (based on .env configured email)"""
        if not tenant:
            return False
        return tenant.email == settings.super_admin_username
    
    def get_all_users(self, db: Session, admin_tenant: Tenant) -> List[Dict[str, Any]]:
        """Get all tenants list (only super admin can access)"""
        if not self.is_super_admin(admin_tenant):
            raise PermissionError("Only super admin can access all tenants")

        # Get tenants and detection counts
        tenants_with_counts = db.query(
            Tenant,
            func.count(DetectionResult.id).label('detection_count')
        ).outerjoin(DetectionResult, Tenant.id == DetectionResult.tenant_id).group_by(Tenant.id).all()

        return [{
            "id": str(tenant.id),
            "email": tenant.email,
            "is_active": tenant.is_active,
            # Only recognize super admin account in .env
            "is_super_admin": self.is_super_admin(tenant),
            "is_verified": tenant.is_verified,
            "api_key": tenant.api_key,
            "detection_count": detection_count,  # New detection count
            "created_at": tenant.created_at.isoformat() if tenant.created_at else None,
            "updated_at": tenant.updated_at.isoformat() if tenant.updated_at else None
        } for tenant, detection_count in tenants_with_counts]
    
    def switch_to_user(self, db: Session, admin_tenant: Tenant, target_tenant_id: Union[str, uuid.UUID]) -> str:
        """Super admin switch to specified tenant view"""
        if not self.is_super_admin(admin_tenant):
            raise PermissionError("Only super admin can switch tenant view")

        # Ensure target_tenant_id is UUID object
        if isinstance(target_tenant_id, str):
            try:
                target_tenant_id = uuid.UUID(target_tenant_id)
            except ValueError:
                raise ValueError("Invalid tenant ID format")

        # Check if target tenant exists
        target_tenant = db.query(Tenant).filter(
            Tenant.id == target_tenant_id,
            Tenant.is_active == True
        ).first()

        if not target_tenant:
            raise ValueError("Target tenant not found or inactive")

        # Generate switch session token
        session_token = secrets.token_urlsafe(64)
        expires_at = datetime.now() + timedelta(hours=2)  # 2 hours expire

        # Clear old switch records
        db.query(TenantSwitch).filter(
            TenantSwitch.admin_tenant_id == admin_tenant.id,
            TenantSwitch.is_active == True
        ).update({"is_active": False})

        # Create new switch record
        user_switch = TenantSwitch(
            admin_tenant_id=admin_tenant.id,
            target_tenant_id=target_tenant_id,
            session_token=session_token,
            expires_at=expires_at
        )

        db.add(user_switch)
        db.commit()

        logger.info(f"Super admin {admin_tenant.email} switched to tenant {target_tenant.email}")

        return session_token
    
    def get_switched_user(self, db: Session, session_token: str) -> Optional[Tenant]:
        """Get current switched tenant based on switch session token"""
        user_switch = db.query(TenantSwitch).filter(
            TenantSwitch.session_token == session_token,
            TenantSwitch.is_active == True,
            TenantSwitch.expires_at > datetime.now()
        ).first()

        if not user_switch:
            return None

        return db.query(Tenant).filter(Tenant.id == user_switch.target_tenant_id).first()
    
    def exit_user_switch(self, db: Session, session_token: str) -> bool:
        """Exit user switch, back to admin view"""
        result = db.query(TenantSwitch).filter(
            TenantSwitch.session_token == session_token,
            TenantSwitch.is_active == True
        ).update({"is_active": False})
        
        db.commit()
        
        return result > 0
    
    def get_current_admin_from_switch(self, db: Session, session_token: str) -> Optional[Tenant]:
        """Get original admin tenant from switch session"""
        user_switch = db.query(TenantSwitch).filter(
            TenantSwitch.session_token == session_token,
            TenantSwitch.is_active == True
        ).first()

        if not user_switch:
            return None

        return db.query(Tenant).filter(Tenant.id == user_switch.admin_tenant_id).first()

# Global instance
admin_service = AdminService()