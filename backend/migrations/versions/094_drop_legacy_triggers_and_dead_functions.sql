-- Migration 094: Drop legacy triggers and dead trigger functions
--
-- Problem:
--   PG-only triggers and trigger functions left over from earlier migrations
--   block dialect-portable schema bootstrap (3A.2.c). The four `updated_at`
--   triggers duplicate work the ORM already does via Python-side
--   `onupdate=func.now()` (no raw-SQL UPDATE in the codebase touches these
--   tables). The `trigger_campaign_number` BEFORE INSERT trigger has been
--   replaced with app-side MAX+1 logic in
--   `services/attack_campaigns_service.py:create_campaign()`. The
--   `deactivate_expired_bans` and `cleanup_old_risk_triggers` maintenance
--   functions reference `user_ban_records` / `user_risk_triggers`, both
--   dropped in migration 090; they are unreachable. Two further trigger
--   functions (`update_ban_policies_updated_at`,
--   `update_user_ban_records_updated_at`) lost their tables in the same
--   cleanup and are orphaned.
--
-- Result after this migration:
--   No PG-only DDL is needed in the dialect-aware bootstrap migration for
--   triggers — the schema becomes purely declarative from
--   `Base.metadata.create_all()` on both PG and MySQL.

-- Drop the 4 updated_at triggers (ORM `onupdate` handles this).
DROP TRIGGER IF EXISTS trg_appeal_config_updated_at ON appeal_config;
DROP TRIGGER IF EXISTS trg_appeal_records_updated_at ON appeal_records;
DROP TRIGGER IF EXISTS update_payment_orders_updated_at ON payment_orders;
DROP TRIGGER IF EXISTS update_subscription_payments_updated_at ON subscription_payments;

-- Drop the campaign_number BEFORE INSERT trigger (replaced app-side).
DROP TRIGGER IF EXISTS trigger_campaign_number ON attack_campaigns;

-- Drop the trigger functions backing the 5 triggers above.
DROP FUNCTION IF EXISTS update_appeal_config_updated_at();
DROP FUNCTION IF EXISTS update_appeal_records_updated_at();
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP FUNCTION IF EXISTS generate_campaign_number();

-- Drop dead maintenance functions referencing tables already dropped in
-- migration 090. No Python caller, no scheduled job.
DROP FUNCTION IF EXISTS deactivate_expired_bans();
DROP FUNCTION IF EXISTS cleanup_old_risk_triggers();

-- Drop orphan trigger functions whose triggers were dropped along with the
-- ban tables in migration 090.
DROP FUNCTION IF EXISTS update_ban_policies_updated_at();
DROP FUNCTION IF EXISTS update_user_ban_records_updated_at();
