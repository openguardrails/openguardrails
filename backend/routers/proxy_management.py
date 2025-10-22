"""
Proxy model configuration management API - management service endpoint
"""
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from typing import Dict, Any, Optional, List
import uuid
from datetime import datetime

from database.connection import get_admin_db_session
from database.models import ProxyModelConfig, ProxyRequestLog, OnlineTestModelSelection
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

@router.get("/proxy/models")
async def get_user_proxy_models(request: Request):
    """Get user proxy model configuration"""
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
            models = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.tenant_id == tenant_id_uuid
            ).all()
            
            return {
                "success": True,
                "data": [
                    {
                        "id": str(model.id),
                        "config_name": model.config_name,
                        "model_name": model.model_name,
                        "enabled": model.enabled,
                        "block_on_input_risk": model.block_on_input_risk,
                        "block_on_output_risk": model.block_on_output_risk,
                        "enable_reasoning_detection": model.enable_reasoning_detection,
                        "stream_chunk_size": model.stream_chunk_size,
                        "created_at": model.created_at.isoformat()
                    }
                    for model in models
                ]
            }
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Get user proxy models error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.post("/proxy/models")
async def create_proxy_model(request: Request):
    """Create proxy model configuration"""
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
        logger.info(f"Create proxy model - received original data: {request_data}")
        for key in ['enabled', 'block_on_input_risk', 'block_on_output_risk', 'enable_reasoning_detection', 'stream_chunk_size']:
            if key in request_data:
                logger.info(f"{key}: {request_data[key]} (Type: {type(request_data[key])})")
        
        # Verify necessary fields
        required_fields = ['config_name', 'api_base_url', 'api_key', 'model_name']
        for field in required_fields:
            if field not in request_data or not request_data[field]:
                raise ValueError(f"Missing required field: {field}")
        
        # Directly use database operation
        db = get_admin_db_session()
        try:
            # Check if configuration name already exists
            existing = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.tenant_id == tenant_id_uuid,
                ProxyModelConfig.config_name == request_data['config_name']
            ).first()
            if existing:
                raise ValueError(f"Model configuration '{request_data['config_name']}' already exists")
            
            # Encrypt API key
            encrypted_api_key = _encrypt_api_key(request_data['api_key'])
            
            # Create model configuration, using "3+3" design
            model_config = ProxyModelConfig(
                id=uuid.uuid4(),
                tenant_id=tenant_id_uuid,
                config_name=request_data['config_name'],
                api_base_url=request_data['api_base_url'],
                api_key_encrypted=encrypted_api_key,
                model_name=request_data['model_name'],
                enabled=bool(request_data.get('enabled', True)),
                block_on_input_risk=bool(request_data.get('block_on_input_risk', False)),
                block_on_output_risk=bool(request_data.get('block_on_output_risk', False)),
                enable_reasoning_detection=bool(request_data.get('enable_reasoning_detection', True)),
                stream_chunk_size=int(request_data.get('stream_chunk_size', 50))
            )
            
            db.add(model_config)
            db.commit()
            db.refresh(model_config)
        finally:
            db.close()
        
        return {
            "success": True,
            "data": {
                "id": str(model_config.id),
                "config_name": model_config.config_name,
                "model_name": model_config.model_name,
                "enabled": model_config.enabled
            }
        }
    except Exception as e:
        logger.error(f"Create proxy model error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.get("/proxy/models/{model_id}")
async def get_proxy_model_detail(model_id: str, request: Request):
    """Get single proxy model configuration detail (for edit form)"""
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
            model_config = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.id == model_id,
                ProxyModelConfig.tenant_id == tenant_id_uuid
            ).first()
            
            if not model_config:
                raise ValueError(f"Model configuration not found")
            
            return {
                "success": True,
                "data": {
                    "id": str(model_config.id),
                    "config_name": model_config.config_name,
                    "api_base_url": model_config.api_base_url,
                    "api_key_masked": "sk-xxai-" + "*" * 48 if model_config.api_key_encrypted else "",
                    "model_name": model_config.model_name,
                    "enabled": model_config.enabled if model_config.enabled is not None else True,
                    "enable_reasoning_detection": model_config.enable_reasoning_detection if model_config.enable_reasoning_detection is not None else True,
                    "block_on_input_risk": model_config.block_on_input_risk if model_config.block_on_input_risk is not None else False,
                    "block_on_output_risk": model_config.block_on_output_risk if model_config.block_on_output_risk is not None else False,
                    "stream_chunk_size": model_config.stream_chunk_size if model_config.stream_chunk_size is not None else 50,
                    "created_at": model_config.created_at.isoformat()
                }
            }
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Get proxy model detail error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.put("/proxy/models/{model_id}")
async def update_proxy_model(model_id: str, request: Request):
    """Update proxy model configuration"""
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
        logger.info(f"Update proxy model {model_id} - received original data: {request_data}")
        for key in ['enabled', 'block_on_input_risk', 'block_on_output_risk', 'enable_reasoning_detection', 'stream_chunk_size']:
            if key in request_data:
                logger.info(f"{key}: {request_data[key]} (类型: {type(request_data[key])})")
        
        # Directly use database operation
        db = get_admin_db_session()
        try:
            model_config = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.id == model_id,
                ProxyModelConfig.tenant_id == tenant_id_uuid
            ).first()

            if not model_config:
                raise ValueError(f"Model configuration not found")

            # Check if configuration name already exists
            if 'config_name' in request_data:
                existing = db.query(ProxyModelConfig).filter(
                    ProxyModelConfig.tenant_id == tenant_id_uuid,
                    ProxyModelConfig.config_name == request_data['config_name'],
                    ProxyModelConfig.id != model_id  # Exclude current configuration
                ).first()
                if existing:
                    raise ValueError(f"Model configuration '{request_data['config_name']}' already exists")
            
            # Update fields
            for field, value in request_data.items():
                if field == 'api_key':
                    if value:  # If API key is provided, update
                        model_config.api_key_encrypted = _encrypt_api_key(value)

                elif field in ['enabled', 'block_on_input_risk', 'block_on_output_risk', 'enable_reasoning_detection']:
                    # Explicitly handle boolean fields, ensure correct false value setting
                    setattr(model_config, field, bool(value))
                elif field == 'stream_chunk_size':
                    # Handle integer fields
                    setattr(model_config, field, int(value))
                elif hasattr(model_config, field):
                    setattr(model_config, field, value)
            
            
            db.commit()
            db.refresh(model_config)
            
            return {
                "success": True,
                "data": {
                    "id": str(model_config.id),
                    "config_name": model_config.config_name,
                    "model_name": model_config.model_name,
                    "enabled": model_config.enabled
                }
            }
        finally:
            db.close()
    except Exception as e:
        logger.error(f"Update proxy model error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )

@router.delete("/proxy/models/{model_id}")
async def delete_proxy_model(model_id: str, request: Request):
    """Delete proxy model configuration"""
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
            model_config = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.id == model_id,
                ProxyModelConfig.tenant_id == tenant_id_uuid
            ).first()
            
            if not model_config:
                raise ValueError(f"Model configuration not found")
            
            # First delete associated request log records
            deleted_logs_count = db.query(ProxyRequestLog).filter(
                ProxyRequestLog.proxy_config_id == model_id
            ).delete()
            
            # Delete associated online test model selection records
            deleted_selections_count = db.query(OnlineTestModelSelection).filter(
                OnlineTestModelSelection.proxy_model_id == model_id
            ).delete()
            
            # Finally delete proxy model configuration
            db.delete(model_config)
            db.commit()
            
            logger.info(f"Deleted proxy model config '{model_config.config_name}' for user {tenant_id}. "
                       f"Also deleted {deleted_logs_count} request logs and {deleted_selections_count} model selections.")
        finally:
            db.close()
        
        return {"success": True}
    except Exception as e:
        logger.error(f"Delete proxy model error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )