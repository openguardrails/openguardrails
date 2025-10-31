"""
Upstream API configuration management API - management service endpoint
Redesigned to support one upstream API key serving multiple models
"""
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from typing import Dict, Any, Optional, List
import uuid
from datetime import datetime

from database.connection import get_admin_db_session
from database.models import UpstreamApiConfig, ProxyRequestLog, OnlineTestModelSelection
from sqlalchemy.orm import Session
from utils.logger import setup_logger
from cryptography.fernet import Fernet
import os
import base64

router = APIRouter()
logger = setup_logger()

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
    """Get user upstream API configurations"""
    try:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data']['tenant_id']

        # Standardize user_id to UUID object
        try:
            if isinstance(tenant_id, str):
                tenant_id_uuid = uuid.UUID(tenant_id)
            elif hasattr(tenant_id, 'hex'):  # Already UUID object
                tenant_id_uuid = tenant_id
            else:
                tenant_id_uuid = uuid.UUID(str(tenant_id))
        except (ValueError, TypeError) as e:
            logger.error(f"Invalid tenant_id format: {tenant_id}, error: {e}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

        # Directly use database query
        db = get_admin_db_session()
        try:
            configs = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.tenant_id == tenant_id_uuid
            ).all()

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
    """Create upstream API configuration"""
    try:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data']['tenant_id']

        # Standardize user_id to UUID object
        try:
            if isinstance(tenant_id, str):
                tenant_id_uuid = uuid.UUID(tenant_id)
            elif hasattr(tenant_id, 'hex'):  # Already UUID object
                tenant_id_uuid = tenant_id
            else:
                tenant_id_uuid = uuid.UUID(str(tenant_id))
        except (ValueError, TypeError) as e:
            logger.error(f"Invalid tenant_id format: {tenant_id}, error: {e}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

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
            # Check if configuration name already exists
            existing = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.tenant_id == tenant_id_uuid,
                UpstreamApiConfig.config_name == request_data['config_name']
            ).first()
            if existing:
                raise ValueError(f"Upstream API configuration '{request_data['config_name']}' already exists")

            # Encrypt API key
            encrypted_api_key = _encrypt_api_key(request_data['api_key'])

            # Create upstream API configuration
            api_config = UpstreamApiConfig(
                id=uuid.uuid4(),
                tenant_id=tenant_id_uuid,
                config_name=request_data['config_name'],
                api_base_url=request_data['api_base_url'],
                api_key_encrypted=encrypted_api_key,
                provider=request_data.get('provider'),  # Optional
                is_active=bool(request_data.get('is_active', True)),
                block_on_input_risk=bool(request_data.get('block_on_input_risk', False)),
                block_on_output_risk=bool(request_data.get('block_on_output_risk', False)),
                enable_reasoning_detection=bool(request_data.get('enable_reasoning_detection', True)),
                stream_chunk_size=int(request_data.get('stream_chunk_size', 50)),
                description=request_data.get('description')
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
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data']['tenant_id']

        # Standardize user_id to UUID object
        try:
            if isinstance(tenant_id, str):
                tenant_id_uuid = uuid.UUID(tenant_id)
            elif hasattr(tenant_id, 'hex'):  # Already UUID object
                tenant_id_uuid = tenant_id
            else:
                tenant_id_uuid = uuid.UUID(str(tenant_id))
        except (ValueError, TypeError) as e:
            logger.error(f"Invalid tenant_id format: {tenant_id}, error: {e}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

        db = get_admin_db_session()
        try:
            api_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == api_id,
                UpstreamApiConfig.tenant_id == tenant_id_uuid
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
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data']['tenant_id']

        # Standardize user_id to UUID object
        try:
            if isinstance(tenant_id, str):
                tenant_id_uuid = uuid.UUID(tenant_id)
            elif hasattr(tenant_id, 'hex'):  # Already UUID object
                tenant_id_uuid = tenant_id
            else:
                tenant_id_uuid = uuid.UUID(str(tenant_id))
        except (ValueError, TypeError) as e:
            logger.error(f"Invalid tenant_id format: {tenant_id}, error: {e}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

        request_data = await request.json()

        # Debug log
        logger.info(f"Update upstream API {api_id} - received data: {request_data}")

        # Directly use database operation
        db = get_admin_db_session()
        try:
            api_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == api_id,
                UpstreamApiConfig.tenant_id == tenant_id_uuid
            ).first()

            if not api_config:
                raise ValueError(f"Upstream API configuration not found")

            # Check if configuration name already exists
            if 'config_name' in request_data:
                existing = db.query(UpstreamApiConfig).filter(
                    UpstreamApiConfig.tenant_id == tenant_id_uuid,
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
                elif field in ['is_active', 'block_on_input_risk', 'block_on_output_risk', 'enable_reasoning_detection']:
                    # Explicitly handle boolean fields
                    setattr(api_config, field, bool(value))
                elif field == 'stream_chunk_size':
                    # Handle integer fields
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
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data']['tenant_id']

        # Standardize user_id to UUID object
        try:
            if isinstance(tenant_id, str):
                tenant_id_uuid = uuid.UUID(tenant_id)
            elif hasattr(tenant_id, 'hex'):  # Already UUID object
                tenant_id_uuid = tenant_id
            else:
                tenant_id_uuid = uuid.UUID(str(tenant_id))
        except (ValueError, TypeError) as e:
            logger.error(f"Invalid tenant_id format: {tenant_id}, error: {e}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

        # Directly use database operation
        db = get_admin_db_session()
        try:
            api_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == api_id,
                UpstreamApiConfig.tenant_id == tenant_id_uuid
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

            logger.info(f"Deleted upstream API config '{config_name}' for user {tenant_id}. "
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