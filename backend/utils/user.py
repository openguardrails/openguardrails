import secrets
import string
import uuid
from typing import Optional, Union
from sqlalchemy.orm import Session
from database.models import Tenant, EmailVerification, Application, ApiKey
from utils.auth import get_password_hash
from utils.logger import setup_logger
from datetime import datetime

logger = setup_logger()

def generate_api_key() -> str:
    """Generate API key (starts with sk-xxai-, total length <= 64)"""
    # Uniform specification: starts with sk-xxai- as fixed prefix, database column length is 64
    # Therefore the prefix length is 8, the random part generates 56 bits of letters and numbers, ensuring the total length is 64
    prefix = 'sk-xxai-'
    alphabet = string.ascii_letters + string.digits
    random_part = ''.join(secrets.choice(alphabet) for _ in range(56))
    return prefix + random_part

def create_user(db: Session, email: str, password: str) -> Tenant:
    """Create new tenant"""
    # Validate password strength
    from utils.validators import validate_password_strength
    password_validation = validate_password_strength(password)

    if not password_validation["is_valid"]:
        error_messages = ", ".join(password_validation["errors"])
        raise ValueError(f"Password does not meet security requirements: {error_messages}")

    hashed_password = get_password_hash(password)
    api_key = generate_api_key()

    # Ensure API key is unique
    while db.query(Tenant).filter(Tenant.api_key == api_key).first():
        api_key = generate_api_key()

    tenant = Tenant(
        email=email,
        password_hash=hashed_password,
        api_key=api_key,
        is_active=False,  # Need email verification
        is_verified=False
    )

    db.add(tenant)
    db.commit()
    db.refresh(tenant)
    return tenant

def create_default_application_and_key(db: Session, tenant_id: Union[str, uuid.UUID], tenant_email: str) -> Optional[dict]:
    """
    Create global workspace, default application and API key for new user.

    The application API key is separate from the tenant API key:
    - Tenant API key: Used for auto-discovery mode (with X-OG-Application-ID header)
    - Application API key: Used for direct API calls to this specific application

    Returns:
        dict with keys: application_id, api_key
        None if creation failed
    """
    try:
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        # Create global workspace with default configs
        from services.workspace_resolver import ensure_global_workspace
        global_ws_id = ensure_global_workspace(db, str(tenant_id))
        db.flush()

        # Initialize default workspace configs if they don't exist
        _initialize_global_workspace_configs(db, global_ws_id, str(tenant_id))
        db.flush()

        # Create default application in the global workspace
        app = Application(
            tenant_id=tenant_id,
            name="Default Application",
            description="Default application created automatically",
            is_active=True,
            source='manual',
            workspace_id=global_ws_id,
        )
        db.add(app)
        db.flush()  # Flush to get the app.id

        # Generate unique API key (different from tenant API key)
        api_key = generate_api_key()
        while db.query(ApiKey).filter(ApiKey.key == api_key).first():
            api_key = generate_api_key()

        # Create API key for the application
        key = ApiKey(
            tenant_id=tenant_id,
            application_id=app.id,
            key=api_key,
            name="Default API Key",
            is_active=True
        )
        db.add(key)
        db.flush()

        logger.info(f"Created default application '{app.name}' with API key in global workspace for tenant {tenant_email}")

        db.commit()

        return {
            "application_id": str(app.id),
            "application_name": app.name,
            "api_key": api_key
        }

    except Exception as e:
        logger.error(f"Failed to create default application for tenant {tenant_email}: {e}")
        db.rollback()
        return None


