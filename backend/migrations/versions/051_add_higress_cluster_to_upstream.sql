-- Add higress_cluster field to upstream_api_configs for Higress gateway integration
-- This field stores the Higress cluster name used for routing requests to this upstream

ALTER TABLE upstream_api_configs
ADD COLUMN IF NOT EXISTS higress_cluster VARCHAR(255) DEFAULT NULL;

-- Add comment
COMMENT ON COLUMN upstream_api_configs.higress_cluster IS 'Higress cluster name for routing (e.g., outbound|443||private-llm.dns)';
