from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, JSON, ForeignKey, UniqueConstraint, Float
from sqlalchemy.dialects.postgresql import UUID
import uuid
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from database.connection import Base

class Tenant(Base):
    """租户表 (原用户表)"""
    __tablename__ = "tenants"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(128), nullable=False)
    is_active = Column(Boolean, default=False)  # After email verification, activate
    is_verified = Column(Boolean, default=False)  # Whether the email has been verified
    is_super_admin = Column(Boolean, default=False)  # Whether to be a super admin
    api_key = Column(String(64), unique=True, nullable=False, index=True)  # Deprecated: kept for backward compatibility, use api_keys table instead
    language = Column(String(10), default='en', nullable=False)  # User language preference
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    applications = relationship("Application", back_populates="tenant", cascade="all, delete-orphan")
    detection_results = relationship("DetectionResult", back_populates="tenant")
    test_models = relationship("TestModelConfig", back_populates="tenant")
    blacklists = relationship("Blacklist", back_populates="tenant")
    whitelists = relationship("Whitelist", back_populates="tenant")
    response_templates = relationship("ResponseTemplate", back_populates="tenant")
    risk_config = relationship("RiskTypeConfig", back_populates="tenant", uselist=False)

class Application(Base):
    """Application table - Each tenant can have multiple applications"""
    __tablename__ = "applications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="applications")
    api_keys = relationship("ApiKey", back_populates="application", cascade="all, delete-orphan")
    blacklists = relationship("Blacklist", back_populates="application", cascade="all, delete-orphan")
    whitelists = relationship("Whitelist", back_populates="application", cascade="all, delete-orphan")
    response_templates = relationship("ResponseTemplate", back_populates="application", cascade="all, delete-orphan")
    risk_config = relationship("RiskTypeConfig", back_populates="application", uselist=False, cascade="all, delete-orphan")
    ban_policies = relationship("BanPolicy", back_populates="application", cascade="all, delete-orphan")
    knowledge_bases = relationship("KnowledgeBase", back_populates="application", cascade="all, delete-orphan")
    data_security_entity_types = relationship("DataSecurityEntityType", back_populates="application", cascade="all, delete-orphan")
    upstream_api_configs = relationship("UpstreamApiConfig", back_populates="application", cascade="all, delete-orphan")
    test_models = relationship("TestModelConfig", back_populates="application", cascade="all, delete-orphan")
    rate_limits = relationship("TenantRateLimit", back_populates="application", cascade="all, delete-orphan")
    detection_results = relationship("DetectionResult", back_populates="application")
    user_ban_records = relationship("UserBanRecord", back_populates="application", cascade="all, delete-orphan")
    user_risk_triggers = relationship("UserRiskTrigger", back_populates="application", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint('tenant_id', 'name', name='uq_applications_tenant_name'),
    )


class ApiKey(Base):
    """API Key table - Each application can have multiple API keys"""
    __tablename__ = "api_keys"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)
    key = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(100))
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    last_used_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="api_keys")


class EmailVerification(Base):
    """Email verification table"""
    __tablename__ = "email_verifications"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    verification_code = Column(String(6), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_used = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class PasswordResetToken(Base):
    """Password reset token table"""
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    reset_token = Column(String(64), unique=True, nullable=False, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_used = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class DetectionResult(Base):
    """Detection result table"""
    __tablename__ = "detection_results"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(String(64), unique=True, nullable=False, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Associated tenant
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="SET NULL"), nullable=True, index=True)  # Associated application (nullable for historical data)
    content = Column(Text, nullable=False)
    suggest_action = Column(String(20))  # 'pass', 'reject', 'replace'
    suggest_answer = Column(Text)  # Suggest answer content
    hit_keywords = Column(Text)  # Hit keywords (blacklist/whitelist)
    model_response = Column(Text)  # Original model response
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    ip_address = Column(String(45))
    user_agent = Column(Text)
    # Separated security and compliance detection results
    security_risk_level = Column(String(20), default='no_risk')  # Security risk level
    security_categories = Column(JSON, default=list)  # Security categories
    compliance_risk_level = Column(String(20), default='no_risk')  # Compliance risk level
    compliance_categories = Column(JSON, default=list)  # Compliance categories
    # Data security detection results
    data_risk_level = Column(String(20), default='no_risk')  # Data leakage risk level
    data_categories = Column(JSON, default=list)  # Data leakage categories
    # Multimodal related fields
    has_image = Column(Boolean, default=False, index=True)  # Whether contains image
    image_count = Column(Integer, default=0)  # Image count
    image_paths = Column(JSON, default=list)  # Saved image file path list

    # Association relationships
    tenant = relationship("Tenant", back_populates="detection_results")
    application = relationship("Application", back_populates="detection_results")

class Blacklist(Base):
    """Blacklist table"""
    __tablename__ = "blacklist"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Associated tenant (kept for backward compatibility)
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    name = Column(String(100), nullable=False)  # Blacklist library name
    keywords = Column(JSON, nullable=False)  # Keywords list
    description = Column(Text)  # Description
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="blacklists")
    application = relationship("Application", back_populates="blacklists")

