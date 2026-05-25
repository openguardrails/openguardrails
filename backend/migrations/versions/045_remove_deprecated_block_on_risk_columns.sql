-- Migration: Remove deprecated block_on_input_risk and block_on_output_risk columns
-- These columns are no longer used since security policies are now configured via
-- application-level gateway policies (application_data_leakage_policy table)
-- Version: 045
-- Date: 2026-01-06

-- Drop columns from upstream_api_configs table
DO $$
BEGIN
    -- Drop block_on_input_risk column if exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'block_on_input_risk'
    ) THEN
        ALTER TABLE upstream_api_configs DROP COLUMN block_on_input_risk;
        RAISE NOTICE 'Dropped column block_on_input_risk from upstream_api_configs';
    END IF;

    -- Drop block_on_output_risk column if exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'block_on_output_risk'
    ) THEN
        ALTER TABLE upstream_api_configs DROP COLUMN block_on_output_risk;
        RAISE NOTICE 'Dropped column block_on_output_risk from upstream_api_configs';
    END IF;
END $$;

-- Drop columns from proxy_model_configs table (deprecated table, but clean up anyway)
DO $$
BEGIN
    -- Check if the table exists first
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'proxy_model_configs'
    ) THEN
        -- Drop block_on_input_risk column if exists
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'proxy_model_configs' AND column_name = 'block_on_input_risk'
        ) THEN
            ALTER TABLE proxy_model_configs DROP COLUMN block_on_input_risk;
            RAISE NOTICE 'Dropped column block_on_input_risk from proxy_model_configs';
        END IF;

        -- Drop block_on_output_risk column if exists
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'proxy_model_configs' AND column_name = 'block_on_output_risk'
        ) THEN
            ALTER TABLE proxy_model_configs DROP COLUMN block_on_output_risk;
            RAISE NOTICE 'Dropped column block_on_output_risk from proxy_model_configs';
        END IF;
    END IF;
END $$;