def _initialize_global_workspace_configs(db: Session, workspace_id: str, tenant_id: str):
    """Initialize default configurations for a global workspace."""
    from database.models import (
        RiskTypeConfig, DataSecurityEntityType,
        ApplicationDataLeakagePolicy
    )
    from services.scanner_config_service import ScannerConfigService

    ws_uuid = uuid.UUID(str(workspace_id))
    tenant_uuid = uuid.UUID(str(tenant_id))

    # 1. RiskTypeConfig (all enabled by default)
    existing = db.query(RiskTypeConfig).filter(RiskTypeConfig.workspace_id == ws_uuid).first()
    if not existing:
        db.add(RiskTypeConfig(
            tenant_id=tenant_uuid, workspace_id=ws_uuid,
            s1_enabled=True, s2_enabled=True, s3_enabled=True, s4_enabled=True,
            s5_enabled=True, s6_enabled=True, s7_enabled=True, s8_enabled=True,
            s9_enabled=True, s10_enabled=True, s11_enabled=True, s12_enabled=True,
            s13_enabled=True, s14_enabled=True, s15_enabled=True, s16_enabled=True,
            s17_enabled=True, s18_enabled=True, s19_enabled=True, s20_enabled=True,
            s21_enabled=True,
            low_sensitivity_threshold=0.95,
            medium_sensitivity_threshold=0.60,
            high_sensitivity_threshold=0.40,
            sensitivity_trigger_level="medium"
        ))

    # 2. DataSecurityEntityTypes (copy from system templates)
    existing_entities = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.workspace_id == ws_uuid
    ).count()
    if existing_entities == 0:
        system_templates = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.source_type == 'system_template',
            DataSecurityEntityType.application_id.is_(None),
            DataSecurityEntityType.workspace_id.is_(None),
        ).all()
        for template in system_templates:
            db.add(DataSecurityEntityType(
                tenant_id=tenant_uuid, workspace_id=ws_uuid,
                entity_type=template.entity_type,
                entity_type_name=template.entity_type_name,
                category=template.category,
                recognition_method=template.recognition_method,
                recognition_config=(template.recognition_config or {}).copy() if isinstance(template.recognition_config, dict) else {},
                anonymization_method=template.anonymization_method,
                anonymization_config=(template.anonymization_config or {}).copy() if isinstance(template.anonymization_config, dict) else {},
                is_active=True, is_global=False,
                source_type='system_copy', template_id=template.id,
            ))

    # 4. Scanner configs
    try:
        scanner_service = ScannerConfigService(db)
        scanner_service.initialize_default_configs(
            application_id=None,
            tenant_id=tenant_uuid,
            workspace_id=ws_uuid,
        )
    except Exception as e:
        logger.error(f"Failed to initialize scanner configs for global workspace: {e}")

