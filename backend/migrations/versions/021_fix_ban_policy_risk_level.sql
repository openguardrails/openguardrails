-- Fix ban_policies risk_level to use English values instead of Chinese
-- This migration solves two issues:
-- 1. Ban Policy Configuration displays Chinese "高风险" in English locale
-- 2. Dropdown selection fails with check_risk_level constraint error

-- Step 1: Drop the old constraint FIRST (before updating data)
ALTER TABLE ban_policies DROP CONSTRAINT IF EXISTS check_risk_level;

-- Step 2: Change the default value from Chinese to English
ALTER TABLE ban_policies ALTER COLUMN risk_level SET DEFAULT 'high_risk';

-- Step 3: Update existing data from Chinese to English in ban_policies
UPDATE ban_policies SET risk_level = 'high_risk' WHERE risk_level = '高风险';
UPDATE ban_policies SET risk_level = 'medium_risk' WHERE risk_level = '中风险';
UPDATE ban_policies SET risk_level = 'low_risk' WHERE risk_level = '低风险';

-- Step 4: Update user_ban_records table as well
UPDATE user_ban_records SET risk_level = 'high_risk' WHERE risk_level = '高风险';
UPDATE user_ban_records SET risk_level = 'medium_risk' WHERE risk_level = '中风险';
UPDATE user_ban_records SET risk_level = 'low_risk' WHERE risk_level = '低风险';

-- Step 5: Update user_risk_triggers table as well
UPDATE user_risk_triggers SET risk_level = 'high_risk' WHERE risk_level = '高风险';
UPDATE user_risk_triggers SET risk_level = 'medium_risk' WHERE risk_level = '中风险';
UPDATE user_risk_triggers SET risk_level = 'low_risk' WHERE risk_level = '低风险';

-- Step 6: Add new constraint with English values
ALTER TABLE ban_policies ADD CONSTRAINT check_risk_level 
    CHECK (risk_level IN ('high_risk', 'medium_risk', 'low_risk'));

-- Verify the changes
SELECT 'Migration completed. Current risk levels in ban_policies:' as status;
SELECT DISTINCT risk_level, COUNT(*) as count 
FROM ban_policies 
GROUP BY risk_level;