class Whitelist(Base):
    """Whitelist table"""
    __tablename__ = "whitelist"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Associated tenant (kept for backward compatibility)
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    name = Column(String(100), nullable=False)  # Whitelist library name
    keywords = Column(JSON, nullable=False)  # Keywords list
    description = Column(Text)  # Description
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="whitelists")
    application = relationship("Application", back_populates="whitelists")

class ResponseTemplate(Base):
    """Response template table"""
    __tablename__ = "response_templates"

    id = Column(Integer, primary_key=True, index=True)
    # Allow null: When it is a system-level default template, tenant_id is null
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)  # Associated tenant (can be null for global templates)
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated application (nullable for global templates)
    category = Column(String(50), nullable=False, index=True)  # Risk category (S1-S12, default)
    risk_level = Column(String(20), nullable=False)  # Risk level
    template_content = Column(JSON, nullable=False)  # Multilingual response template content: {"en": "...", "zh": "...", ...}
    is_default = Column(Boolean, default=False)  # Whether it is a default template
    is_active = Column(Boolean, default=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="response_templates")
    application = relationship("Application", back_populates="response_templates")

class TenantSwitch(Base):
    """Tenant switch record table (for super admin to switch tenant perspective)"""
    __tablename__ = "tenant_switches"

    id = Column(Integer, primary_key=True, index=True)
    admin_tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)  # Admin tenant ID
    target_tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False)  # Target tenant ID
    switch_time = Column(DateTime(timezone=True), server_default=func.now())
    session_token = Column(String(128), unique=True, nullable=False)  # Switch session token
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_active = Column(Boolean, default=True)

class SystemConfig(Base):
    """System config table"""
    __tablename__ = "system_config"
    
    id = Column(Integer, primary_key=True, index=True)
    config_key = Column(String(100), unique=True, nullable=False)
    config_value = Column(Text)
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class LoginAttempt(Base):
    """Login attempt record table (for anti-brute force)"""
    __tablename__ = "login_attempts"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    ip_address = Column(String(45), nullable=False, index=True)  # Support IPv6
    user_agent = Column(Text)
    success = Column(Boolean, default=False, index=True)
    attempted_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

class RiskTypeConfig(Base):
    """Risk type switch config table"""
    __tablename__ = "risk_type_config"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True, unique=True)  # Associated application (unique constraint moved here)

    # S1-S21 risk type switch configuration
    s1_enabled = Column(Boolean, default=True)  # General political topics
    s2_enabled = Column(Boolean, default=True)  # Sensitive political topics
    s3_enabled = Column(Boolean, default=True)  # Insult to National Symbols or Leaders
    s4_enabled = Column(Boolean, default=True)  # Harm to minors
    s5_enabled = Column(Boolean, default=True)  # Violent crime
    s6_enabled = Column(Boolean, default=True)  # Non-violent crime
    s7_enabled = Column(Boolean, default=True)  # Pornography
    s8_enabled = Column(Boolean, default=True)  # Hate & Discrimination
    s9_enabled = Column(Boolean, default=True)  # Prompt Attacks
    s10_enabled = Column(Boolean, default=True) # Profanity
    s11_enabled = Column(Boolean, default=True) # Privacy Invasion
    s12_enabled = Column(Boolean, default=True) # Commercial Violations
    s13_enabled = Column(Boolean, default=True) # Intellectual Property Infringement
    s14_enabled = Column(Boolean, default=True) # Harassment
    s15_enabled = Column(Boolean, default=True) # Weapons of Mass Destruction
    s16_enabled = Column(Boolean, default=True) # Self-Harm
    s17_enabled = Column(Boolean, default=True) # Sexual Crimes
    s18_enabled = Column(Boolean, default=True) # Threats
    s19_enabled = Column(Boolean, default=True) # Professional Financial Advice
    s20_enabled = Column(Boolean, default=True) # Professional Medical Advice
    s21_enabled = Column(Boolean, default=True) # Professional Legal Advice

    # Global sensitivity threshold config
    high_sensitivity_threshold = Column(Float, default=0.40)    # High sensitivity threshold
    medium_sensitivity_threshold = Column(Float, default=0.60)  # Medium sensitivity threshold
    low_sensitivity_threshold = Column(Float, default=0.95)     # Low sensitivity threshold

    # Sensitivity trigger level config (low, medium, high)
    sensitivity_trigger_level = Column(String(20), default="medium")  # Trigger detection hit lowest sensitivity level

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="risk_config")
    application = relationship("Application", back_populates="risk_config")