def verify_user_email(db: Session, email: str, verification_code: str) -> bool:
    """Verify tenant email"""
    # Find valid verification code
    verification = db.query(EmailVerification).filter(
        EmailVerification.email == email,
        EmailVerification.verification_code == verification_code,
        EmailVerification.is_used == False,
        EmailVerification.expires_at > datetime.utcnow()
    ).first()

    if not verification:
        return False

    # Mark verification code as used
    verification.is_used = True

    # Activate tenant
    tenant = db.query(Tenant).filter(Tenant.email == email).first()
    if tenant:
        tenant.is_active = True
        tenant.is_verified = True

    # First commit the user activation to ensure it's saved
    db.commit()

    # Then try to create default configurations (these are not critical for user activation)
    if tenant:
        # Create default application and API key for new user
        # The default application API key is different from the tenant API key:
        # - Tenant API key: Used for auto-discovery mode (tenant API key + X-OG-Application-ID header)
        # - Application API key: Used for direct API calls to this specific application
        try:
            result = create_default_application_and_key(db, tenant.id, tenant.email)
            if result:
                logger.info(f"Created default application for tenant {tenant.email}: app_id={result['application_id']}")
            else:
                logger.warning(f"Failed to create default application for tenant {tenant.email}")
        except Exception as e:
            logger.error(f"Error creating default application for tenant {tenant.email}: {e}")
            # Not critical for user activation, continue

        # Create default reply templates for new tenant
        try:
            from services.template_service import create_user_default_templates
            template_count = create_user_default_templates(db, tenant.id)
            print(f"Created {template_count} default reply templates for tenant {tenant.email}")
        except Exception as e:
            print(f"Failed to create default reply templates for tenant {tenant.email}: {e}")
            # Not affect tenant activation process, just record error

        # Create default entity type configuration for new tenant
        try:
            from services.data_security_service import create_user_default_entity_types
            entity_count = create_user_default_entity_types(db, str(tenant.id))
            print(f"Created {entity_count} default entity type configurations for tenant {tenant.email}")
        except Exception as e:
            print(f"Failed to create default entity type configurations for tenant {tenant.email}: {e}")
            # Not affect tenant activation process, just record error

        # Create default subscription for new tenant (free plan)
        try:
            from services.billing_service import billing_service
            billing_service.create_subscription(str(tenant.id), 'free', db)
            print(f"Created free subscription for tenant {tenant.email}")
        except Exception as e:
            print(f"Failed to create subscription for tenant {tenant.email}: {e}")
            # Not affect tenant activation process, just record error

        # Create default rate limit for new tenant (skip in enterprise mode)
        try:
            from config import settings
            if not settings.is_enterprise_mode:
                from services.rate_limiter import RateLimitService
                rate_limit_service = RateLimitService(db)
                default_rps = settings.default_rate_limit_rps
                rate_limit_service.set_user_rate_limit(str(tenant.id), default_rps)
                print(f"Created rate limit ({default_rps} RPS) for tenant {tenant.email}")
        except Exception as e:
            print(f"Failed to create rate limit for tenant {tenant.email}: {e}")
            # Not affect tenant activation process, just record error

    return True

def regenerate_api_key(db: Session, tenant_id: Union[str, uuid.UUID]) -> Optional[str]:
    """Regenerate tenant API key"""
    if isinstance(tenant_id, str):
        try:
            tenant_id = uuid.UUID(tenant_id)
        except ValueError:
            return None
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    if not tenant:
        return None

    new_api_key = generate_api_key()

    # Ensure API key is unique
    while db.query(Tenant).filter(Tenant.api_key == new_api_key).first():
        new_api_key = generate_api_key()

    tenant.api_key = new_api_key
    db.commit()
    db.refresh(tenant)

    return new_api_key

def get_user_by_api_key(db: Session, api_key: str) -> Optional[Tenant]:
    """
    Get tenant by API key (only return verified tenant)
    DEPRECATED: This function uses the old tenants.api_key column.
    Use get_application_by_api_key() for new multi-application support.
    """
    return db.query(Tenant).filter(
        Tenant.api_key == api_key,
        Tenant.is_verified == True,
        Tenant.is_active == True
    ).first()


def get_application_by_api_key(db: Session, api_key: str) -> Optional[dict]:
    """
    Get application and tenant information by API key (new multi-application support)

    Returns:
        dict with keys: tenant_id, tenant_email, application_id, application_name, api_key_id
        None if API key is invalid or inactive
    """
    from database.models import ApiKey, Application, Tenant

    # Query the ApiKey with joined Application and Tenant
    result = db.query(ApiKey, Application, Tenant).join(
        Application, ApiKey.application_id == Application.id
    ).join(
        Tenant, ApiKey.tenant_id == Tenant.id
    ).filter(
        ApiKey.key == api_key,
        ApiKey.is_active == True,
        Application.is_active == True,
        Tenant.is_verified == True,
        Tenant.is_active == True
    ).first()

    if not result:
        return None

    api_key_obj, application, tenant = result

    # Update last_used_at timestamp (async, non-blocking)
    try:
        from datetime import datetime
        api_key_obj.last_used_at = datetime.utcnow()
        db.commit()
    except Exception as e:
        logger.warning(f"Failed to update API key last_used_at: {e}")
        db.rollback()

    return {
        "tenant_id": str(tenant.id),
        "tenant_email": tenant.email,
        "application_id": str(application.id),
        "application_name": application.name,
        "api_key_id": str(api_key_obj.id),
        "api_key": api_key
    }

