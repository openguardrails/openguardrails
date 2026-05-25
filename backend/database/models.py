from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, Date, JSON, ForeignKey, UniqueConstraint, Float, Numeric, Uuid, Index, Computed
# Phase 4a: switched from sqlalchemy.dialects.postgresql.UUID (PG-only,
# fails on MySQL with "syntax error near 'UUID NOT NULL'") to the
# SQLAlchemy 2.0 generic `Uuid` type. On PG this still compiles to the
# native UUID column type — bytes-on-disk and Python `uuid.UUID` objects
# at the boundary are identical to the previous behavior. On MySQL it
# compiles to CHAR(32) (hex, no dashes) with the same Python interface.
# All 124 UUID column declarations below now read `Uuid(as_uuid=True)`.
import uuid
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from database.connection import Base

class Tenant(Base):
    """租户表 (原用户表)"""
    __tablename__ = "tenants"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(128), nullable=False)
    is_active = Column(Boolean, default=False)  # After email verification, activate
    is_verified = Column(Boolean, default=False)  # Whether the email has been verified
    is_super_admin = Column(Boolean, default=False)  # Whether to be a super admin
    api_key = Column(String(64), unique=True, nullable=False, index=True)  # Deprecated: kept for backward compatibility, use api_keys table instead
    model_api_key = Column(String(64), unique=True, nullable=True, index=True)  # API key for direct model access (format: sk-xxai-model-{52 chars})
    log_direct_model_access = Column(Boolean, default=False, nullable=False)  # Whether to log direct model access calls (default: False for privacy)
    language = Column(String(10), default='en', nullable=False)  # User language preference
    # ID of the tenant who created this user. NULL means independent tenant (self-registered).
    # Non-NULL means sub-user created by another tenant (e.g., super admin).
    created_by_tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    applications = relationship("Application", back_populates="tenant", cascade="all, delete-orphan")
    workspaces = relationship("Workspace", back_populates="tenant", cascade="all, delete-orphan")
    detection_results = relationship("DetectionResult", back_populates="tenant")
    test_models = relationship("TestModelConfig", back_populates="tenant")
    blacklists = relationship("Blacklist", back_populates="tenant")
    whitelists = relationship("Whitelist", back_populates="tenant")
    response_templates = relationship("ResponseTemplate", back_populates="tenant")
    risk_config = relationship("RiskTypeConfig", back_populates="tenant", uselist=False)

    __table_args__ = (
        Index('idx_tenants_log_dma', 'log_direct_model_access'),
    )


class Workspace(Base):
    """Workspace table - Configuration containers that group applications.
    All config lives at workspace level. Global config = a workspace with is_global=True."""
    __tablename__ = "workspaces"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    owner = Column(String(255), nullable=True)
    enable_doublecheck = Column(Boolean, default=True, nullable=False)
    is_global = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Generated column: encodes the PG partial-unique
    # `(tenant_id) WHERE is_global = true` as a portable plain UNIQUE.
    # NULL when is_global = false → no constraint; otherwise = tenant_id, so
    # at most one global workspace per tenant.
    # No persisted= kwarg: lets PG render STORED (its only option) and MySQL
    # default to VIRTUAL. STORED would trigger MySQL's restriction on
    # ON DELETE CASCADE for FK columns referenced in stored gen-col expressions.
    global_tenant_key = Column(
        Uuid(as_uuid=True),
        Computed("CASE WHEN is_global THEN tenant_id END"),
    )

    # Association relationships
    tenant = relationship("Tenant", back_populates="workspaces")
    applications = relationship("Application", back_populates="workspace")

    __table_args__ = (
        UniqueConstraint('tenant_id', 'name', name='uq_workspaces_tenant_name'),
        UniqueConstraint('global_tenant_key', name='uq_workspaces_tenant_global'),
    )


class Application(Base):
    """Application table - Each tenant can have multiple applications"""
    __tablename__ = "applications"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="SET NULL"), nullable=True, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    is_active = Column(Boolean, default=True, nullable=False, index=True)
    # Source of application creation: 'manual' (UI/API) or 'auto_discovery' (gateway consumer)
    source = Column(String(32), default='manual', nullable=False)
    # External identifier for auto-discovered apps (e.g., gateway consumer name)
    external_id = Column(String(255), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="applications")
    workspace = relationship("Workspace", back_populates="applications")
    api_keys = relationship("ApiKey", back_populates="application", cascade="all, delete-orphan")
    blacklists = relationship("Blacklist", back_populates="application", cascade="all, delete-orphan")
    whitelists = relationship("Whitelist", back_populates="application", cascade="all, delete-orphan")
    response_templates = relationship("ResponseTemplate", back_populates="application", cascade="all, delete-orphan")
    risk_config = relationship("RiskTypeConfig", back_populates="application", uselist=False, cascade="all, delete-orphan")

    knowledge_bases = relationship("KnowledgeBase", back_populates="application", cascade="all, delete-orphan")
    data_security_entity_types = relationship("DataSecurityEntityType", back_populates="application", cascade="all, delete-orphan")
    # Note: upstream_api_configs relationship removed - Security Gateway configs are tenant-level, not application-specific
    test_models = relationship("TestModelConfig", back_populates="application", cascade="all, delete-orphan")
    rate_limits = relationship("TenantRateLimit", back_populates="application", cascade="all, delete-orphan")
    detection_results = relationship("DetectionResult", back_populates="application")
    appeal_config = relationship("AppealConfig", back_populates="application", uselist=False, cascade="all, delete-orphan")
    appeal_records = relationship("AppealRecord", back_populates="application", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint('tenant_id', 'name', name='uq_applications_tenant_name'),
        Index('idx_applications_external_id', 'tenant_id', 'external_id'),
    )


class ApiKey(Base):
    """API Key table - Each application can have multiple API keys"""
    __tablename__ = "api_keys"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)
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
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Associated tenant
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="SET NULL"), nullable=True, index=True)  # Associated application (nullable for historical data)
    content = Column(Text, nullable=False)
    original_content = Column(Text, nullable=True)  # Original unmasked content (NULL when no masking applied)
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
    # Unsafe content segments identified by second-pass detection
    # JSON array: [{"text": "...", "start": 0, "end": 10, "categories": ["S2"]}]
    unsafe_segments = Column(JSON, default=list)
    # Direct model access flag
    is_direct_model_access = Column(Boolean, default=False, index=True)  # Whether this is a direct model access call (not a guardrail check)
    # Detection source: guardrail_api, proxy, gateway, direct_model, content_scan
    source = Column(String(20), nullable=True, index=True)
    # Doublecheck fields: AI verification of unsafe detections
    doublecheck_result = Column(String(20), nullable=True)  # confirmed_unsafe, overturned_safe, or NULL
    doublecheck_categories = Column(JSON, nullable=True)  # Original categories before doublecheck
    doublecheck_reasoning = Column(Text, nullable=True)  # AI reasoning from doublecheck
    # Detection scope fields (content field stores actual detected content)
    detection_scope = Column(String(100), nullable=True)  # What was detected: all, last_message, user_only
    sliding_window_count = Column(Integer, nullable=True)  # Number of sliding windows used
    matched_window_indices = Column(JSON, nullable=True)  # Which windows matched [0, 2]
    # Audit field: complete original messages array (system + user/assistant + tool_calls + tool results),
    # before any role/content filtering or sliding-window truncation. Image base64 payloads are stripped.
    full_messages = Column(JSON, nullable=True)
    # Legacy messages column — predates `full_messages`, kept because the
    # column is still present in production PG. Newer writes use
    # `full_messages`; this stays in the model so MySQL deploys (which
    # bootstrap from Base.metadata) get the same shape as PG.
    messages = Column(JSON, nullable=True)
    # Comma-separated matched scanner tags (e.g. "S2,S5,S100"), written by
    # services/detection_guardrail_service.py:529 and read back at line 405.
    # Migration 016 added it as TEXT.
    matched_scanner_tags = Column(Text, nullable=True)

    # Association relationships
    tenant = relationship("Tenant", back_populates="detection_results")
    application = relationship("Application", back_populates="detection_results")
    categories = relationship(
        "DetectionResultCategory",
        back_populates="result",
        cascade="all, delete-orphan",
    )
    payload = relationship(
        "DetectionResultPayload",
        back_populates="result",
        uselist=False,
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index('idx_detection_results_tenant_created', 'tenant_id', created_at.desc()),
    )


