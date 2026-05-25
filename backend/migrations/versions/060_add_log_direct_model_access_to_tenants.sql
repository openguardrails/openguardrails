-- Migration: Add log_direct_model_access configuration to tenants
-- Version: 060
-- Description: Add tenant-level configuration for logging direct model access calls

-- Add log_direct_model_access column to tenants table
-- Default is FALSE (do not log DMA calls by default for privacy)
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS log_direct_model_access BOOLEAN DEFAULT FALSE;

-- Add index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_tenants_log_dma
ON tenants(log_direct_model_access);

-- Add comment explaining the field
COMMENT ON COLUMN tenants.log_direct_model_access IS 'Whether to log direct model access calls to detection_results. Default FALSE for privacy. When enabled, DMA calls will be tracked with full details in detection_results table.';