def get_user_by_email(db: Session, email: str) -> Optional[Tenant]:
    """Get tenant by email"""
    return db.query(Tenant).filter(Tenant.email == email).first()

def record_login_attempt(db: Session, email: str, ip_address: str, user_agent: str, success: bool):
    """Record login attempt"""
    from database.models import LoginAttempt
    
    attempt = LoginAttempt(
        email=email,
        ip_address=ip_address,
        user_agent=user_agent or "",
        success=success
    )
    db.add(attempt)
    db.commit()

def check_login_rate_limit(db: Session, email: str, ip_address: str, time_window_minutes: int = 15, max_attempts: int = 5) -> bool:
    from database.models import LoginAttempt
    from datetime import datetime, timedelta
    
    cutoff_time = datetime.utcnow() - timedelta(minutes=time_window_minutes)
    
    email_failures = db.query(LoginAttempt).filter(
        LoginAttempt.email == email,
        LoginAttempt.success == False,
        LoginAttempt.attempted_at >= cutoff_time
    ).count()
    
    # If email failure count exceeds limit, reject
    return email_failures < max_attempts

def cleanup_old_login_attempts(db: Session, days_to_keep: int = 30):
    """Clean up old login attempt records"""
    from database.models import LoginAttempt
    from datetime import datetime, timedelta
    
    cutoff_time = datetime.utcnow() - timedelta(days=days_to_keep)
    
    try:
        deleted_count = db.query(LoginAttempt).filter(
            LoginAttempt.attempted_at < cutoff_time
        ).delete()
        db.commit()
        
        if deleted_count > 0:
            logger.info(f"Cleaned up {deleted_count} old login attempts older than {days_to_keep} days")
        
        return deleted_count
    except Exception as e:
        logger.error(f"Failed to cleanup old login attempts: {e}")
        db.rollback()
        return 0

def emergency_clear_rate_limit(db: Session, email: str = None, ip_address: str = None, time_window_minutes: int = 15):
    """Emergency clear rate limit (used to solve the problem of accidental blocking)"""
    from database.models import LoginAttempt
    from datetime import datetime, timedelta

    cutoff_time = datetime.utcnow() - timedelta(minutes=time_window_minutes)

    try:
        query = db.query(LoginAttempt).filter(
            LoginAttempt.attempted_at >= cutoff_time,
            LoginAttempt.success == False
        )

        if email:
            query = query.filter(LoginAttempt.email == email)
        if ip_address:
            query = query.filter(LoginAttempt.ip_address == ip_address)

        deleted_count = query.delete()
        db.commit()

        logger.info(f"Emergency cleared {deleted_count} failed login attempts for email={email}, ip={ip_address}")
        return deleted_count
    except Exception as e:
        logger.error(f"Failed to emergency clear rate limit: {e}")
        db.rollback()
        return 0