class DetectionResultPayload(Base):
    """Sibling table for the heavy detection-data fields (Step 7.2).

    The detection_results table itself stays slim (metadata, risk levels,
    timestamps, IPs, source). Anything large or quote-prone — content,
    full_messages, model_response, image_paths, unsafe_segments,
    doublecheck artifacts — lives here. Two operational wins:

    1. Listing/dashboard scans never load the heavy data.
    2. Retention purge becomes a single DELETE against this sibling
       (ON DELETE CASCADE handles tenant/result deletion the other way).

    Phase 4a Step 7.2 ships this as a *parallel* table with dual-write
    in log_to_db_service. Reader migration off the legacy columns and
    eventual column drop on detection_results are follow-ups.
    """
    __tablename__ = "detection_result_payloads"

    # PK = FK so each detection_result has at most one payload row. CASCADE
    # so deleting a detection_result takes the payload with it.
    detection_result_id = Column(
        Integer,
        ForeignKey("detection_results.id", ondelete="CASCADE"),
        primary_key=True,
    )

    content = Column(Text, nullable=True)
    original_content = Column(Text, nullable=True)
    model_response = Column(Text, nullable=True)
    full_messages = Column(JSON, nullable=True)
    messages = Column(JSON, nullable=True)
    image_paths = Column(JSON, nullable=True)
    unsafe_segments = Column(JSON, nullable=True)
    doublecheck_categories = Column(JSON, nullable=True)
    doublecheck_reasoning = Column(Text, nullable=True)
    matched_window_indices = Column(JSON, nullable=True)

    result = relationship("DetectionResult", back_populates="payload")


class TenantDetectionStats(Base):
    """Daily rollup of detection counts per (tenant, application).

    Step 7.4: dashboard reads hit this rollup instead of scanning the
    full `detection_results` table. log_to_db_service increments these
    counters as it processes each detection (still off the hot path).

    Daily granularity, UTC date bucket. The dashboard does timezone
    shifting client-side. `application_id` is nullable for legacy
    rows where the detection wasn't tied to an application; the
    `application_key` generated column collapses NULL → sentinel UUID
    so the unique constraint on (tenant_id, application_key, date)
    enforces one row per bucket on both PG and MySQL.

    No FK to applications.id by design — if an application is deleted,
    its stats stay around for historical accuracy. Tenant FK with
    CASCADE so a deleted tenant's stats go with them.
    """
    __tablename__ = "tenant_detection_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    application_id = Column(Uuid(as_uuid=True), nullable=True)
    date = Column(Date, nullable=False)

    # Per-row counters. Each detection_result increments exactly one
    # high/medium/low/no row, plus one to total, plus one to each domain
    # (security/compliance/data) where the level is non-no_risk.
    total_count = Column(Integer, default=0, nullable=False)
    security_count = Column(Integer, default=0, nullable=False)
    compliance_count = Column(Integer, default=0, nullable=False)
    data_count = Column(Integer, default=0, nullable=False)
    high_risk_count = Column(Integer, default=0, nullable=False)
    medium_risk_count = Column(Integer, default=0, nullable=False)
    low_risk_count = Column(Integer, default=0, nullable=False)
    no_risk_count = Column(Integer, default=0, nullable=False)

    # Generated key collapses NULL application_id to a sentinel UUID so
    # `UNIQUE (tenant_id, application_key, date)` is enforceable on both
    # PG (NULLS DISTINCT default would otherwise allow multiple
    # tenant-level rows per date) and MySQL.
    application_key = Column(
        Uuid(as_uuid=True),
        Computed("COALESCE(application_id, '00000000000000000000000000000000')"),
    )

    __table_args__ = (
        UniqueConstraint('tenant_id', 'application_key', 'date',
                         name='uq_tenant_detection_stats_t_a_d'),
        Index('idx_tenant_detection_stats_tenant_date', 'tenant_id', 'date'),
    )


class DetectionResultCategory(Base):
    """Relational projection of detection_results.{security,compliance,data}_categories.

    Replaces PG-only `cast(security_categories, JSONB).contains([cat])`
    filtering in routers/results.py with portable JOIN-based queries.
    Each detection result with non-empty categories produces N rows here,
    one per category, scoped by `kind` ∈ {'security','compliance','data'}.

    Phase 4a write path: dual-write — log_to_db_service inserts both the
    JSON columns on `detection_results` (legacy readers) and the relational
    rows here (portable readers). Read path is switched in a follow-up PR
    once dual-write has baked.
    """
    __tablename__ = "detection_result_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    result_id = Column(
        Integer,
        ForeignKey("detection_results.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind = Column(String(20), nullable=False)  # 'security' | 'compliance' | 'data'
    category = Column(String(100), nullable=False)

    result = relationship("DetectionResult", back_populates="categories")

    __table_args__ = (
        Index('idx_drc_category_kind', 'category', 'kind'),
        UniqueConstraint('result_id', 'kind', 'category', name='uq_drc_result_kind_category'),
    )


class Blacklist(Base):
    """Blacklist table"""
    __tablename__ = "blacklist"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Associated tenant (kept for backward compatibility)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated application (nullable for workspace-level)
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated workspace (nullable for app-level)
    name = Column(String(100), nullable=False)  # Blacklist library name
    keywords = Column(JSON, nullable=False)  # Keywords list
    description = Column(Text)  # Description
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="blacklists")
    application = relationship("Application", back_populates="blacklists")
    workspace = relationship("Workspace")

class Whitelist(Base):
    """Whitelist table"""
    __tablename__ = "whitelist"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Associated tenant (kept for backward compatibility)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated application (nullable for workspace-level)
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated workspace (nullable for app-level)
    name = Column(String(100), nullable=False)  # Whitelist library name
    keywords = Column(JSON, nullable=False)  # Keywords list
    description = Column(Text)  # Description
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant", back_populates="whitelists")
    application = relationship("Application", back_populates="whitelists")
    workspace = relationship("Workspace")