class TenantRateLimit(Base):
    """Tenant rate limit config table"""
    __tablename__ = "tenant_rate_limits"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated application
    requests_per_second = Column(Integer, default=10, nullable=False)  # Requests per second, 0 means no limit
    is_active = Column(Boolean, default=True, index=True)  # Whether to enable rate limiting
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="rate_limits")

class TenantRateLimitCounter(Base):
    """Tenant real-time rate limit counter table - for cross-process rate limiting"""
    __tablename__ = "tenant_rate_limit_counters"

    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), primary_key=True, index=True)
    current_count = Column(Integer, default=0, nullable=False)  # Requests count in current window
    window_start = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)  # Window start time
    last_updated = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)  # Last updated time

    # Association relationships
    tenant = relationship("Tenant")

class TestModelConfig(Base):
    """Proxy model config table"""
    __tablename__ = "test_model_configs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    name = Column(String(255), nullable=False)  # Model display name
    base_url = Column(String(512), nullable=False)  # API Base URL
    api_key = Column(String(512), nullable=False)  # API Key
    model_name = Column(String(255), nullable=False)  # Model name
    enabled = Column(Boolean, default=True, index=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="test_models")
    application = relationship("Application", back_populates="test_models")

class UpstreamApiConfig(Base):
    """Upstream API configuration for Security Gateway"""
    __tablename__ = "upstream_api_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)  # Used in gateway URL
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    config_name = Column(String(100), nullable=False, index=True)  # Display name (e.g., "OpenAI Production")
    api_base_url = Column(String(512), nullable=False)  # Upstream API base URL
    api_key_encrypted = Column(Text, nullable=False)  # Encrypted upstream API key
    provider = Column(String(50))  # Provider type: openai, anthropic, local, etc.
    is_active = Column(Boolean, default=True, index=True)  # Whether this config is active

    # Security config
    block_on_input_risk = Column(Boolean, default=False)  # Whether to block on input risk
    block_on_output_risk = Column(Boolean, default=False)  # Whether to block on output risk
    enable_reasoning_detection = Column(Boolean, default=True)  # Whether to detect reasoning content
    stream_chunk_size = Column(Integer, default=50)  # Stream detection interval, detect every N chunks

    # Metadata
    description = Column(Text)  # Optional description
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="upstream_api_configs")

    __table_args__ = (
        UniqueConstraint('application_id', 'config_name', name='upstream_api_configs_application_name_unique'),
    )

class ProxyModelConfig(Base):
    """DEPRECATED: Reverse proxy model config table (replaced by UpstreamApiConfig)"""
    __tablename__ = "proxy_model_configs_deprecated"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    config_name = Column(String(100), nullable=False, index=True)  # Proxy model name, for model parameter matching
    api_base_url = Column(String(512), nullable=False)  # Upstream API base URL
    api_key_encrypted = Column(Text, nullable=False)  # Encrypted upstream API key
    model_name = Column(String(255), nullable=False)  # Upstream API model name
    enabled = Column(Boolean, default=True, index=True)  # Whether enabled

    # Security config (simplified design)
    block_on_input_risk = Column(Boolean, default=False)  # Whether to block on input risk, default not block
    block_on_output_risk = Column(Boolean, default=False)  # Whether to block on output risk, default not block
    enable_reasoning_detection = Column(Boolean, default=True)  # Whether to detect reasoning content, default enabled
    stream_chunk_size = Column(Integer, default=50)  # Stream detection interval, detect every N chunks, default 50

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")