def get_or_create_application_by_external_id(db: Session, tenant_id: Union[str, uuid.UUID], external_id: str, workspace_external_name: Optional[str] = None) -> Optional[dict]:
    """
    Get or create an application by external ID (for third-party gateway auto-discovery).

    When using tenant API key with X-OG-Application-ID header from third-party gateways (e.g., Higress),
    this function finds or creates the corresponding application.

    Args:
        db: Database session
        tenant_id: Tenant UUID
        external_id: External application identifier (e.g., gateway consumer name like "tester1")
        workspace_external_name: Optional workspace name for auto-assignment (e.g., from X-OG-Workspace-ID header)

    Returns:
        dict with keys: application_id, application_name, is_new
        None if creation failed
    """
    from database.models import Application, Workspace

    if isinstance(tenant_id, str):
        try:
            tenant_id = uuid.UUID(tenant_id)
        except ValueError:
            logger.error(f"Invalid tenant_id format: {tenant_id}")
            return None

    # 1. Find existing application by external_id
    app = db.query(Application).filter(
        Application.tenant_id == tenant_id,
        Application.external_id == external_id,
        Application.is_active == True
    ).first()

    if app:
        logger.debug(f"Found existing application for external_id '{external_id}': app_id={app.id}")
        # Ensure app is in a workspace (migration safety)
        if not app.workspace_id:
            from services.workspace_resolver import ensure_global_workspace
            app.workspace_id = ensure_global_workspace(db, str(tenant_id))
            db.flush()
        # Assign to specific workspace if specified
        if workspace_external_name and not app.workspace_id:
            _assign_app_to_workspace(db, app, tenant_id, workspace_external_name)
        return {
            "application_id": str(app.id),
            "application_name": app.name,
            "is_new": False
        }

    # 2. Auto-create new application (assigned to global workspace, no app-level configs)
    try:
        # Ensure global workspace exists
        from services.workspace_resolver import ensure_global_workspace
        global_ws_id = ensure_global_workspace(db, str(tenant_id))

        new_app = Application(
            tenant_id=tenant_id,
            name=external_id,  # Use external_id as application name
            description=f"Auto-discovered from gateway: {external_id}",
            external_id=external_id,
            source='auto_discovery',
            is_active=True,
            workspace_id=global_ws_id,  # All apps must be in a workspace
        )
        db.add(new_app)
        db.flush()  # Get the app ID

        # Assign to specific workspace if specified (overrides global)
        if workspace_external_name:
            _assign_app_to_workspace(db, new_app, tenant_id, workspace_external_name)

        db.commit()
        logger.info(f"Auto-created application '{external_id}' for tenant {tenant_id}: app_id={new_app.id}")

        return {
            "application_id": str(new_app.id),
            "application_name": new_app.name,
            "is_new": True
        }
    except Exception as e:
        logger.error(f"Failed to auto-create application for external_id '{external_id}': {e}")
        db.rollback()
        return None


def _assign_app_to_workspace(db: Session, app, tenant_id, workspace_name: str):
    """Find or create a workspace by name and assign the application to it.
    New workspaces inherit all configs from the global workspace."""
    from database.models import Workspace
    from services.workspace_resolver import get_global_workspace_id

    try:
        workspace = db.query(Workspace).filter(
            Workspace.tenant_id == tenant_id,
            Workspace.name == workspace_name,
        ).first()

        if not workspace:
            workspace = Workspace(
                tenant_id=tenant_id,
                name=workspace_name,
                description=f"Auto-discovered from gateway: {workspace_name}",
            )
            db.add(workspace)
            db.flush()
            logger.info(f"Auto-created workspace '{workspace_name}' for tenant {tenant_id}")

            # Copy all configs from global workspace so the new workspace
            # inherits guardrail rules, disposal strategies, blacklists, etc.
            global_ws_id = get_global_workspace_id(db, str(tenant_id))
            if global_ws_id:
                try:
                    from routers.workspaces import copy_workspace_config
                    copy_workspace_config(db, global_ws_id, str(workspace.id), str(tenant_id))
                    logger.info(f"Copied global workspace config to new workspace '{workspace_name}'")
                except Exception as e:
                    logger.error(f"Failed to copy global config to workspace '{workspace_name}': {e}")
                    # Fallback: initialize with system defaults
                    _initialize_global_workspace_configs(db, str(workspace.id), str(tenant_id))
            else:
                # No global workspace yet, initialize with system defaults
                _initialize_global_workspace_configs(db, str(workspace.id), str(tenant_id))

        app.workspace_id = workspace.id
        logger.debug(f"Assigned app '{app.name}' to workspace '{workspace_name}'")
    except Exception as e:
        logger.warning(f"Failed to assign app to workspace '{workspace_name}': {e}")