class ResponseTemplate(Base):
    """Response template table - supports all scanner types"""
    __tablename__ = "response_templates"

    id = Column(Integer, primary_key=True, index=True)
    # Allow null: When it is a system-level default template, tenant_id is null
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=True, index=True)  # Associated tenant (can be null for global templates)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated application (nullable for global templates)

    # Legacy field: Risk category (S1-S21, default) - kept for backward compatibility
    category = Column(String(50), nullable=True, index=True)

    # New fields for unified scanner support
    scanner_type = Column(String(50), nullable=True, index=True)  # Scanner type: blacklist, whitelist, official_scanner, marketplace_scanner, custom_scanner
    scanner_identifier = Column(String(255), nullable=True)  # Scanner identifier: blacklist name, whitelist name, or scanner tag (S1, S2, S100, etc.)
    guardrail_name = Column(String(255), nullable=True)  # Guardrail human-readable name for display (e.g., "Bank Fraud", "Travel Discussion")
    # Legacy alias for guardrail_name. Migration 069 was supposed to
    # rename scanner_name → guardrail_name but the conditional rename
    # left both columns coexisting on the live DB. Kept here so MySQL
    # bootstrap from Base.metadata produces the same shape as PG; a
    # follow-up cleanup migration should drop one of the two.
    scanner_name = Column(String(255), nullable=True)

    risk_level = Column(String(20), nullable=False)  # Risk level
    template_content = Column(JSON, nullable=False)  # Multilingual response template content: {"en": "...", "zh": "...", ...}
    is_default = Column(Boolean, default=False)  # Whether it is a default template
    is_active = Column(Boolean, default=True)  # Whether enabled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Generated column: encodes the PG partial-unique
    # `(tenant_id, application_id, COALESCE(scanner_identifier, category)) WHERE scanner_name IS NOT NULL`
    # as a portable plain UNIQUE on a derived key. NULL when scanner_name is NULL → no constraint
    # (NULLs distinct on both PG and MySQL); otherwise = COALESCE(scanner_identifier, category).
    scanner_lookup_key = Column(
        String(255),
        Computed("CASE WHEN scanner_name IS NOT NULL THEN COALESCE(scanner_identifier, category) END"),
    )

    # Association relationships
    tenant = relationship("Tenant", back_populates="response_templates")
    application = relationship("Application", back_populates="response_templates")

    __table_args__ = (
        Index('idx_response_templates_guardrail_name', 'guardrail_name'),
        Index('idx_response_templates_scanner_lookup', 'scanner_type', 'scanner_identifier'),
        UniqueConstraint('tenant_id', 'application_id', 'category', name='idx_response_templates_unique_category'),
        UniqueConstraint('tenant_id', 'application_id', 'guardrail_name', name='idx_response_templates_unique_guardrail_name'),
        UniqueConstraint('tenant_id', 'application_id', 'scanner_identifier', name='idx_response_templates_unique_scanner_identifier'),
        UniqueConstraint('tenant_id', 'application_id', 'scanner_lookup_key', name='idx_response_templates_unique_tenant_app_scanner'),
    )

class TenantSwitch(Base):
    """Tenant switch record table (for super admin to switch tenant perspective)"""
    __tablename__ = "tenant_switches"

    id = Column(Integer, primary_key=True, index=True)
    admin_tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False)  # Admin tenant ID
    target_tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False)  # Target tenant ID
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
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True, unique=True)  # Associated application (nullable for workspace-level)
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated workspace (nullable for app-level)

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
    workspace = relationship("Workspace")

    __table_args__ = (
        UniqueConstraint('workspace_id', name='uq_risk_type_config_workspace'),
    )

class TenantRateLimit(Base):
    """Tenant rate limit config table"""
    __tablename__ = "tenant_rate_limits"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Associated application
    requests_per_second = Column(Integer, default=10, nullable=False)  # Requests per second, 0 means no limit
    monthly_scan_limit = Column(Integer, default=10000, nullable=False)  # Monthly scan limit, 0 means no limit
    current_month_usage = Column(Integer, default=0, nullable=False)  # Current month usage count
    usage_reset_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)  # Usage counter reset time (start of current month)
    is_active = Column(Boolean, default=True, index=True)  # Whether to enable rate limiting
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="rate_limits")

    __table_args__ = (
        Index('ix_tenant_rate_limits_usage_reset_at', 'usage_reset_at'),
        Index('uq_tenant_rate_limits_application', 'application_id', unique=True),
    )


class TenantRateLimitCounter(Base):
    """Tenant real-time rate limit counter table - for cross-process rate limiting"""
    __tablename__ = "tenant_rate_limit_counters"

    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), primary_key=True, index=True)
    current_count = Column(Integer, default=0, nullable=False)  # Requests count in current window
    window_start = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)  # Window start time
    last_updated = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)  # Last updated time

    # Association relationships
    tenant = relationship("Tenant")

class TestModelConfig(Base):
    """Proxy model config table"""
    __tablename__ = "test_model_configs"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application
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

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)  # Used in gateway URL
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Tenant-level configuration
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=False)  # DEPRECATED: Always NULL. Applications are determined by API key when calling gateway
    config_name = Column(String(100), nullable=False, index=True)  # Display name (e.g., "OpenAI Production")
    api_base_url = Column(String(512), nullable=False)  # Upstream API base URL
    api_key_encrypted = Column(Text, nullable=False)  # Encrypted upstream API key
    provider = Column(String(50))  # Provider type: openai, anthropic, local, etc.
    is_active = Column(Boolean, default=True, index=True)  # Whether this config is active

    # Security config
    enable_reasoning_detection = Column(Boolean, default=True)  # Whether to detect reasoning content
    stream_chunk_size = Column(Integer, default=50)  # Stream detection interval, detect every N chunks

    # Private model attributes (for Data Masking)
    is_private_model = Column(Boolean, default=False, index=True)  # Whether this model is private (on-premise/data-safe)
    is_default_private_model = Column(Boolean, default=False, index=True)  # Whether this is the default private model for tenant
    private_model_names = Column(JSON, default=list)  # Model names available for automatic switching (e.g., ["gpt-4", "gpt-4-turbo"])
    default_private_model_name = Column(String(255), nullable=True)  # The specific model name to use when this is the default private model
    higress_cluster = Column(String(255), nullable=True)  # Higress cluster name for routing (e.g., outbound|443||private-llm.dns)
    # Legacy / docs alias for is_private_model. Migration 041 was supposed
    # to rename is_data_safe → is_private_model but the conditional rename
    # left both columns on the live DB. Still referenced by
    # routers/proxy_management.py audit-tracked fields. Kept so MySQL
    # bootstrap matches PG; a follow-up cleanup should drop one of the two.
    is_data_safe = Column(Boolean, default=False, nullable=True)
    # Priority for private-model selection (higher = preferred). Documented
    # in CLAUDE.md as part of the Private Model Selection Priority chain;
    # added by migration 038 as INTEGER DEFAULT 0.
    private_model_priority = Column(Integer, default=0, nullable=True)

    # Metadata
    description = Column(Text)  # Optional description
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    # Note: application relationship removed - Security Gateway configs are tenant-level, not application-specific

    __table_args__ = (
        UniqueConstraint('tenant_id', 'config_name', name='upstream_api_configs_tenant_name_unique'),
        Index('idx_upstream_api_configs_private_model', 'tenant_id', 'is_private_model'),
    )