class ProxyRequestLog(Base):
    """Reverse proxy request log table"""
    __tablename__ = "proxy_request_logs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    request_id = Column(String(64), unique=True, nullable=False, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)

    # New foreign key to upstream_api_configs
    upstream_api_config_id = Column(UUID(as_uuid=True), ForeignKey("upstream_api_configs.id", ondelete="SET NULL"), index=True)

    # Old foreign key (deprecated, kept for backward compatibility)
    proxy_config_id = Column(UUID(as_uuid=True), ForeignKey("proxy_model_configs_deprecated.id"), nullable=True)

    # Request information
    model_requested = Column(String(255), nullable=False)  # User requested model name
    model_used = Column(String(255), nullable=False)  # Actual used model name
    provider = Column(String(50), nullable=False)  # Provider

    # Detection results
    input_detection_id = Column(String(64), index=True)  # Input detection request ID
    output_detection_id = Column(String(64), index=True)  # Output detection request ID
    input_blocked = Column(Boolean, default=False)  # Whether input is blocked
    output_blocked = Column(Boolean, default=False)  # Whether output is blocked

    # Statistics information
    request_tokens = Column(Integer)  # Request token count
    response_tokens = Column(Integer)  # Response token count
    total_tokens = Column(Integer)  # Total token count
    response_time_ms = Column(Integer)  # Response time (milliseconds)

    # Status
    status = Column(String(20), nullable=False)  # success, blocked, error
    error_message = Column(Text)  # Error message

    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    # Association relationships
    tenant = relationship("Tenant")
    proxy_config = relationship("ProxyModelConfig")

class KnowledgeBase(Base):
    """Knowledge base table"""
    __tablename__ = "knowledge_bases"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    category = Column(String(50), nullable=False, index=True)  # Risk category (S1-S12)
    name = Column(String(255), nullable=False)  # Knowledge base name
    description = Column(Text)  # Description
    file_path = Column(String(512), nullable=False)  # Original JSONL file path
    vector_file_path = Column(String(512))  # Vectorized file path
    total_qa_pairs = Column(Integer, default=0)  # Total QA pairs
    similarity_threshold = Column(Float, default=0.7, nullable=False)  # Similarity threshold for this KB (0-1)
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    is_global = Column(Boolean, default=False, index=True)  # Whether it is a global knowledge base (all tenants take effect), only admin can set
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="knowledge_bases")

class OnlineTestModelSelection(Base):
    """Online test model selection table - record the proxy model selected by the tenant in online test"""
    __tablename__ = "online_test_model_selections"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    proxy_model_id = Column(UUID(as_uuid=True), ForeignKey("proxy_model_configs_deprecated.id"), nullable=False, index=True)
    selected = Column(Boolean, default=False, nullable=False)  # Whether it is selected for online test

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    proxy_model = relationship("ProxyModelConfig")

    # Add unique constraint, ensure each tenant has only one record for each proxy model
    __table_args__ = (
        UniqueConstraint('tenant_id', 'proxy_model_id', name='_tenant_proxy_model_selection_uc'),
    )

class DataSecurityEntityType(Base):
    """Data security entity type config table"""
    __tablename__ = "data_security_entity_types"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    entity_type = Column(String(100), nullable=False, index=True)  # Entity type code, such as ID_CARD_NUMBER
    display_name = Column(String(200), nullable=False)  # Display name, such as "ID Card Number"
    category = Column(String(50), nullable=False, index=True)  # Risk level: low, medium, high
    recognition_method = Column(String(20), nullable=False)  # Recognition method: regex
    recognition_config = Column(JSON, nullable=False)  # Recognition config, such as {"pattern": "...", "check_input": true, "check_output": true}
    anonymization_method = Column(String(20), default='replace')  # Anonymization method: replace, mask, hash, encrypt, shuffle, random
    anonymization_config = Column(JSON)  # Anonymization config, such as {"replacement": "<ID_CARD>"}
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    is_global = Column(Boolean, default=False, index=True)  # Whether it is a global config (deprecated, use source_type instead)
    source_type = Column(String(20), default='custom', index=True)  # Source type: 'system_template', 'system_copy', 'custom'
    template_id = Column(UUID(as_uuid=True), index=True, nullable=True)  # Template ID if copied from a template
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="data_security_entity_types")

