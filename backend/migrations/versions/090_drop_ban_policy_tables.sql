-- Migration: Drop ban policy related tables
-- Description: Remove ban_policies, user_ban_records, and user_risk_triggers tables as the ban policy feature has been removed

-- Drop tables in correct order (foreign key dependencies)
DROP TABLE IF EXISTS user_risk_triggers CASCADE;
DROP TABLE IF EXISTS user_ban_records CASCADE;
DROP TABLE IF EXISTS ban_policies CASCADE;