class ProxyModelConfig(Base):
    """DEPRECATED: Reverse proxy model config table (replaced by UpstreamApiConfig)"""
    __tablename__ = "proxy_model_configs_deprecated"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    config_name = Column(String(100), nullable=False, index=True)  # Proxy model name, for model parameter matching
    api_base_url = Column(String(512), nullable=False)  # Upstream API base URL
    api_key_encrypted = Column(Text, nullable=False)  # Encrypted upstream API key
    model_name = Column(String(255), nullable=False)  # Upstream API model name
    enabled = Column(Boolean, default=True, index=True)  # Whether enabled

    # Security config (simplified design)
    enable_reasoning_detection = Column(Boolean, default=True)  # Whether to detect reasoning content, default enabled
    stream_chunk_size = Column(Integer, default=50)  # Stream detection interval, detect every N chunks, default 50

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")

class ProxyRequestLog(Base):
    """Reverse proxy request log table"""
    __tablename__ = "proxy_request_logs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    request_id = Column(String(64), unique=True, nullable=False, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)

    # New foreign key to upstream_api_configs
    upstream_api_config_id = Column(Uuid(as_uuid=True), ForeignKey("upstream_api_configs.id", ondelete="SET NULL"), index=True)

    # Old foreign key (deprecated, kept for backward compatibility)
    proxy_config_id = Column(Uuid(as_uuid=True), ForeignKey("proxy_model_configs_deprecated.id"), nullable=True)

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
    """Knowledge base table - supports all scanner types"""
    __tablename__ = "knowledge_bases"

    id = Column(Integer, primary_key=True, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)  # Associated application

    # Legacy field: Risk category (S1-S21) - kept for backward compatibility
    category = Column(String(50), nullable=True, index=True)

    # New fields for unified scanner support
    scanner_type = Column(String(50), nullable=True, index=True)  # Scanner type: blacklist, whitelist, official_scanner, marketplace_scanner, custom_scanner
    scanner_identifier = Column(String(255), nullable=True)  # Scanner identifier: blacklist name, whitelist name, or scanner tag (S1, S2, S100, etc.)
    guardrail_name = Column(String(255), nullable=True)  # Guardrail human-readable name for display (e.g., "Bank Fraud", "Travel Discussion")
    # Legacy alias for guardrail_name — see ResponseTemplate.scanner_name
    # for the same backstory (migration 069 conditional rename).
    scanner_name = Column(String(255), nullable=True)

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

    __table_args__ = (
        Index('idx_knowledge_bases_guardrail_name', 'guardrail_name'),
        Index('idx_knowledge_bases_scanner_lookup', 'scanner_type', 'scanner_identifier'),
    )

class OnlineTestModelSelection(Base):
    """Online test model selection table - record the proxy model selected by the tenant in online test"""
    __tablename__ = "online_test_model_selections"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    proxy_model_id = Column(Uuid(as_uuid=True), ForeignKey("upstream_api_configs.id"), nullable=False, index=True)
    selected = Column(Boolean, default=False, nullable=False)  # Whether it is selected for online test
    model_name = Column(String(200), nullable=True)  # Model name specified by user for testing

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    proxy_model = relationship("UpstreamApiConfig")

    # Add unique constraint, ensure each tenant has only one record for each proxy model
    __table_args__ = (
        UniqueConstraint('tenant_id', 'proxy_model_id', name='_tenant_proxy_model_selection_uc'),
    )

class DataSecurityEntityType(Base):
    """Data security entity type config table - workspace-level"""
    __tablename__ = "data_security_entity_types"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)  # Kept for backward compatibility
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Deprecated: kept for backward compatibility
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Config lives at workspace level
    entity_type = Column(String(100), nullable=False, index=True)  # Entity type code, such as ID_CARD_NUMBER
    entity_type_name = Column(String(200), nullable=False)  # Entity type name, such as "ID Card Number"
    category = Column(String(50), nullable=False, index=True)  # Risk level: low, medium, high
    recognition_method = Column(String(20), nullable=False)  # Recognition method: regex
    recognition_config = Column(JSON, nullable=False)  # Recognition config, such as {"pattern": "...", "check_input": true, "check_output": true}
    anonymization_method = Column(String(20), default='replace')  # Anonymization method: replace, mask, hash, encrypt, shuffle, random
    anonymization_config = Column(JSON)  # Anonymization config, such as {"replacement": "<ID_CARD>"}
    is_active = Column(Boolean, default=True, index=True)  # Whether enabled
    is_global = Column(Boolean, default=False, index=True)  # Whether it is a global config (deprecated, use source_type instead)
    source_type = Column(String(20), default='custom', index=True)  # Source type: 'system_template', 'system_copy', 'custom'
    template_id = Column(Uuid(as_uuid=True), index=True, nullable=True)  # Template ID if copied from a template

    # GenAI code anonymization fields (for anonymization_method='genai_code')
    # These are used when the anonymization_method is 'genai_code' to execute custom AI-generated Python code
    restore_code = Column(Text, nullable=True)  # AI-generated Python code for genai_code anonymization
    restore_code_hash = Column(String(64), nullable=True)  # SHA-256 hash for code integrity verification
    restore_natural_desc = Column(Text, nullable=True)  # Natural language description used to generate the code

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="data_security_entity_types")
    workspace = relationship("Workspace")

    __table_args__ = (
        UniqueConstraint('workspace_id', 'entity_type', name='uq_data_security_entity_types_ws_entity'),
    )

class TenantEntityTypeDisable(Base):
    """Entity type disable table - workspace-level"""
    __tablename__ = "tenant_entity_type_disables"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id"), nullable=True, index=True)  # Deprecated
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Config lives at workspace level
    entity_type = Column(String(100), nullable=False, index=True)  # Entity type code, such as ID_CARD_NUMBER_SYS
    disabled_at = Column(DateTime(timezone=True), server_default=func.now())
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    application = relationship("Application")
    workspace = relationship("Workspace")

    # Unique constraint - workspace-level disabling
    __table_args__ = (
        UniqueConstraint('tenant_id', 'application_id', 'entity_type', name='_tenant_app_entity_type_disable_uc'),
    )


