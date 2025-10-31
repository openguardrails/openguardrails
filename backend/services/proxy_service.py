"""
Proxy service - core business logic for reverse proxy
"""
import httpx
import json
import uuid
import asyncio
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from cryptography.fernet import Fernet
import base64
import os
from contextlib import asynccontextmanager

# Import database related modules
from database.connection import get_admin_db_session
from database.models import ProxyModelConfig, ProxyRequestLog, OnlineTestModelSelection, UpstreamApiConfig
from utils.logger import setup_logger

logger = setup_logger()

class ProxyService:
    def __init__(self):
        # Initialize encryption key
        self.encryption_key = self._get_or_create_encryption_key()
        self.cipher_suite = Fernet(self.encryption_key)
        
        # High-performance HTTP client connection pool
        self.http_client = None
        self._setup_http_client()
        
    def _get_or_create_encryption_key(self) -> bytes:
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
    
    def _setup_http_client(self):
        """Setup high-performance HTTP client"""
        # Connection pool configuration - optimized for high concurrency
        limits = httpx.Limits(
            max_keepalive_connections=50,  # Keep-alive connections
            max_connections=200,           # Maximum connections
            keepalive_expiry=30.0          # Connection keep-alive time
        )
        
        # Timeout configuration - increase timeout for proxy model
        timeout = httpx.Timeout(
            connect=15.0,    # Connection timeout
            read=600.0,      # Read timeout increased to 10 minutes
            write=15.0,      # Write timeout
            pool=10.0        # Connection pool timeout
        )
        
        self.http_client = httpx.AsyncClient(
            limits=limits,
            timeout=timeout,
            http2=True,      # Enable HTTP/2
            verify=True      # SSL verification
        )
    
    async def close(self):
        """Close HTTP client"""
        if self.http_client:
            await self.http_client.aclose()
    
    def _encrypt_api_key(self, api_key: str) -> str:
        """Encrypt API key"""
        return self.cipher_suite.encrypt(api_key.encode()).decode()
    
    def _decrypt_api_key(self, encrypted_api_key: str) -> str:
        """Decrypt API key"""
        return self.cipher_suite.decrypt(encrypted_api_key.encode()).decode()
    
    async def get_user_models(self, tenant_id: str) -> List[ProxyModelConfig]:
        """Get user model configuration list"""
        # Ensure tenant_id is UUID object
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        db = get_admin_db_session()
        try:
            models = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.tenant_id == tenant_id,
                ProxyModelConfig.enabled == True
            ).order_by(ProxyModelConfig.created_at).all()

            # Preload all model attributes to avoid session detached error
            for model in models:
                _ = model.tenant  # Trigger tenant relationship loading
                # Ensure all attributes are loaded into memory (only access actual fields)
                _ = (model.id, model.config_name, model.model_name, model.api_base_url,
                     model.api_key_encrypted, model.enabled, model.created_at, model.updated_at,
                     model.stream_chunk_size, model.block_on_input_risk, model.block_on_output_risk,
                     model.enable_reasoning_detection)
                # Detach object from session
                db.expunge(model)

            return models
        finally:
            db.close()
    
    async def get_upstream_api_config(self, upstream_api_id: str, tenant_id: str) -> Optional[UpstreamApiConfig]:
        """Get upstream API configuration by ID (new gateway pattern)"""
        # Ensure IDs are UUID objects
        if isinstance(upstream_api_id, str):
            upstream_api_id = uuid.UUID(upstream_api_id)
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        db = get_admin_db_session()
        try:
            config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == upstream_api_id,
                UpstreamApiConfig.tenant_id == tenant_id,
                UpstreamApiConfig.is_active == True
            ).first()

            # If found, preload all attributes to avoid session detached error
            if config:
                _ = config.tenant  # Trigger tenant relationship loading
                _ = (config.id, config.config_name, config.api_base_url,
                     config.api_key_encrypted, config.provider, config.is_active,
                     config.block_on_input_risk, config.block_on_output_risk,
                     config.enable_reasoning_detection, config.stream_chunk_size,
                     config.description, config.created_at, config.updated_at)
                
                # Log for debugging
                logger.info(f"Retrieved upstream API config: id={config.id}, config_name={config.config_name}, api_base_url={config.api_base_url}")

                # Detach object from session
                db.expunge(config)

            return config
        finally:
            db.close()

    async def get_user_model_config(self, tenant_id: str, model_name: str) -> Optional[ProxyModelConfig]:
        """Get user specific model configuration (legacy pattern)"""
        # Ensure tenant_id is UUID object
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        db = get_admin_db_session()
        try:
            # First match exact config_name
            model = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.tenant_id == tenant_id,
                ProxyModelConfig.config_name == model_name,
                ProxyModelConfig.enabled == True
            ).first()

            # If not found, try to get the first enabled model
            if not model:
                model = db.query(ProxyModelConfig).filter(
                    ProxyModelConfig.tenant_id == tenant_id,
                    ProxyModelConfig.enabled == True
                ).first()

            # If found model, preload all possible attributes to avoid session detached error caused by lazy loading
            if model:
                # Preload tenant relationship and all attributes
                _ = model.tenant  # Trigger tenant relationship loading
                # Ensure all attributes are loaded into memory (only access actual fields)
                _ = (model.id, model.config_name, model.model_name, model.api_base_url,
                     model.api_key_encrypted, model.enabled, model.created_at, model.updated_at,
                     model.stream_chunk_size, model.block_on_input_risk, model.block_on_output_risk,
                     model.enable_reasoning_detection)

                # Detach object from session to avoid issues after session is closed
                db.expunge(model)

            return model
        finally:
            db.close()
    
    async def create_user_model(self, tenant_id: str, model_data: Dict[str, Any]) -> ProxyModelConfig:
        """Create user model configuration"""
        # Ensure tenant_id is UUID object
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        db = get_admin_db_session()
        try:
            # Validate required fields
            required_fields = ['config_name', 'api_base_url', 'api_key', 'model_name']
            for field in required_fields:
                if field not in model_data or not model_data[field]:
                    raise ValueError(f"Missing required field: {field}")

            # Check if configuration name already exists
            existing = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.tenant_id == tenant_id,
                ProxyModelConfig.config_name == model_data['config_name']
            ).first()
            if existing:
                raise ValueError(f"Model configuration '{model_data['config_name']}' already exists")
            
            # Encrypt API key
            encrypted_api_key = self._encrypt_api_key(model_data['api_key'])
            
            model_config = ProxyModelConfig(
                tenant_id=tenant_id,
                config_name=model_data['config_name'],
                api_base_url=model_data['api_base_url'].rstrip('/'),
                api_key_encrypted=encrypted_api_key,
                model_name=model_data['model_name'],
                enabled=model_data.get('enabled', True),
                block_on_input_risk=model_data.get('block_on_input_risk', False),
                block_on_output_risk=model_data.get('block_on_output_risk', False),
                enable_reasoning_detection=model_data.get('enable_reasoning_detection', True)
            )
            

            
            db.add(model_config)
            db.commit()
            db.refresh(model_config)
            
            logger.info(f"Created proxy model config '{model_config.config_name}' for user {tenant_id}")
            return model_config
        except Exception as e:
            db.rollback()
            raise e
        finally:
            db.close()
    
    async def update_user_model(self, tenant_id: str, model_id: str, model_data: Dict[str, Any]) -> ProxyModelConfig:
        """Update user model configuration"""
        # Ensure tenant_id is UUID object
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        db = get_admin_db_session()
        try:
            model_config = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.id == model_id,
                ProxyModelConfig.tenant_id == tenant_id
            ).first()
            
            if not model_config:
                raise ValueError(f"Model configuration not found")
            
            # Update fields
            for field, value in model_data.items():
                if field == 'api_key' and value:
                    model_config.api_key_encrypted = self._encrypt_api_key(value)
                elif field in ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']:
                    if value is not None:
                        setattr(model_config, field, str(value))
                elif hasattr(model_config, field):
                    setattr(model_config, field, value)
            

            
            db.commit()
            db.refresh(model_config)
            
            logger.info(f"Updated proxy model config '{model_config.config_name}' for user {tenant_id}")
            return model_config
        except Exception as e:
            db.rollback()
            raise e
        finally:
            db.close()
    
    async def delete_user_model(self, tenant_id: str, model_id: str):
        """Delete user model configuration"""
        # Ensure tenant_id is UUID object
        if isinstance(tenant_id, str):
            tenant_id = uuid.UUID(tenant_id)

        db = get_admin_db_session()
        try:
            model_config = db.query(ProxyModelConfig).filter(
                ProxyModelConfig.id == model_id,
                ProxyModelConfig.tenant_id == tenant_id
            ).first()
            
            if not model_config:
                raise ValueError(f"Model configuration not found")
            
            # First delete associated request log records
            deleted_logs_count = db.query(ProxyRequestLog).filter(
                ProxyRequestLog.proxy_config_id == model_id
            ).delete()
            
            # Then delete associated online test model selection records
            deleted_selections_count = db.query(OnlineTestModelSelection).filter(
                OnlineTestModelSelection.proxy_model_id == model_id
            ).delete()
            
            # Finally delete proxy model configuration
            db.delete(model_config)
            db.commit()
            
            logger.info(f"Deleted proxy model config '{model_config.config_name}' for user {tenant_id}. "
                       f"Also deleted {deleted_logs_count} request logs and {deleted_selections_count} model selections.")
        except Exception as e:
            db.rollback()
            raise e
        finally:
            db.close()
    
    async def forward_streaming_chat_completion(
        self,
        model_config: ProxyModelConfig,
        request_data: Any,
        request_id: str
    ):
        """Forward streaming chat completion request to target model"""
        api_key = self._decrypt_api_key(model_config.api_key_encrypted)
        
        # Construct request URL
        url = f"{model_config.api_base_url}/chat/completions"
        
        # Construct request headers
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        # Construct request body - fully pass user parameters
        payload = request_data.dict(exclude_unset=True)  # Only include user actual passed parameters
        payload["model"] = model_config.model_name  # Replace with actual model name
        payload["messages"] = [{"role": msg.role, "content": msg.content} for msg in request_data.messages]
        payload["stream"] = True  # Force enable streaming mode
        
        # Process extra_body parameters
        if hasattr(request_data, 'extra_body') and request_data.extra_body:
            payload.update(request_data.extra_body)
        
        try:
            async with self.http_client.stream("POST", url, headers=headers, json=payload) as response:
                response.raise_for_status()
                
                async for line in response.aiter_lines():
                    if line.strip():
                        if line.startswith("data: "):
                            line = line[6:]  # Remove "data: " prefix
                            
                            if line.strip() == "[DONE]":
                                break
                                
                            try:
                                chunk_data = json.loads(line)
                                yield chunk_data
                            except json.JSONDecodeError:
                                continue
                                
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error forwarding streaming to {model_config.api_base_url}: {e}")
            # Safely get response text, avoid error due to not reading response content
            try:
                error_detail = await e.response.aread() if hasattr(e.response, 'aread') else str(e)
                if isinstance(error_detail, bytes):
                    error_detail = error_detail.decode('utf-8', errors='ignore')
            except Exception:
                error_detail = f"Status code: {e.response.status_code}"
            raise Exception(f"Model API streaming error: {error_detail}")
        except httpx.RequestError as e:
            logger.error(f"Request error forwarding streaming to {model_config.api_base_url}: {e}")
            raise Exception(f"Failed to connect to model API for streaming: {str(e)}")
        except Exception as e:
            logger.error(f"Unexpected error in streaming request: {e}")
            raise Exception(f"Streaming request failed: {str(e)}")

    async def forward_chat_completion(
        self, 
        model_config: ProxyModelConfig, 
        request_data: Any, 
        request_id: str
    ) -> Dict[str, Any]:
        """Forward chat completion request to target model"""
        api_key = self._decrypt_api_key(model_config.api_key_encrypted)
        
        # Construct request URL
        url = f"{model_config.api_base_url}/chat/completions"
        
        # Construct request headers
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        # Construct request body - fully pass user parameters
        payload = request_data.dict(exclude_unset=True)  # Only include user actual passed parameters
        payload["model"] = model_config.model_name  # Replace with actual model name
        payload["messages"] = [{"role": msg.role, "content": msg.content} for msg in request_data.messages]
        
        # Process extra_body parameters
        if hasattr(request_data, 'extra_body') and request_data.extra_body:
            payload.update(request_data.extra_body)
        
        # Use shared HTTP client to send request
        try:
            response = await self.http_client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            
            result = response.json()
            
            # Ensure id field is present
            if 'id' not in result:
                result['id'] = f"chatcmpl-{request_id}"
            
            return result
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error forwarding to {model_config.api_base_url}: {e}")
            # Log detailed error, but only return generic error information to client
            if hasattr(e, 'response'):
                logger.error(f"Upstream API response: {e.response.text}")
            if e.response.status_code == 401:
                raise Exception("Invalid API credentials")
            elif e.response.status_code == 403:
                raise Exception("Access forbidden by upstream API")
            elif e.response.status_code == 429:
                raise Exception("Rate limit exceeded")
            elif e.response.status_code >= 500:
                raise Exception("Upstream API service unavailable")
            else:
                raise Exception("Request failed")
        except httpx.RequestError as e:
            logger.error(f"Request error forwarding to {model_config.api_base_url}: {e}")
            raise Exception("Failed to connect to model API")
    
    async def forward_completion(
        self, 
        model_config: ProxyModelConfig, 
        request_data: Any, 
        request_id: str
    ) -> Dict[str, Any]:
        """Forward text completion request to target model"""
        api_key = self._decrypt_api_key(model_config.api_key_encrypted)
        
        # Construct request URL
        url = f"{model_config.api_base_url}/completions"
        
        # Construct request headers
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        # Construct request body
        payload = {
            "model": model_config.model_name,
            "prompt": request_data.prompt
        }
        
        # Add optional parameters
        optional_params = [
            'temperature', 'top_p', 'n', 'stream', 'logprobs', 'echo', 
            'stop', 'max_tokens', 'presence_penalty', 'frequency_penalty', 
            'best_of', 'logit_bias', 'user'
        ]
        
        for param in optional_params:
            value = getattr(request_data, param, None)
            if value is not None:
                payload[param] = value
            elif hasattr(model_config, param) and getattr(model_config, param):
                if param in ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']:
                    payload[param] = float(getattr(model_config, param))
                elif param == 'max_tokens':
                    payload[param] = model_config.max_tokens
        
        # Use shared HTTP client to send request
        try:
            response = await self.http_client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            
            result = response.json()
            
            # Ensure id field is present
            if 'id' not in result:
                result['id'] = f"cmpl-{request_id}"
            
            return result
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error forwarding to {model_config.api_base_url}: {e}")
            # Log detailed error, but only return generic error information to client
            if hasattr(e, 'response'):
                logger.error(f"Upstream API response: {e.response.text}")
            if e.response.status_code == 401:
                raise Exception("Invalid API credentials")
            elif e.response.status_code == 403:
                raise Exception("Access forbidden by upstream API")
            elif e.response.status_code == 429:
                raise Exception("Rate limit exceeded")
            elif e.response.status_code >= 500:
                raise Exception("Upstream API service unavailable")
            else:
                raise Exception("Request failed")
        except httpx.RequestError as e:
            logger.error(f"Request error forwarding to {model_config.api_base_url}: {e}")
            raise Exception("Failed to connect to model API")

    # ============================================================================
    # Gateway Pattern Methods (new design - one API key serves multiple models)
    # ============================================================================

    async def call_upstream_api_gateway(
        self,
        api_config: UpstreamApiConfig,
        model_name: str,  # Original model name from user request
        messages: List[Dict],
        stream: bool = False,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        top_p: Optional[float] = None,
        frequency_penalty: Optional[float] = None,
        presence_penalty: Optional[float] = None,
        stop: Optional[List[str]] = None
    ):
        """Call upstream API with gateway pattern (pass through model name)"""
        api_key = self._decrypt_api_key(api_config.api_key_encrypted)
        
        # Log API key info for debugging (only show first/last few chars)
        masked_key = f"{api_key[:8]}...{api_key[-4:]}" if len(api_key) > 12 else "***"
        logger.info(f"Calling upstream API {api_config.api_base_url} with upstream_api_config_id={api_config.id}, api_key={masked_key}")

        # Construct request URL
        url = f"{api_config.api_base_url}/chat/completions"

        # Construct request headers
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # Construct request body - pass through original model name
        payload = {
            "model": model_name,  # Key difference: use user's original model name
            "messages": messages,
            "stream": stream
        }

        # Add optional parameters
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if top_p is not None:
            payload["top_p"] = top_p
        if frequency_penalty is not None:
            payload["frequency_penalty"] = frequency_penalty
        if presence_penalty is not None:
            payload["presence_penalty"] = presence_penalty
        if stop is not None:
            payload["stop"] = stop

        # Use shared HTTP client to send request
        try:
            if stream:
                # Return async generator for streaming
                return self.http_client.stream("POST", url, headers=headers, json=payload)
            else:
                # Non-streaming request
                response = await self.http_client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                return response.json()

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error calling gateway upstream {api_config.api_base_url}: {e}")
            if hasattr(e, 'response'):
                logger.error(f"Upstream API response: {e.response.text}")
            if e.response.status_code == 401:
                raise Exception("Invalid API credentials")
            elif e.response.status_code == 403:
                raise Exception("Access forbidden by upstream API")
            elif e.response.status_code == 429:
                raise Exception("Rate limit exceeded")
            elif e.response.status_code >= 500:
                raise Exception("Upstream API service unavailable")
            else:
                raise Exception("Request failed")
        except httpx.RequestError as e:
            logger.error(f"Request error calling gateway upstream {api_config.api_base_url}: {e}")
            raise Exception("Failed to connect to upstream API")

    async def log_proxy_request_gateway(
        self,
        request_id: str,
        tenant_id: str,
        upstream_api_config_id: str,
        model_requested: str,
        model_used: str,
        provider: str,
        input_detection_id: Optional[str] = None,
        output_detection_id: Optional[str] = None,
        input_blocked: bool = False,
        output_blocked: bool = False,
        request_tokens: int = 0,
        response_tokens: int = 0,
        total_tokens: int = 0,
        status: str = "success",
        error_message: Optional[str] = None,
        response_time_ms: int = 0
    ):
        """Log proxy request for gateway pattern (uses upstream_api_config_id)"""
        db = get_admin_db_session()
        try:
            log_entry = ProxyRequestLog(
                request_id=request_id,
                tenant_id=tenant_id,
                upstream_api_config_id=upstream_api_config_id,  # New field
                proxy_config_id=None,  # Legacy field, set to None for gateway pattern
                model_requested=model_requested,
                model_used=model_used,
                provider=provider,
                input_detection_id=input_detection_id,
                output_detection_id=output_detection_id,
                input_blocked=input_blocked,
                output_blocked=output_blocked,
                request_tokens=request_tokens,
                response_tokens=response_tokens,
                total_tokens=total_tokens,
                status=status,
                error_message=error_message,
                response_time_ms=response_time_ms
            )

            db.add(log_entry)
            db.commit()
        except Exception as e:
            logger.error(f"Failed to log gateway proxy request {request_id}: {e}")
            db.rollback()
        finally:
            db.close()

    async def log_proxy_request(
        self,
        request_id: str,
        tenant_id: str,
        proxy_config_id: str,
        model_requested: str,
        model_used: str,
        provider: str,
        input_detection_id: Optional[str] = None,
        output_detection_id: Optional[str] = None,
        input_blocked: bool = False,
        output_blocked: bool = False,
        request_tokens: int = 0,
        response_tokens: int = 0,
        total_tokens: int = 0,
        status: str = "success",
        error_message: Optional[str] = None,
        response_time_ms: int = 0
    ):
        """Log proxy request"""
        db = get_admin_db_session()
        try:
            log_entry = ProxyRequestLog(
                request_id=request_id,
                tenant_id=tenant_id,
                proxy_config_id=proxy_config_id,
                model_requested=model_requested,
                model_used=model_used,
                provider=provider,
                input_detection_id=input_detection_id,
                output_detection_id=output_detection_id,
                input_blocked=input_blocked,
                output_blocked=output_blocked,
                request_tokens=request_tokens,
                response_tokens=response_tokens,
                total_tokens=total_tokens,
                status=status,
                error_message=error_message,
                response_time_ms=response_time_ms
            )
            
            db.add(log_entry)
            db.commit()
        except Exception as e:
            logger.error(f"Failed to log proxy request {request_id}: {e}")
            db.rollback()
        finally:
            db.close()

# Create global instance
proxy_service = ProxyService()