"""
Upstream API configuration management API - management service endpoint
Redesigned to support one upstream API key serving multiple models
"""
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from typing import Dict, Any, Optional, List, Tuple
import uuid
from datetime import datetime

from database.connection import get_admin_db_session
from database.models import UpstreamApiConfig, ProxyRequestLog, OnlineTestModelSelection, Tenant
from sqlalchemy.orm import Session
from utils.logger import setup_logger
from cryptography.fernet import Fernet
import os
import base64

router = APIRouter()
logger = setup_logger()

def get_current_user_from_request(request: Request, db: Session) -> Tenant:
    """
    Get current tenant from request
    Returns: Tenant
    Note: Proxy management is tenant-level (global), not application-level
    """
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']

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

    return tenant

def _get_or_create_encryption_key() -> bytes:
    """Get or create encryption key"""
    from config import settings
    key_file = f"{settings.data_dir}/proxy_encryption.key"
    os.makedirs(os.path.dirname(key_file), exist_ok=True)
    
    if os.path.exists(key_file):
        with open(key_file, 'rb') as f:
            return f.read()
    else:
        key = Fernet.generate_key()
        with open(key_file, 'wb') as f:
            f.write(key)
        return key

def _encrypt_api_key(api_key: str) -> str:
    """Encrypt API key"""
    cipher_suite = Fernet(_get_or_create_encryption_key())
    return cipher_suite.encrypt(api_key.encode()).decode()

def _decrypt_api_key(encrypted_api_key: str) -> str:
    """Decrypt API key"""
    cipher_suite = Fernet(_get_or_create_encryption_key())
    return cipher_suite.decrypt(encrypted_api_key.encode()).decode()

def _mask_api_key(api_key: str) -> str:
    """Mask API key, showing first 6 and last 4 characters"""
    if not api_key:
        return ""
    if len(api_key) <= 10:
        # If too short, just mask the middle part
        return api_key[0] + "*" * (len(api_key) - 2) + api_key[-1] if len(api_key) > 2 else api_key
    # Show first 6 and last 4 characters, mask the rest
    masked_length = len(api_key) - 10
    return api_key[:6] + "*" * masked_length + api_key[-4:]