class TenantKnowledgeBaseDisable(Base):
    """Tenant knowledge base disable table - allows tenants to disable global knowledge bases"""
    __tablename__ = "tenant_kb_disables"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
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

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, unique=True, index=True)
    subscription_type = Column(String(20), nullable=False, default='free', index=True)  # 'free' or 'subscribed'
    monthly_quota = Column(Integer, nullable=False, default=1000)  # Monthly API call quota (default for free plan)
    current_month_usage = Column(Integer, nullable=False, default=0)  # Current month usage
    usage_reset_at = Column(DateTime(timezone=True), nullable=False)  # Next reset date (1st of next month)

    # Tier info
    subscription_tier = Column(Integer, default=0, index=True)  # tier 0 = free, 1-9 = paid tiers

    # Payment provider IDs
    stripe_customer_id = Column(String(255), index=True)  # Stripe customer ID
    alipay_user_id = Column(String(255), index=True)  # Alipay user ID
    alipay_agreement_no = Column(String(255))  # Alipay recurring billing agreement number (周期扣款)

    # Purchased quota (pay-per-use for Chinese users)
    purchased_quota = Column(Integer, default=0, nullable=False)
    purchased_quota_expires_at = Column(DateTime(timezone=True))

    # Subscription dates
    subscription_started_at = Column(DateTime(timezone=True))  # When subscription started
    subscription_expires_at = Column(DateTime(timezone=True))  # When subscription expires

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Association relationships
    tenant = relationship("Tenant")

    __table_args__ = (
        Index('idx_tenant_subs_pq_expires', 'purchased_quota_expires_at'),
    )


class SubscriptionTier(Base):
    """Subscription tier reference table - defines available pricing tiers"""
    __tablename__ = "subscription_tiers"

    id = Column(Integer, primary_key=True, index=True)
    tier_number = Column(Integer, unique=True, nullable=False, index=True)
    tier_name = Column(String(100), nullable=False)
    monthly_quota = Column(Integer, nullable=False)
    price_usd = Column(Numeric(10, 2), nullable=False)
    price_cny = Column(Numeric(10, 2), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True)
    display_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# =====================================================
# Scanner Package System Models
# =====================================================

class ScannerPackage(Base):
    """Scanner package metadata"""
    __tablename__ = "scanner_packages"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    package_code = Column(String(100), nullable=False, index=True)
    package_name = Column(String(200), nullable=False)
    author = Column(String(200), nullable=False, default='OpenGuardrails')
    description = Column(Text)
    version = Column(String(50), nullable=False, default='1.0.0')
    license = Column(String(100), default='proprietary')

    # Package type
    package_type = Column(String(50), nullable=False)  # 'basic', 'premium' (formerly 'builtin', 'purchasable')
    is_official = Column(Boolean, nullable=False, default=True)
    requires_purchase = Column(Boolean, nullable=False, default=False)

    # Purchase settings (for premium packages)
    price = Column(Float, nullable=True)  # Original price as number for dynamic display
    price_display = Column(String(100))   # Fallback display text
    bundle = Column(String(100))          # Bundle name for grouping (e.g., Enterprise, Security)
    file_path = Column(String(512))

    # Metadata
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    archived = Column(Boolean, nullable=False, default=False, index=True)  # Archive status
    archive_reason = Column(Text)  # Reason for archiving
    archived_at = Column(DateTime(timezone=True))  # Archive timestamp
    archived_by = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"))  # Admin who archived
    display_order = Column(Integer, default=0)
    scanner_count = Column(Integer, default=0)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Generated column: encodes the PG partial-unique
    # `(package_code) WHERE is_active = true AND archived = false` as a portable
    # plain UNIQUE on a derived key. NULL when the row is inactive/archived
    # → no constraint; otherwise = package_code.
    active_package_code = Column(
        String(100),
        Computed("CASE WHEN is_active AND NOT archived THEN package_code END"),
    )

    # Relationships
    scanners = relationship("Scanner", back_populates="package", cascade="all, delete-orphan")
    purchases = relationship("PackagePurchase", back_populates="package", cascade="all, delete-orphan")

    __table_args__ = (
        Index('idx_scanner_packages_bundle', 'bundle'),
        Index('idx_scanner_packages_not_archived', 'is_active', 'archived'),
        Index('idx_scanner_packages_type', 'package_type'),
        Index('idx_scanner_packages_active_code', 'package_code', 'is_active', 'archived'),
        Index('idx_scanner_packages_archived', 'package_code', 'archived_at'),
        UniqueConstraint('active_package_code', name='idx_scanner_packages_active_code_unique'),
    )


class Scanner(Base):
    """Individual scanner definition"""
    __tablename__ = "scanners"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    package_id = Column(Uuid(as_uuid=True), ForeignKey("scanner_packages.id", ondelete="CASCADE"))

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

    __table_args__ = (
        Index('idx_scanners_package', 'package_id'),
        Index('idx_scanners_type', 'scanner_type'),
    )


class ApplicationScannerConfig(Base):
    """Per-application/workspace scanner configuration overrides"""
    __tablename__ = "application_scanner_configs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Nullable for workspace-level
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Nullable for app-level
    scanner_id = Column(Uuid(as_uuid=True), ForeignKey("scanners.id", ondelete="CASCADE"), nullable=False, index=True)

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
    workspace = relationship("Workspace")
    scanner = relationship("Scanner", back_populates="configs")

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', 'scanner_id', name='uq_app_scanner_config'),
        UniqueConstraint('workspace_id', 'scanner_id', name='uq_app_scanner_configs_workspace_scanner'),
        Index('idx_app_scanner_configs_enabled', 'application_id', 'is_enabled'),
    )


class TenantDataLeakagePolicy(Base):
    """Tenant-level default Data Masking policies"""
    __tablename__ = "tenant_data_leakage_policies"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)

    # Input Policy Defaults (prevent external data masking)
    # Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    default_input_high_risk_action = Column(String(50), default='block', nullable=False)
    default_input_medium_risk_action = Column(String(50), default='anonymize', nullable=False)
    default_input_low_risk_action = Column(String(50), default='anonymize', nullable=False)

    # Output Policy Defaults (prevent internal unauthorized access)
    # Boolean flags: whether to anonymize output for each risk level (legacy, kept for backward compatibility)
    default_output_high_risk_anonymize = Column(Boolean, default=True, nullable=False)
    default_output_medium_risk_anonymize = Column(Boolean, default=True, nullable=False)
    default_output_low_risk_anonymize = Column(Boolean, default=False, nullable=False)

    # Output Policy Defaults - Action type (same as input policy)
    # Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    default_output_high_risk_action = Column(String(50), default='block', nullable=False)
    default_output_medium_risk_action = Column(String(50), default='anonymize', nullable=False)
    default_output_low_risk_action = Column(String(50), default='pass', nullable=False)

    # General Risk Policy Defaults (security, safety, company policy violations)
    # Actions: 'block' | 'replace' (use knowledge base/template) | 'pass' (log only)
    # Legacy fields (kept for backward compatibility)
    default_general_high_risk_action = Column(String(50), default='block', nullable=False)
    default_general_medium_risk_action = Column(String(50), default='replace', nullable=False)
    default_general_low_risk_action = Column(String(50), default='pass', nullable=False)

    # General Risk Policy - Input Defaults
    default_general_input_high_risk_action = Column(String(50), default='block', nullable=False)
    default_general_input_medium_risk_action = Column(String(50), default='replace', nullable=False)
    default_general_input_low_risk_action = Column(String(50), default='pass', nullable=False)

    # General Risk Policy - Output Defaults
    default_general_output_high_risk_action = Column(String(50), default='block', nullable=False)
    default_general_output_medium_risk_action = Column(String(50), default='replace', nullable=False)
    default_general_output_low_risk_action = Column(String(50), default='pass', nullable=False)

    # Default Feature Flags
    default_enable_format_detection = Column(Boolean, default=True, nullable=False)
    default_enable_smart_segmentation = Column(Boolean, default=True, nullable=False)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant", backref="data_leakage_policy")
    # Note: Default private model is determined by upstream_api_configs.is_default_private_model = true


