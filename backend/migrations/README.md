# Database Migrations

This directory contains database migration scripts for OpenGuardrails.

## Migration Scripts

### 001_add_ban_policy_tables.sql
Initial ban policy tables creation. Creates:
- `ban_policies` - Ban policy configuration table
- `user_ban_records` - User ban records table  
- `user_risk_triggers` - User risk trigger history table

### 002_fix_ban_policy_risk_level.sql
Fixes the risk_level field to use English values instead of Chinese values.

**Issues Fixed:**
1. Ban Policy Configuration displays Chinese "高风险" instead of "High Risk" in English locale
2. Dropdown selection fails with `check_risk_level` constraint violation error

**Changes:**
- Updates existing data: `高风险` → `high_risk`, `中风险` → `medium_risk`, `低风险` → `low_risk`
- Updates constraint to accept English values: `('high_risk', 'medium_risk', 'low_risk')`
- Changes default value from `'高风险'` to `'high_risk'`

## How to Run Migrations

### Running a specific migration:

```bash
# From the project root directory
cat backend/migrations/versions/002_fix_ban_policy_risk_level.sql | \
  docker exec -i openguardrails-postgres psql -U openguardrails -d openguardrails
```

### Verifying the migration:

```bash
# Check the constraint
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "\d+ ban_policies" | grep -A 5 "Check constraints"

# Check the data
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT DISTINCT risk_level, COUNT(*) FROM ban_policies GROUP BY risk_level;"
```

## Migration History

| Version | Date | Description |
|---------|------|-------------|
| 001 | 2025-10-08 | Initial ban policy tables |
| 002 | 2025-10-29 | Fix risk_level to use English values |
