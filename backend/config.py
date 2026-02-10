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
    embedding_similarity_threshold: float = 0.7  # Default similarity threshold (fallback when KB-specific threshold is not available)
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
    
    # Frontend URL configuration
    frontend_url: str = "https://openguardrails.com"

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

    # Default language configuration for private deployments without internet access
    # Options: 'en' (English) or 'zh' (Chinese)
    default_language: str = "en"

    # Deployment mode configuration
    # 'enterprise': Private enterprise deployment (default) - no subscription, no third-party package marketplace
    # 'saas': SaaS deployment - with subscription system and third-party package marketplace
    deployment_mode: str = "enterprise"

    # API domain configuration for documentation and examples
    # In SaaS mode: api.openguardrails.com
    # In enterprise/private mode: http://localhost:5001 (or custom domain)
    api_domain: str = "https://api.openguardrails.com" if deployment_mode.lower() == "saas" else "http://localhost:5001"


    @property
    def is_saas_mode(self) -> bool:
        """Check if running in SaaS mode"""
        return self.deployment_mode.lower() == "saas"

    @property
    def is_enterprise_mode(self) -> bool:
        """Check if running in enterprise mode (private deployment)"""
        return self.deployment_mode.lower() == "enterprise"

    # Default tenant limits
    # Default monthly scan limit for new tenants (detections per month)
    # Note: This should match free_user_monthly_quota for consistency
    # If not set, will use free_user_monthly_quota as default
    default_monthly_scan_limit: Optional[int] = None

    # Default rate limit for new tenants (requests per second)
    default_rate_limit_rps: int = 10

    # Payment configuration
    # Alipay configuration (used when default_language is 'zh')
    alipay_app_id: str = ""
    alipay_private_key: str = ""
    alipay_public_key: str = ""
    alipay_notify_url: str = ""  # e.g., https://yourdomain.com/api/v1/payment/webhook/alipay
    alipay_return_url: str = ""  # e.g., https://yourdomain.com/platform/billing/subscription
    alipay_gateway: str = "https://openapi.alipay.com/gateway.do"  # Production gateway
    # alipay_gateway: str = "https://openapi-sandbox.dl.alipaydev.com/gateway.do"  # Sandbox gateway

    # Stripe configuration (used when default_language is not 'zh')
    stripe_secret_key: str = ""
    stripe_publishable_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_id_monthly: str = ""  # Stripe Price ID for monthly subscription (legacy single-tier)
    stripe_price_ids: str = ""  # JSON mapping of tier_number to Stripe Price IDs, e.g. {"1":"price_xxx","2":"price_yyy"}
    stripe_subscription_success_url: str = ""  # e.g., http://localhost:3000/platform/subscription?payment=success&session_id={CHECKOUT_SESSION_ID}
    stripe_subscription_cancel_url: str = ""   # e.g., http://localhost:3000/platform/subscription?payment=cancelled
    stripe_package_success_url: str = ""       # e.g., http://localhost:3000/platform/config/scanner-packages?payment=success&session_id={CHECKOUT_SESSION_ID}
    stripe_package_cancel_url: str = ""        # e.g., http://localhost:3000/platform/config/scanner-packages?payment=cancelled

    # Subscription pricing
    subscription_price_cny: float = 19.0  # Monthly price in CNY
    subscription_price_usd: float = 19.0  # Monthly price in USD

    # Quota purchase pricing (pay-per-use for Chinese users via Alipay)
    quota_price_cny: float = 50.0  # Price per unit in CNY (¥50 per 10,000 calls)
    quota_calls_per_unit: int = 10000  # Number of API calls per purchase unit
    quota_validity_days: int = 365  # Purchased quota validity in days

    # Subscription quota limits
    free_user_monthly_quota: int = 1000  # Monthly quota for free users
    paid_user_monthly_quota: int = 100000  # Monthly quota for paid/subscribed users

    # VerifyMail.io API configuration for disposable email verification
    # If not configured, disposable email verification will be skipped
    verifymail_api_key: Optional[str] = None

    class Config:
        # Ensure we load the .env file next to this config module,
        # regardless of the current working directory
        env_file = str(Path(__file__).with_name('.env'))
        case_sensitive = False
        extra = "allow"

settings = Settings()