class ApplicationDataLeakagePolicy(Base):
    """Application/workspace-level data masking policy overrides. NULL values inherit from workspace/tenant defaults."""
    __tablename__ = "application_data_leakage_policies"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Nullable for workspace-level
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Nullable for app-level

    # Input Policy Overrides (prevent external data masking)
    # Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    # NULL = use tenant default
    input_high_risk_action = Column(String(50), default=None, nullable=True)
    input_medium_risk_action = Column(String(50), default=None, nullable=True)
    input_low_risk_action = Column(String(50), default=None, nullable=True)

    # Output Policy Overrides (prevent internal unauthorized access)
    # Boolean flags: whether to anonymize output for each risk level (legacy, kept for backward compatibility)
    # NULL = use tenant default
    output_high_risk_anonymize = Column(Boolean, default=None, nullable=True)
    output_medium_risk_anonymize = Column(Boolean, default=None, nullable=True)
    output_low_risk_anonymize = Column(Boolean, default=None, nullable=True)

    # Output Policy Overrides - Action type (same as input policy)
    # Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    # NULL = use tenant default
    output_high_risk_action = Column(String(50), default=None, nullable=True)
    output_medium_risk_action = Column(String(50), default=None, nullable=True)
    output_low_risk_action = Column(String(50), default=None, nullable=True)

    # General Risk Policy Overrides (security, safety, company policy violations)
    # Actions: 'block' | 'replace' (use knowledge base/template) | 'pass' (log only)
    # NULL = use tenant default
    # Legacy fields (kept for backward compatibility)
    general_high_risk_action = Column(String(50), default=None, nullable=True)
    general_medium_risk_action = Column(String(50), default=None, nullable=True)
    general_low_risk_action = Column(String(50), default=None, nullable=True)

    # General Risk Policy - Input Overrides
    general_input_high_risk_action = Column(String(50), default=None, nullable=True)
    general_input_medium_risk_action = Column(String(50), default=None, nullable=True)
    general_input_low_risk_action = Column(String(50), default=None, nullable=True)

    # General Risk Policy - Output Overrides
    general_output_high_risk_action = Column(String(50), default=None, nullable=True)
    general_output_medium_risk_action = Column(String(50), default=None, nullable=True)
    general_output_low_risk_action = Column(String(50), default=None, nullable=True)

    # Private model configuration (nullable if using tenant's default)
    private_model_id = Column(Uuid(as_uuid=True), ForeignKey("upstream_api_configs.id", ondelete="SET NULL"), nullable=True)

    # Feature flags (NULL = use tenant default)
    enable_format_detection = Column(Boolean, default=None, nullable=True)
    enable_smart_segmentation = Column(Boolean, default=None, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")
    application = relationship("Application")
    workspace = relationship("Workspace")
    private_model = relationship("UpstreamApiConfig", foreign_keys=[private_model_id])

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', name='uq_application_data_leakage_policy'),
        UniqueConstraint('workspace_id', name='uq_app_dlp_workspace'),
    )


class ApplicationSettings(Base):
    """Application/workspace-level settings including fixed answer templates"""
    __tablename__ = "application_settings"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Nullable for workspace-level
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Nullable for app-level

    # Fixed Answer Templates (stored as JSONB with language keys)
    # Format: {"en": "English template", "zh": "中文模板"}
    security_risk_template = Column(JSON, default={
        "en": "Request blocked by OpenGuardrails due to possible violation of policy related to {guardrail_name}.",
        "zh": "请求已被OpenGuardrails拦截，原因：可能违反了与{guardrail_name}有关的策略要求。"
    })
    data_leakage_template = Column(JSON, default={
        "en": "Request blocked by OpenGuardrails due to possible sensitive data ({entity_type_names}).",
        "zh": "请求已被OpenGuardrails拦截，原因：可能包含敏感数据（{entity_type_names}）。"
    })

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")
    application = relationship("Application")
    workspace = relationship("Workspace")

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', name='uq_application_settings_app'),
        UniqueConstraint('workspace_id', name='uq_app_settings_workspace'),
    )


