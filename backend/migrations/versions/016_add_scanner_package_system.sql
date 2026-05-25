-- Migration: Add Scanner Package System
-- Description: Replace hardcoded risk types with flexible scanner package system
-- Version: 016
-- Date: 2025-11-05

-- =====================================================
-- Step 1: Create scanner_packages table
-- =====================================================

CREATE TABLE IF NOT EXISTS scanner_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_code VARCHAR(100) UNIQUE NOT NULL,
    package_name VARCHAR(200) NOT NULL,
    author VARCHAR(200) NOT NULL DEFAULT 'OpenGuardrails',
    description TEXT,
    version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    license VARCHAR(100) DEFAULT 'proprietary',

    -- Package type
    package_type VARCHAR(50) NOT NULL,
    is_official BOOLEAN NOT NULL DEFAULT TRUE,
    requires_purchase BOOLEAN NOT NULL DEFAULT FALSE,

    -- Purchase settings (for premium packages)
    price_display VARCHAR(100),
    file_path VARCHAR(512),

    -- Metadata
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER DEFAULT 0,
    scanner_count INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_package_type CHECK (package_type IN ('builtin', 'purchasable'))  -- 'builtin' = basic, 'purchasable' = premium
);

CREATE INDEX IF NOT EXISTS idx_scanner_packages_type ON scanner_packages(package_type);
CREATE INDEX IF NOT EXISTS idx_scanner_packages_active ON scanner_packages(is_active);
CREATE INDEX IF NOT EXISTS idx_scanner_packages_code ON scanner_packages(package_code);

-- =====================================================
-- Step 2: Create scanners table
-- =====================================================

CREATE TABLE IF NOT EXISTS scanners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id UUID REFERENCES scanner_packages(id) ON DELETE CASCADE,

    -- Scanner identification
    tag VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,

    -- Scanner configuration
    scanner_type VARCHAR(50) NOT NULL,
    definition TEXT NOT NULL,

    -- Default behavior (package defaults)
    default_risk_level VARCHAR(20) NOT NULL,
    default_scan_prompt BOOLEAN NOT NULL DEFAULT TRUE,
    default_scan_response BOOLEAN NOT NULL DEFAULT TRUE,

    -- Metadata
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_scanner_type CHECK (scanner_type IN ('genai', 'regex', 'keyword')),
    CONSTRAINT chk_default_risk_level CHECK (default_risk_level IN ('high_risk', 'medium_risk', 'low_risk'))
);

CREATE INDEX IF NOT EXISTS idx_scanners_package ON scanners(package_id);
CREATE INDEX IF NOT EXISTS idx_scanners_tag ON scanners(tag);
CREATE INDEX IF NOT EXISTS idx_scanners_type ON scanners(scanner_type);
CREATE INDEX IF NOT EXISTS idx_scanners_active ON scanners(is_active);

-- =====================================================
-- Step 3: Create application_scanner_configs table
-- =====================================================

CREATE TABLE IF NOT EXISTS application_scanner_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scanner_id UUID NOT NULL REFERENCES scanners(id) ON DELETE CASCADE,

    -- Override settings (NULL = use package defaults)
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    risk_level_override VARCHAR(20),
    scan_prompt_override BOOLEAN,
    scan_response_override BOOLEAN,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_risk_level_override CHECK (
        risk_level_override IS NULL OR
        risk_level_override IN ('high_risk', 'medium_risk', 'low_risk')
    )
);

-- Create unique constraint with proper name
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_app_scanner_config'
    ) THEN
        ALTER TABLE application_scanner_configs
        ADD CONSTRAINT uq_app_scanner_config UNIQUE(application_id, scanner_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_app_scanner_configs_app ON application_scanner_configs(application_id);
CREATE INDEX IF NOT EXISTS idx_app_scanner_configs_scanner ON application_scanner_configs(scanner_id);
CREATE INDEX IF NOT EXISTS idx_app_scanner_configs_enabled ON application_scanner_configs(application_id, is_enabled);

-- =====================================================
-- Step 4: Create package_purchases table
-- =====================================================

CREATE TABLE IF NOT EXISTS package_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    package_id UUID NOT NULL REFERENCES scanner_packages(id) ON DELETE CASCADE,

    -- Purchase lifecycle
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    request_email VARCHAR(255),
    request_message TEXT,

    -- Admin actions
    approved_by UUID REFERENCES tenants(id),
    approved_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_purchase_status CHECK (status IN ('pending', 'approved', 'rejected'))
);

-- Create unique constraint with proper name
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_package_purchase'
    ) THEN
        ALTER TABLE package_purchases
        ADD CONSTRAINT uq_tenant_package_purchase UNIQUE(tenant_id, package_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_package_purchases_tenant ON package_purchases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_package_purchases_package ON package_purchases(package_id);
CREATE INDEX IF NOT EXISTS idx_package_purchases_status ON package_purchases(status);

-- =====================================================
-- Step 5: Create custom_scanners table
-- =====================================================

CREATE TABLE IF NOT EXISTS custom_scanners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scanner_id UUID NOT NULL REFERENCES scanners(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES tenants(id),

    -- Custom scanner metadata
    notes TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique constraint with proper name
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_app_custom_scanner'
    ) THEN
        ALTER TABLE custom_scanners
        ADD CONSTRAINT uq_app_custom_scanner UNIQUE(application_id, scanner_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_custom_scanners_app ON custom_scanners(application_id);
CREATE INDEX IF NOT EXISTS idx_custom_scanners_scanner ON custom_scanners(scanner_id);
CREATE INDEX IF NOT EXISTS idx_custom_scanners_created_by ON custom_scanners(created_by);

-- =====================================================
-- Step 6: Update detection_results table
-- =====================================================

ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS matched_scanner_tags TEXT;

COMMENT ON COLUMN detection_results.matched_scanner_tags IS 'Comma-separated list of matched scanner tags (e.g., "S2,S5,S100")';

-- =====================================================
-- Step 7: Mark old tables as deprecated
-- =====================================================

COMMENT ON TABLE risk_type_config IS 'DEPRECATED: Use scanner package system instead. Kept for backward compatibility and rollback. Will be removed in future version.';

-- =====================================================
-- Migration Complete
-- =====================================================

-- Note: Built-in packages and data migration will be handled by Python script (017_migrate_to_scanner_system.py)
