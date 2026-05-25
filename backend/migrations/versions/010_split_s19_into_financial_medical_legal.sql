-- Migration: split_s19_into_financial_medical_legal
-- Version: 010
-- Date: 2025-11-01
-- Author: OpenGuardrails Team

-- Description:
-- Split S19 (Professional Advice) into three separate risk types:
-- - S19: Professional Financial Advice (low risk)
-- - S20: Professional Medical Advice (low risk)
-- - S21: Professional Legal Advice (low risk)
--
-- This migration adds S20 and S21 columns to risk_type_config table.
-- S19 is kept for backward compatibility and repurposed as Financial Advice.

-- Add new columns for risk types S20 and S21
ALTER TABLE risk_type_config
ADD COLUMN IF NOT EXISTS s20_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s21_enabled BOOLEAN DEFAULT TRUE;

-- Update comments for clarity
COMMENT ON COLUMN risk_type_config.s19_enabled IS 'Professional Financial Advice (low risk)';
COMMENT ON COLUMN risk_type_config.s20_enabled IS 'Professional Medical Advice (low risk)';
COMMENT ON COLUMN risk_type_config.s21_enabled IS 'Professional Legal Advice (low risk)';