class PackagePurchase(Base):
    """
    Package purchase tracking.
    
    Modern flow (with payment system):
    - Paid packages: Payment completed -> auto-approved (status='approved')
    - Free packages: Direct purchase -> auto-approved (status='approved')
    
    Legacy flow (deprecated):
    - Manual request -> admin review -> approved/rejected
    """
    __tablename__ = "package_purchases"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    package_id = Column(Uuid(as_uuid=True), ForeignKey("scanner_packages.id", ondelete="CASCADE"), nullable=False, index=True)

    # Purchase lifecycle
    status = Column(String(50), nullable=False, default='pending', index=True)  # 'pending', 'approved', 'rejected'
    request_email = Column(String(255))
    request_message = Column(Text)

    # Admin actions (used in legacy manual approval flow)
    approved_by = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"))
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
    """User-defined custom scanners (S100+) - workspace-level"""
    __tablename__ = "custom_scanners"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)  # Deprecated
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)  # Config lives at workspace level
    scanner_id = Column(Uuid(as_uuid=True), ForeignKey("scanners.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=False, index=True)

    # Custom scanner metadata
    notes = Column(Text)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    application = relationship("Application")
    workspace = relationship("Workspace")
    scanner = relationship("Scanner", back_populates="custom_scanners")
    creator = relationship("Tenant")

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', 'scanner_id', name='uq_app_custom_scanner'),
        UniqueConstraint('workspace_id', 'scanner_id', name='uq_custom_scanners_ws_scanner'),
    )


# =====================================================
# Payment System Models
# =====================================================

class PaymentOrder(Base):
    """Payment order table - stores all payment transactions"""
    __tablename__ = "payment_orders"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    order_type = Column(String(50), nullable=False, index=True)  # 'subscription' or 'package'
    amount = Column(Float, nullable=False)
    currency = Column(String(10), nullable=False)  # 'CNY' or 'USD'
    payment_provider = Column(String(50), nullable=False, index=True)  # 'alipay' or 'stripe'
    status = Column(String(50), nullable=False, default='pending', index=True)  # 'pending', 'paid', 'failed', 'refunded', 'cancelled'

    # Provider-specific IDs
    provider_order_id = Column(String(255), index=True)  # Our order ID sent to provider
    provider_transaction_id = Column(String(255), index=True)  # Transaction ID from provider

    # For package purchases
    package_id = Column(Uuid(as_uuid=True), ForeignKey("scanner_packages.id", ondelete="SET NULL"), index=True)

    # Provider session/transaction IDs hoisted from order_metadata for portable
    # indexed lookup. Replaces PG-only `order_metadata->>'stripe_session_id'`
    # and `->>'trade_no'` text expressions in routers/payment_api.py. Dual
    # purpose: the JSON column still carries the rest of the metadata, but
    # the lookups go through these indexed columns now.
    stripe_session_id = Column(String(255), nullable=True, index=True)
    trade_no = Column(String(255), nullable=True, index=True)

    # Additional metadata
    order_metadata = Column(JSON, default={})

    # Timestamps
    paid_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")
    package = relationship("ScannerPackage")

    __table_args__ = (
        Index('idx_payment_orders_created_at', 'created_at'),
    )


class SubscriptionPayment(Base):
    """Subscription payment table - tracks recurring subscription payments"""
    __tablename__ = "subscription_payments"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    payment_order_id = Column(Uuid(as_uuid=True), ForeignKey("payment_orders.id", ondelete="SET NULL"), index=True)

    # Billing cycle
    billing_cycle_start = Column(DateTime(timezone=True), nullable=False)
    billing_cycle_end = Column(DateTime(timezone=True), nullable=False)

    # Provider-specific subscription IDs
    stripe_subscription_id = Column(String(255), index=True)
    stripe_customer_id = Column(String(255), index=True)
    alipay_agreement_id = Column(String(255), index=True)

    # Status
    status = Column(String(50), nullable=False, default='active', index=True)  # 'active', 'cancelled', 'expired', 'past_due'
    cancel_at_period_end = Column(Boolean, default=False)

    # Next payment info
    next_payment_date = Column(DateTime(timezone=True), index=True)
    next_payment_amount = Column(Float)

    # Timestamps
    cancelled_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Generated column: encodes the PG partial-unique
    # `(tenant_id) WHERE status = 'active'` as a portable plain UNIQUE.
    # NULL when status != 'active' → no constraint; otherwise = tenant_id, so
    # at most one active subscription per tenant.
    active_tenant_key = Column(
        Uuid(as_uuid=True),
        Computed("CASE WHEN status = 'active' THEN tenant_id END"),
    )

    # Relationships
    tenant = relationship("Tenant")
    payment_order = relationship("PaymentOrder")

    __table_args__ = (
        UniqueConstraint('active_tenant_key', name='idx_subscription_payments_tenant_active'),
    )


# =====================================================
# Appeal System Models
# =====================================================

class AppealConfig(Base):
    """Appeal configuration table - per-application or per-workspace settings for false positive appeals"""
    __tablename__ = "appeal_config"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=True, index=True)
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True, index=True)
    enabled = Column(Boolean, nullable=False, default=False)
    # Template for appeal link message, supports {appeal_url} placeholder
    # Note: Default value uses English. Localized defaults are provided via i18n when config is first displayed.
    message_template = Column(Text, nullable=False, default='If you think this is a false positive, please click the following link to appeal: {appeal_url}')
    # Base URL for appeal links (e.g., https://domain.com or http://192.168.1.100:5001)
    appeal_base_url = Column(String(512), nullable=False, default='')
    # Final reviewer email - when AI considers it a true positive, send email for human review
    final_reviewer_email = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Generated column: encodes the PG partial-unique
    # `(workspace_id) WHERE workspace_id IS NOT NULL AND application_id IS NULL`
    # as a portable plain UNIQUE on a derived key. workspace_only_id = workspace_id
    # only for workspace-scoped rows (application_id IS NULL); NULL otherwise →
    # no constraint on app-scoped or fully-global rows.
    workspace_only_id = Column(
        Uuid(as_uuid=True),
        Computed("CASE WHEN application_id IS NULL THEN workspace_id END"),
    )

    # Relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="appeal_config")
    workspace = relationship("Workspace")

    # Constraints
    __table_args__ = (
        UniqueConstraint('application_id', name='uq_appeal_config_application'),
        UniqueConstraint('workspace_only_id', name='uq_appeal_config_workspace'),
    )


class AppealRecord(Base):
    """Appeal records table - tracks false positive appeal requests and reviews"""
    __tablename__ = "appeal_records"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)
    request_id = Column(String(64), nullable=False, unique=True, index=True)  # Original detection request_id (guardrails-xxx)
    user_id = Column(String(255), index=True)  # User who triggered the detection

    # Original detection info (denormalized for review)
    original_content = Column(Text, nullable=False)
    original_risk_level = Column(String(20), nullable=False)
    original_categories = Column(JSON, nullable=False)
    original_suggest_action = Column(String(20), nullable=False)

    # Review status: pending, reviewing, pending_review, approved, rejected
    # pending_review: AI rejected, waiting for human final review
    status = Column(String(20), nullable=False, default='pending', index=True)

    # AI review results
    ai_review_result = Column(Text)  # AI reasoning output
    ai_approved = Column(Boolean)  # AI decision: true=false positive confirmed (NOT actual violation)
    ai_reviewed_at = Column(DateTime(timezone=True))

    # Human review fields
    processor_type = Column(String(20), nullable=True)  # 'agent' | 'human'
    processor_id = Column(String(255), nullable=True)  # Human reviewer identifier (email prefix)
    processor_reason = Column(Text, nullable=True)  # Human reviewer's reason (optional)
    processed_at = Column(DateTime(timezone=True))  # When the appeal was finally processed

    # Content hash for duplicate detection
    content_hash = Column(String(64), nullable=True, index=True)

    # Context for review
    user_recent_requests = Column(JSON)  # Recent 10 requests from this user
    user_ban_history = Column(JSON)  # User's ban records if any

    # Whitelist addition
    whitelist_id = Column(Integer, ForeignKey("whitelist.id", ondelete="SET NULL"))
    whitelist_keyword = Column(Text)  # The specific keyword/phrase added

    # Metadata
    ip_address = Column(String(45))
    user_agent = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")
    application = relationship("Application", back_populates="appeal_records")
    whitelist = relationship("Whitelist")

    __table_args__ = (
        Index('idx_appeal_records_created_at', 'created_at'),
        Index('idx_appeal_records_processed_at', 'processed_at'),
        Index('idx_appeal_records_processor_type', 'processor_type'),
    )


# =====================================================
# Model Routing System Models
# =====================================================

