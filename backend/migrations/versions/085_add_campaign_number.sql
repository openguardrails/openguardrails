-- Migration: Add campaign_number to attack_campaigns
-- Description: Add a short incremental ID for campaigns (per tenant)

-- Add campaign_number column
ALTER TABLE attack_campaigns
ADD COLUMN IF NOT EXISTS campaign_number INTEGER;

-- Create a sequence for generating campaign numbers (per tenant)
-- We'll use a trigger to auto-generate the number

-- Create function to generate campaign number
CREATE OR REPLACE FUNCTION generate_campaign_number()
RETURNS TRIGGER AS $$
DECLARE
    next_number INTEGER;
BEGIN
    -- Get the next number for this tenant
    SELECT COALESCE(MAX(campaign_number), 0) + 1 INTO next_number
    FROM attack_campaigns
    WHERE tenant_id = NEW.tenant_id;

    NEW.campaign_number := next_number;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger (drop first if exists)
DROP TRIGGER IF EXISTS trigger_campaign_number ON attack_campaigns;

CREATE TRIGGER trigger_campaign_number
BEFORE INSERT ON attack_campaigns
FOR EACH ROW
WHEN (NEW.campaign_number IS NULL)
EXECUTE FUNCTION generate_campaign_number();

-- Backfill existing campaigns with numbers
WITH numbered AS (
    SELECT id, tenant_id,
           ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at) as rn
    FROM attack_campaigns
    WHERE campaign_number IS NULL
)
UPDATE attack_campaigns ac
SET campaign_number = numbered.rn
FROM numbered
WHERE ac.id = numbered.id;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_attack_campaigns_tenant_number
ON attack_campaigns(tenant_id, campaign_number);