class TenantEntityTypeDisable(Base):
    """Tenant entity type disable table"""
    __tablename__ = "tenant_entity_type_disables"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    entity_type = Column(String(100), nullable=False, index=True)  # Entity type code, such as ID_CARD_NUMBER_SYS
    disabled_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")

    # Unique constraint
    __table_args__ = (
        UniqueConstraint('tenant_id', 'entity_type', name='_tenant_entity_type_disable_uc'),
    )

class BanPolicy(Base):
    """Ban policy config table"""
    __tablename__ = "ban_policies"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    enabled = Column(Boolean, nullable=False, default=False)  # Whether ban policy is enabled
    risk_level = Column(String(20), nullable=False, default='high_risk')  # Risk level threshold (high_risk, medium_risk, low_risk)
    trigger_count = Column(Integer, nullable=False, default=3)  # Trigger count threshold (1-100)
    time_window_minutes = Column(Integer, nullable=False, default=10)  # Time window in minutes (1-1440)
    ban_duration_minutes = Column(Integer, nullable=False, default=60)  # Ban duration in minutes (1-10080)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="ban_policies")

class UserBanRecord(Base):
    """User ban records table"""
    __tablename__ = "user_ban_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    user_id = Column(String(255), nullable=False)  # User identifier (from request header or custom field)
    banned_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ban_until = Column(DateTime(timezone=True), nullable=False)  # Ban expiration time
    trigger_count = Column(Integer, nullable=False)  # Number of risk triggers that led to ban
    risk_level = Column(String(20), nullable=False)  # Risk level that triggered the ban
    reason = Column(Text)  # Ban reason
    is_active = Column(Boolean, nullable=False, default=True)  # Whether ban is currently active
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="user_ban_records")

class UserRiskTrigger(Base):
    """User risk trigger history table"""
    __tablename__ = "user_risk_triggers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
    user_id = Column(String(255), nullable=False)  # User identifier
    detection_result_id = Column(String(64))  # Associated detection result request ID
    risk_level = Column(String(20), nullable=False)  # Risk level of this trigger
    triggered_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="user_risk_triggers")

class TenantKnowledgeBaseDisable(Base):
    """Tenant knowledge base disable table - allows tenants to disable global knowledge bases"""
    __tablename__ = "tenant_kb_disables"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    kb_id = Column(Integer, ForeignKey("knowledge_bases.id"), nullable=False, index=True)
    disabled_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    knowledge_base = relationship("KnowledgeBase")

    # Unique constraint
    __table_args__ = (
        UniqueConstraint('tenant_id', 'kb_id', name='_tenant_kb_disable_uc'),
    )

class TenantSubscription(Base):
    """Tenant subscription and billing table"""
    __tablename__ = "tenant_subscriptions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, unique=True, index=True)
    subscription_type = Column(String(20), nullable=False, default='free', index=True)  # 'free' or 'subscribed'
    monthly_quota = Column(Integer, nullable=False, default=10000)  # Monthly API call quota
    current_month_usage = Column(Integer, nullable=False, default=0)  # Current month usage
    usage_reset_at = Column(DateTime(timezone=True), nullable=False)  # Next reset date (1st of next month)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")


# =====================================================
# Scanner Package System Models
# =====================================================