class ModelRoute(Base):
    """Model routing rules for automatic upstream API selection based on model name patterns"""
    __tablename__ = "model_routes"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    model_pattern = Column(String(255), nullable=False)  # Model name pattern (e.g., "gpt-4", "claude")
    match_type = Column(String(20), nullable=False, default='prefix')  # 'exact' | 'prefix'
    upstream_api_config_id = Column(Uuid(as_uuid=True), ForeignKey("upstream_api_configs.id", ondelete="CASCADE"), nullable=False, index=True)
    priority = Column(Integer, nullable=False, default=100)  # Priority, higher number = higher priority
    is_active = Column(Boolean, nullable=False, default=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")
    upstream_api_config = relationship("UpstreamApiConfig")
    route_applications = relationship("ModelRouteApplication", back_populates="model_route", cascade="all, delete-orphan")

    # Constraints
    __table_args__ = (
        UniqueConstraint('tenant_id', 'model_pattern', 'match_type', name='uq_model_routes_tenant_pattern'),
        Index('idx_model_routes_priority', priority.desc()),
    )


class ModelRouteApplication(Base):
    """Optional per-application route bindings. Routes without entries here apply to all applications."""
    __tablename__ = "model_route_applications"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    model_route_id = Column(Uuid(as_uuid=True), ForeignKey("model_routes.id", ondelete="CASCADE"), nullable=False, index=True)
    application_id = Column(Uuid(as_uuid=True), ForeignKey("applications.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    model_route = relationship("ModelRoute", back_populates="route_applications")
    application = relationship("Application")

    # Constraints
    __table_args__ = (
        UniqueConstraint('model_route_id', 'application_id', name='uq_model_route_applications'),
    )


class GatewayConnection(Base):
    """Gateway connection configuration (Higress, LiteLLM, etc.)"""
    __tablename__ = "gateway_connections"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    gateway_type = Column(String(32), nullable=False)  # 'higress' or 'litellm'
    is_enabled = Column(Boolean, default=False, nullable=False)
    config = Column(JSON, default=dict, nullable=False)  # Type-specific config
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Relationships
    tenant = relationship("Tenant")

    # Constraints
    __table_args__ = (
        UniqueConstraint('tenant_id', 'gateway_type', name='uq_gateway_connections_tenant_type'),
    )

class TenantMember(Base):
    """Tenant member table - maps users to tenant organizations with roles"""
    __tablename__ = "tenant_members"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)
    email = Column(String(255), nullable=False, index=True)
    role = Column(String(20), nullable=False, default='member')  # owner, admin, member
    invite_status = Column(String(20), nullable=False, default='pending')  # pending, accepted
    invited_by = Column(Uuid(as_uuid=True), ForeignKey("tenants.id"), nullable=True)
    invited_at = Column(DateTime(timezone=True), server_default=func.now())
    accepted_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint('user_id', name='uq_tenant_members_user_id'),
        UniqueConstraint('tenant_id', 'user_id', name='uq_tenant_members_tenant_user'),
        UniqueConstraint('tenant_id', 'email', name='uq_tenant_member_email'),
    )

class AuditLog(Base):
    """Audit log table - tracks all admin operations"""
    __tablename__ = "audit_logs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Uuid(as_uuid=True), nullable=True)
    user_email = Column(String(255), nullable=True)
    action = Column(String(50), nullable=False, index=True)  # create/update/delete/login/logout/export/import
    resource_type = Column(String(100), nullable=False, index=True)  # blacklist/whitelist/application/workspace/...
    resource_id = Column(String(255), nullable=True)
    resource_name = Column(String(255), nullable=True)
    changes = Column(JSON, nullable=True)  # {"field": {"old": x, "new": y}}
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index('idx_audit_logs_created_at', created_at.desc()),
        Index('idx_audit_logs_user_id', 'user_id'),
    )


class TenantInvitation(Base):
    """Tenant invitation table - pending team invitations"""
    __tablename__ = "tenant_invitations"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String(255), nullable=False, index=True)
    role = Column(String(20), nullable=False, default='member')  # admin, member
    invited_by = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False)
    invitation_token = Column(String(128), unique=True, nullable=False, index=True)
    status = Column(String(20), nullable=False, default='pending')  # pending, accepted, expired, cancelled
    expires_at = Column(DateTime(timezone=True), nullable=False)
    accepted_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # Generated column: encodes the PG partial-unique
    # `(tenant_id, email) WHERE status = 'pending'` as a portable plain UNIQUE.
    # NULL when status != 'pending' → no constraint; otherwise = email, so at
    # most one pending invitation per (tenant_id, email).
    pending_email = Column(
        String(255),
        Computed("CASE WHEN status = 'pending' THEN email END"),
    )

    __table_args__ = (
        UniqueConstraint('tenant_id', 'pending_email', name='idx_tenant_invitations_pending_unique'),
    )


# =====================================================
# Red Teaming / Attack Campaigns Models
# =====================================================

class AttackTestQuestion(Base):
    """Test question bank for Red Teaming attack campaigns"""
    __tablename__ = "attack_test_questions"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=True, index=True)  # NULL for preset questions
    package_type = Column(String(50), nullable=False, index=True)  # 'gbt45654', 'owasp_top10', 'custom'
    category = Column(String(50), nullable=False, index=True)  # 'S1'-'S21' or 'LLM01'-'LLM10'
    content = Column(Text, nullable=False)
    expected_action = Column(String(20), default='reject')  # 'reject', 'pass'
    is_preset = Column(Boolean, default=False, index=True)  # true for built-in questions
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Generated columns: encode the PG expression-based unique
    # `UNIQUE (COALESCE(tenant_id, '00...0'), package_type, category, md5(content))`
    # as a portable plain UNIQUE on derived columns. tenant_id_norm collapses
    # NULL tenant_ids to a sentinel UUID so preset rows are deduplicated;
    # content_hash uses md5(content) (built-in on both PG and MySQL).
    # The dashless 32-hex literal is accepted by both dialects.
    tenant_id_norm = Column(
        Uuid(as_uuid=True),
        Computed("COALESCE(tenant_id, '00000000000000000000000000000000')"),
    )
    content_hash = Column(
        String(32),
        Computed("md5(content)"),
    )

    # Association relationships
    tenant = relationship("Tenant")

    __table_args__ = (
        UniqueConstraint(
            'tenant_id_norm', 'package_type', 'category', 'content_hash',
            name='idx_attack_test_questions_unique',
        ),
    )


class AttackCampaign(Base):
    """Attack campaign for Red Teaming"""
    __tablename__ = "attack_campaigns"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    tenant_id = Column(Uuid(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True)
    campaign_number = Column(Integer, nullable=True, index=True)  # Short incremental ID per tenant
    name = Column(String(255), nullable=False)
    description = Column(Text)
    packages = Column(JSON, nullable=False, default=list)  # ['gbt45654', 'owasp_top10']
    selected_categories = Column(JSON, nullable=False, default=list)  # ['S1', 'S2', 'LLM01']
    workspace_id = Column(Uuid(as_uuid=True), ForeignKey("workspaces.id", ondelete="SET NULL"), nullable=True, index=True)
    status = Column(String(20), default='pending', index=True)  # 'pending', 'running', 'completed', 'failed'
    total_tests = Column(Integer, default=0)
    passed_tests = Column(Integer, default=0)
    failed_tests = Column(Integer, default=0)
    started_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Association relationships
    tenant = relationship("Tenant")
    workspace = relationship("Workspace")
    results = relationship("AttackCampaignResult", back_populates="campaign", cascade="all, delete-orphan")

    __table_args__ = (
        Index('idx_attack_campaigns_tenant_number', 'tenant_id', 'campaign_number'),
    )


class AttackCampaignResult(Base):
    """Individual test results within an attack campaign"""
    __tablename__ = "attack_campaign_results"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    campaign_id = Column(Uuid(as_uuid=True), ForeignKey("attack_campaigns.id", ondelete="CASCADE"), nullable=False, index=True)
    question_id = Column(Uuid(as_uuid=True), ForeignKey("attack_test_questions.id", ondelete="SET NULL"), nullable=True)
    question_content = Column(Text, nullable=False)
    category = Column(String(50), nullable=False)
    expected_action = Column(String(20), nullable=False)
    actual_action = Column(String(20))
    detection_result = Column(JSON)  # Full guardrail detection result
    passed = Column(Boolean)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Association relationships
    campaign = relationship("AttackCampaign", back_populates="results")
    question = relationship("AttackTestQuestion")
