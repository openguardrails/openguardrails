from typing import Optional
from pydantic_settings import BaseSettings
from pathlib import Path

def get_version() -> str:
    """
    Get version number, priority:
    1. VERSION file
    2. Environment variable APP_VERSION
    3. Default version
    """
    try:
        # Try to read from VERSION file
        version_file = Path(__file__).parent.parent / "VERSION"
        if version_file.exists():
            return version_file.read_text().strip()
    except Exception:
        pass
    
    # Try to get from environment variable
    import os
    env_version = os.getenv('APP_VERSION')
    if env_version:
        return env_version
    
    # Default version
    return "1.0.0"

class Settings(BaseSettings):
    # Application configuration
    app_name: str = "OpenGuardrails"
    app_version: str = get_version()
    debug: bool = False
    
    # Super admin configuration
    # Warning: Please modify these default values in production environment!
    super_admin_username: str = "admin@yourdomain.com"
    super_admin_password: str = "CHANGE-THIS-PASSWORD-IN-PRODUCTION"
    
    # Data directory configuration
    data_dir: str = "/mnt/data/openguardrails-data"

    @property
    def media_dir(self) -> str:
        """Media file directory"""
        return f"{self.data_dir}/media"
    
    # Database configuration
    database_url: str = "postgresql://openguardrails:your_password@localhost:54321/openguardrails"
    
    # Model configuration
    guardrails_model_api_url: str = "http://your-host-ip:your-port/v1"
    guardrails_model_api_key: str = "your-guardrails-model-api-key"
    guardrails_model_name: str = "OpenGuardrails-Text"

    # Multimodal model configuration
    guardrails_vl_model_api_url: str = "http://localhost:58003/v1"
    guardrails_vl_model_api_key: str = "your-vl-model-api-key"
    guardrails_vl_model_name: str = "OpenGuardrails-VL"
    
    # Detection maximum context length configuration (should be equal to model max-model-len - 1000)
    max_detection_context_length: int = 7168
    
    # Embedding model API configuration
    # Used for knowledge base vectorization
    embedding_api_base_url: str = "http://your-host-ip:your-port/v1"
    embedding_api_key: str = "your-embedding-api-key"
    embedding_model_name: str = "OpenGuardrails-Embedding-1024"
    embedding_model_dimension: int = 1024  # Embedding vector dimension
    embedding_similarity_threshold: float = 0.7  # Similarity threshold
    embedding_max_results: int = 5  # Maximum return results

    # API configuration
    cors_origins: str = "*"
    
    # Log configuration  
    log_level: str = "INFO"
    
    @property
    def log_dir(self) -> str:
        """Log directory"""
        return f"{self.data_dir}/logs"
    
    @property 
    def detection_log_dir(self) -> str:
        """Detection result log directory"""
        return f"{self.data_dir}/logs/detection"
    
    # Contact information
    support_email: str = "thomas@openguardrails.com"
    
    # HuggingFace model
    huggingface_model: str = "openguardrails/OpenGuardrails-Text"
    
    # JWT configuration
    # Warning: Please generate a secure random key! Use: openssl rand -base64 64
    jwt_secret_key: str = "GENERATE-A-SECURE-RANDOM-JWT-KEY-IN-PRODUCTION"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 1440
    
    # Email configuration
    smtp_server: str = ""
    smtp_port: Optional[int] = None
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: Optional[bool] = None
    smtp_use_ssl: Optional[bool] = None
    

    # Server configuration - dual service architecture
    host: str = "0.0.0.0"
    
    # Detection service host name (for service间调用)
    # Docker环境: detection-service，本地环境: localhost
    detection_host: str = "localhost"
    
    # Management service configuration (low concurrency)
    admin_port: int = 5000
    admin_uvicorn_workers: int = 2
    admin_max_concurrent_requests: int = 50

    # Detection service configuration (high concurrency)
    detection_port: int = 5001
    detection_uvicorn_workers: int = 32
    detection_max_concurrent_requests: int = 400

    # Proxy service configuration (high concurrency)
    proxy_port: int = 5002
    proxy_uvicorn_workers: int = 24
    proxy_max_concurrent_requests: int = 300

    # Development and operations: whether to reset database (delete and rebuild all tables)
    reset_database_on_startup: bool = False
    
    # Private deployment configuration: whether to store detection results in the database
    # true: store to database (SaaS mode, complete data analysis)
    # false: only write log file (private mode, reduce database pressure)
    store_detection_results: bool = True

    class Config:
        # Ensure we load the .env file next to this config module,
        # regardless of the current working directory
        env_file = str(Path(__file__).with_name('.env'))
        case_sensitive = False
        extra = "allow"

settings = Settings()