class ScannerPackage(Base):
    """Scanner package metadata"""
    __tablename__ = "scanner_packages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    package_code = Column(String(100), nullable=False, index=True)
    package_name = Column(String(200), nullable=False)
    author = Column(String(200), nullable=False, default='OpenGuardrails')
    description = Column(Text)
    version = Column(String(50), nullable=False, default='1.0.0')
    license = Column(String(100), default='proprietary')

    # Package type
    package_type = Column(String(50), nullable=False)  # 'builtin', 'purchasable'
    is_official = Column(Boolean, nullable=False, default=True)
    requires_purchase = Column(Boolean, nullable=False, default=False)

    # Purchase settings (for purchasable packages)
    price = Column(Float, nullable=True)  # Original price as number for dynamic display
    price_display = Column(String(100))   # Fallback display text
    file_path = Column(String(512))

    # Metadata
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    archived = Column(Boolean, nullable=False, default=False, index=True)  # Archive status
    archive_reason = Column(Text)  # Reason for archiving
    archived_at = Column(DateTime(timezone=True))  # Archive timestamp
    archived_by = Column(UUID(as_uuid=True), ForeignKey("tenants.id"))  # Admin who archived
    display_order = Column(Integer, default=0)
    scanner_count = Column(Integer, default=0)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    scanners = relationship("Scanner", back_populates="package", cascade="all, delete-orphan")
    purchases = relationship("PackagePurchase", back_populates="package", cascade="all, delete-orphan")


class Scanner(Base):
    """Individual scanner definition"""
    __tablename__ = "scanners"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    package_id = Column(UUID(as_uuid=True), ForeignKey("scanner_packages.id", ondelete="CASCADE"))

    # Scanner identification
    tag = Column(String(50), unique=True, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text)

    # Scanner configuration
    scanner_type = Column(String(50), nullable=False)  # 'genai', 'regex', 'keyword'
    definition = Column(Text, nullable=False)

    # Default behavior (package defaults)
    default_risk_level = Column(String(20), nullable=False)  # 'high_risk', 'medium_risk', 'low_risk'
    default_scan_prompt = Column(Boolean, nullable=False, default=True)
    default_scan_response = Column(Boolean, nullable=False, default=True)

    # Metadata
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    display_order = Column(Integer, default=0)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    package = relationship("ScannerPackage", back_populates="scanners")
    configs = relationship("ApplicationScannerConfig", back_populates="scanner", cascade="all, delete-orphan")
    custom_scanners = relationship("CustomScanner", back_populates="scanner", cascade="all, delete-orphan")


class ApplicationScannerConfig(Base):
    """Per-application scanner configuration overrides"""
    __tablename__ = "application_scanner_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)
    scanner_id = Column(UUID(as_uuid=True), ForeignKey("scanners.id", ondelete="CASCADE"), nullable=False, index=True)

    # Override settings (NULL = use package defaults)
    is_enabled = Column(Boolean, nullable=False, default=True)
    risk_level_override = Column(String(20))  # NULL = use default_risk_level
    scan_prompt_override = Column(Boolean)     # NULL = use default_scan_prompt
    scan_response_override = Column(Boolean)   # NULL = use default_scan_response

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    application = relationship("Application")
    scanner = relationship("Scanner", back_populates="configs")

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', 'scanner_id', name='uq_app_scanner_config'),
    )


class PackagePurchase(Base):
    """Package purchase tracking"""
    __tablename__ = "package_purchases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    package_id = Column(UUID(as_uuid=True), ForeignKey("scanner_packages.id", ondelete="CASCADE"), nullable=False, index=True)

    # Purchase lifecycle
    status = Column(String(50), nullable=False, default='pending', index=True)  # 'pending', 'approved', 'rejected'
    request_email = Column(String(255))
    request_message = Column(Text)

    # Admin actions
    approved_by = Column(UUID(as_uuid=True), ForeignKey("tenants.id"))
    approved_at = Column(DateTime(timezone=True))
    rejection_reason = Column(Text)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant", foreign_keys=[tenant_id])
    package = relationship("ScannerPackage", back_populates="purchases")
    approver = relationship("Tenant", foreign_keys=[approved_by])

    # Constraints
    __table_args__ = (
        UniqueConstraint('tenant_id', 'package_id', name='uq_tenant_package_purchase'),
    )


class CustomScanner(Base):
    """User-defined custom scanners (S100+)"""
    __tablename__ = "custom_scanners"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    application_id = Column(UUID(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)
    scanner_id = Column(UUID(as_uuid=True), ForeignKey("scanners.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)

    # Custom scanner metadata
    notes = Column(Text)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    application = relationship("Application")
    scanner = relationship("Scanner", back_populates="custom_scanners")
    creator = relationship("Tenant")

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', 'scanner_id', name='uq_app_custom_scanner'),
    )
