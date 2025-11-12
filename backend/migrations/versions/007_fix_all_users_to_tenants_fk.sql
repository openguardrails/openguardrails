-- Fix ALL foreign key constraints from 'users' table to 'tenants' table
-- This is a comprehensive fix for the incomplete users->tenants migration
--
-- Migration: 007_fix_all_users_to_tenants_fk
-- Date: 2025-10-31
-- Description: Fix all foreign key constraints to reference tenants table instead of users table

-- ============================================================
-- Fix blacklist table
-- ============================================================
ALTER TABLE blacklist DROP CONSTRAINT IF EXISTS blacklist_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'blacklist_tenant_id_fkey'
    ) THEN
        ALTER TABLE blacklist ADD CONSTRAINT blacklist_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix knowledge_bases table
-- ============================================================
ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_bases_tenant_id_fkey'
    ) THEN
        ALTER TABLE knowledge_bases ADD CONSTRAINT knowledge_bases_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix online_test_model_selections table
-- ============================================================
ALTER TABLE online_test_model_selections DROP CONSTRAINT IF EXISTS online_test_model_selections_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'online_test_model_selections_tenant_id_fkey'
    ) THEN
        ALTER TABLE online_test_model_selections ADD CONSTRAINT online_test_model_selections_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix proxy_model_configs table (THIS IS THE ONE USER REPORTED)
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'proxy_model_configs_tenant_id_fkey'
    ) and EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'proxy_model_configs'
    ) THEN
        ALTER TABLE proxy_model_configs DROP CONSTRAINT IF EXISTS proxy_model_configs_user_id_fkey;
        ALTER TABLE proxy_model_configs ADD CONSTRAINT proxy_model_configs_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix proxy_request_logs table
-- ============================================================
ALTER TABLE proxy_request_logs DROP CONSTRAINT IF EXISTS proxy_request_logs_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'proxy_request_logs_tenant_id_fkey'
    ) THEN
        ALTER TABLE proxy_request_logs ADD CONSTRAINT proxy_request_logs_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix response_templates table
-- ============================================================
ALTER TABLE response_templates DROP CONSTRAINT IF EXISTS response_templates_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'response_templates_tenant_id_fkey'
    ) THEN
        ALTER TABLE response_templates ADD CONSTRAINT response_templates_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix risk_type_config table
-- ============================================================
ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS risk_type_config_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'risk_type_config_tenant_id_fkey'
    ) THEN
        ALTER TABLE risk_type_config ADD CONSTRAINT risk_type_config_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix test_model_configs table
-- ============================================================
ALTER TABLE test_model_configs DROP CONSTRAINT IF EXISTS test_model_configs_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'test_model_configs_tenant_id_fkey'
    ) THEN
        ALTER TABLE test_model_configs ADD CONSTRAINT test_model_configs_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix user_rate_limit_counters table (column name is user_id, not tenant_id)
-- Note: This table uses 'user_id' column name, but should reference tenants table
-- ============================================================
-- Keep the column name as user_id for now, but reference tenants table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_rate_limit_counters'
    ) THEN
        ALTER TABLE user_rate_limit_counters DROP CONSTRAINT IF EXISTS user_rate_limit_counters_user_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_rate_limit_counters_user_id_fkey'
    ) and EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_rate_limit_counters'
    ) THEN
        ALTER TABLE user_rate_limit_counters ADD CONSTRAINT user_rate_limit_counters_user_id_fkey 
            FOREIGN KEY (user_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix user_rate_limits table (column name is user_id, not tenant_id)
-- Note: This table uses 'user_id' column name, but should reference tenants table
-- ============================================================
-- Keep the column name as user_id for now, but reference tenants table
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_rate_limits'
    ) THEN
        ALTER TABLE user_rate_limits DROP CONSTRAINT IF EXISTS user_rate_limits_user_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_rate_limits_user_id_fkey'
    ) and EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_rate_limits'
    ) THEN
        ALTER TABLE user_rate_limits ADD CONSTRAINT user_rate_limits_user_id_fkey 
            FOREIGN KEY (user_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix user_switches table (has two foreign keys to fix)
-- Note: This table might be renamed to tenant_switches in the future
-- ============================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_switches'
    ) THEN
        ALTER TABLE user_switches DROP CONSTRAINT IF EXISTS user_switches_admin_user_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_switches_admin_user_id_fkey'
    ) and EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_switches'
    ) THEN
        ALTER TABLE user_switches ADD CONSTRAINT user_switches_admin_user_id_fkey 
            FOREIGN KEY (admin_user_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_switches'
    ) THEN
        ALTER TABLE user_switches DROP CONSTRAINT IF EXISTS user_switches_target_user_id_fkey;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_switches_target_user_id_fkey'
    ) and EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'user_switches'
    ) THEN
        ALTER TABLE user_switches ADD CONSTRAINT user_switches_target_user_id_fkey 
            FOREIGN KEY (target_user_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- Fix whitelist table
-- ============================================================
ALTER TABLE whitelist DROP CONSTRAINT IF EXISTS whitelist_user_id_fkey;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'whitelist_tenant_id_fkey'
    ) THEN
        ALTER TABLE whitelist ADD CONSTRAINT whitelist_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- ============================================================
-- SUMMARY
-- ============================================================
-- This migration fixed foreign key constraints for 13 tables
-- All tables now correctly reference the 'tenants' table instead of 'users' table
-- The 'users' table can potentially be dropped after this migration
-- (but we'll keep it for now for safety)