@router.get("/proxy/upstream-apis")
async def get_user_upstream_apis(request: Request):
    """Get tenant upstream API configurations (global, not application-specific)"""
    try:
        # Directly use database query
        db = get_admin_db_session()
        try:
            current_user = get_current_user_from_request(request, db)
            logger.info(f"Getting upstream configs for tenant: {current_user.id}")

            # Query by tenant_id only (not application_id) - proxy configs are global
            configs = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.tenant_id == current_user.id
            ).all()

            logger.info(f"Found {len(configs)} upstream configs for tenant {current_user.id}")

            return {
                "success": True,
                "data": [
                    {
                        "id": str(config.id),
                        "config_name": config.config_name,
                        "api_base_url": config.api_base_url,
                        "provider": config.provider,
                        "is_active": config.is_active,
                        "block_on_input_risk": config.block_on_input_risk,
                        "block_on_output_risk": config.block_on_output_risk,
                        "enable_reasoning_detection": config.enable_reasoning_detection,
                        "stream_chunk_size": config.stream_chunk_size,
                        "description": config.description,
                        "is_data_safe": config.is_data_safe if config.is_data_safe is not None else False,
                        "is_default_safe_model": config.is_default_safe_model if config.is_default_safe_model is not None else False,
                        "safe_model_priority": config.safe_model_priority if config.safe_model_priority is not None else 0,
                        "created_at": config.created_at.isoformat(),
                        "gateway_url": f"http://localhost:5002/v1/gateway/{config.id}/"
                    }
                    for config in configs
                ]
            }
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Get user upstream APIs error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.post("/proxy/upstream-apis")
async def create_upstream_api(request: Request):
    """Create upstream API configuration (tenant-level, global)"""
    try:
        request_data = await request.json()

        # Debug log
        logger.info(f"Create upstream API - received data: {request_data}")

        # Verify necessary fields (removed model_name requirement)
        required_fields = ['config_name', 'api_base_url', 'api_key']
        for field in required_fields:
            if field not in request_data or not request_data[field]:
                raise ValueError(f"Missing required field: {field}")

        # Directly use database operation
        db = get_admin_db_session()
        try:
            current_user = get_current_user_from_request(request, db)

            # Check if configuration name already exists (tenant-level check)
            existing = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.tenant_id == current_user.id,
                UpstreamApiConfig.config_name == request_data['config_name']
            ).first()
            if existing:
                raise ValueError(f"Upstream API configuration '{request_data['config_name']}' already exists")

            # Security Gateway configurations are tenant-level and do not belong to any application
            # Applications are determined by the API key used when calling the gateway

            # Encrypt API key
            api_key_to_encrypt = request_data['api_key']
            # Log for debugging (mask the key)
            masked_key = f"{api_key_to_encrypt[:8]}...{api_key_to_encrypt[-4:]}" if len(api_key_to_encrypt) > 12 else "***"
            logger.info(f"Creating upstream API config with api_key={masked_key}")

            encrypted_api_key = _encrypt_api_key(api_key_to_encrypt)

            # Create upstream API configuration (tenant-level, no application_id)
            api_config = UpstreamApiConfig(
                id=uuid.uuid4(),
                tenant_id=current_user.id,
                application_id=None,  # Security Gateway configs are tenant-level, not application-specific
                config_name=request_data['config_name'],
                api_base_url=request_data['api_base_url'],
                api_key_encrypted=encrypted_api_key,
                provider=request_data.get('provider'),  # Optional
                is_active=bool(request_data.get('is_active', True)),
                block_on_input_risk=bool(request_data.get('block_on_input_risk', False)),
                block_on_output_risk=bool(request_data.get('block_on_output_risk', False)),
                enable_reasoning_detection=bool(request_data.get('enable_reasoning_detection', True)),
                stream_chunk_size=int(request_data.get('stream_chunk_size', 50)),
                description=request_data.get('description'),
                # Safety attributes for data leakage prevention
                is_data_safe=bool(request_data.get('is_data_safe', False)),
                is_default_safe_model=bool(request_data.get('is_default_safe_model', False)),
                safe_model_priority=int(request_data.get('safe_model_priority', 0))
            )

            db.add(api_config)
            db.commit()
            db.refresh(api_config)
        finally:
            db.close()

        return {
            "success": True,
            "data": {
                "id": str(api_config.id),
                "config_name": api_config.config_name,
                "api_base_url": api_config.api_base_url,
                "provider": api_config.provider,
                "is_active": api_config.is_active,
                "gateway_url": f"http://localhost:5002/v1/gateway/{api_config.id}/"
            }
        }
    except Exception as e:
        logger.error(f"Create upstream API error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.get("/proxy/upstream-apis/{api_id}")
async def get_upstream_api_detail(api_id: str, request: Request):
    """Get single upstream API configuration detail (for edit form)"""
    try:
        db = get_admin_db_session()
        try:
            current_user = get_current_user_from_request(request, db)

            # Query by tenant_id only (configs are global for tenant)
            api_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == api_id,
                UpstreamApiConfig.tenant_id == current_user.id
            ).first()

            if not api_config:
                raise ValueError(f"Upstream API configuration not found")

            # Decrypt and mask API key for display
            api_key_masked = ""
            if api_config.api_key_encrypted:
                try:
                    decrypted_key = _decrypt_api_key(api_config.api_key_encrypted)
                    api_key_masked = _mask_api_key(decrypted_key)
                except Exception as e:
                    logger.error(f"Failed to decrypt API key: {e}")
                    api_key_masked = "******"

            return {
                "success": True,
                "data": {
                    "id": str(api_config.id),
                    "config_name": api_config.config_name,
                    "api_base_url": api_config.api_base_url,
                    "api_key_masked": api_key_masked,
                    "provider": api_config.provider,
                    "is_active": api_config.is_active if api_config.is_active is not None else True,
                    "enable_reasoning_detection": api_config.enable_reasoning_detection if api_config.enable_reasoning_detection is not None else True,
                    "block_on_input_risk": api_config.block_on_input_risk if api_config.block_on_input_risk is not None else False,
                    "block_on_output_risk": api_config.block_on_output_risk if api_config.block_on_output_risk is not None else False,
                    "stream_chunk_size": api_config.stream_chunk_size if api_config.stream_chunk_size is not None else 50,
                    "description": api_config.description,
                    "is_data_safe": api_config.is_data_safe if api_config.is_data_safe is not None else False,
                    "is_default_safe_model": api_config.is_default_safe_model if api_config.is_default_safe_model is not None else False,
                    "safe_model_priority": api_config.safe_model_priority if api_config.safe_model_priority is not None else 0,
                    "created_at": api_config.created_at.isoformat(),
                    "gateway_url": f"http://localhost:5002/v1/gateway/{api_config.id}/"
                }
            }
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Get upstream API detail error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.put("/proxy/upstream-apis/{api_id}")
async def update_upstream_api(api_id: str, request: Request):
    """Update upstream API configuration"""
    try:
        request_data = await request.json()

        # Debug log
        logger.info(f"Update upstream API {api_id} - received data: {request_data}")

        # Directly use database operation
        db = get_admin_db_session()
        try:
            current_user = get_current_user_from_request(request, db)

            # Query by tenant_id only (configs are global for tenant)
            api_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == api_id,
                UpstreamApiConfig.tenant_id == current_user.id
            ).first()

            if not api_config:
                raise ValueError(f"Upstream API configuration not found")

            # Check if configuration name already exists (tenant-level check)
            if 'config_name' in request_data:
                existing = db.query(UpstreamApiConfig).filter(
                    UpstreamApiConfig.tenant_id == current_user.id,
                    UpstreamApiConfig.config_name == request_data['config_name'],
                    UpstreamApiConfig.id != api_id  # Exclude current configuration
                ).first()
                if existing:
                    raise ValueError(f"Upstream API configuration '{request_data['config_name']}' already exists")

            # Update fields
            for field, value in request_data.items():
                if field == 'api_key':
                    if value:  # If API key is provided, update
                        api_config.api_key_encrypted = _encrypt_api_key(value)
                elif field in ['is_active', 'block_on_input_risk', 'block_on_output_risk', 'enable_reasoning_detection', 'is_data_safe', 'is_default_safe_model']:
                    # Explicitly handle boolean fields (including safety attributes)
                    setattr(api_config, field, bool(value))
                elif field in ['stream_chunk_size', 'safe_model_priority']:
                    # Handle integer fields (including safety attributes)
                    setattr(api_config, field, int(value))
                elif hasattr(api_config, field):
                    setattr(api_config, field, value)

            db.commit()
            db.refresh(api_config)

            return {
                "success": True,
                "data": {
                    "id": str(api_config.id),
                    "config_name": api_config.config_name,
                    "api_base_url": api_config.api_base_url,
                    "provider": api_config.provider,
                    "is_active": api_config.is_active,
                    "gateway_url": f"http://localhost:5002/v1/gateway/{api_config.id}/"
                }
            }
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Update upstream API error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.delete("/proxy/upstream-apis/{api_id}")
async def delete_upstream_api(api_id: str, request: Request):
    """Delete upstream API configuration"""
    try:
        # Directly use database operation
        db = get_admin_db_session()
        try:
            current_user = get_current_user_from_request(request, db)

            # Query by tenant_id only (configs are global for tenant)
            api_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == api_id,
                UpstreamApiConfig.tenant_id == current_user.id
            ).first()

            if not api_config:
                raise ValueError(f"Upstream API configuration not found")

            # Note: We don't cascade delete request logs - they reference upstream_api_config_id with ON DELETE SET NULL
            # This preserves historical data while allowing config deletion

            # Delete associated online test model selection records
            deleted_selections_count = db.query(OnlineTestModelSelection).filter(
                OnlineTestModelSelection.proxy_model_id == api_id
            ).delete()

            # Delete upstream API configuration
            config_name = api_config.config_name
            db.delete(api_config)
            db.commit()

            logger.info(f"Deleted upstream API config '{config_name}' for tenant {current_user.id}. "
                       f"Also deleted {deleted_selections_count} model selections.")
        finally:
            db.close()

        return {"success": True}
    except Exception as e:
        logger.error(f"Delete upstream API error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )