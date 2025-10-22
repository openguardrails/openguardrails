-- Add S13-S19 risk type fields to risk_type_config table
-- Adds 7 new risk types: S13-S19

-- Add new columns for risk types S13-S19
ALTER TABLE risk_type_config
ADD COLUMN IF NOT EXISTS s13_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s14_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s15_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s16_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s17_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s18_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS s19_enabled BOOLEAN DEFAULT TRUE;

-- Add comments for the new columns
COMMENT ON COLUMN risk_type_config.s13_enabled IS 'Intellectual Property Infringement (low risk)';
COMMENT ON COLUMN risk_type_config.s14_enabled IS 'Harassment (low risk)';
COMMENT ON COLUMN risk_type_config.s15_enabled IS 'Weapons of Mass Destruction (high risk)';
COMMENT ON COLUMN risk_type_config.s16_enabled IS 'Self-Harm (medium risk)';
COMMENT ON COLUMN risk_type_config.s17_enabled IS 'Sexual Crimes (high risk)';
COMMENT ON COLUMN risk_type_config.s18_enabled IS 'Threats (low risk)';
COMMENT ON COLUMN risk_type_config.s19_enabled IS 'Professional Advice (low risk)';
