# Database Maintenance Scripts

This directory contains maintenance scripts for OpenGuardrails database. These scripts are safe to run multiple times and are designed to fix or update data after migrations or system upgrades.

## Available Scripts

### 1. `sync_response_templates.py`

**Purpose:** Create response templates for existing scanners and blacklists that were created before the automatic template creation feature.

**When to use:**
- After upgrading to the version with automatic response template management
- When you notice scanners or blacklists without corresponding response templates
- As a one-time migration after implementing the new template feature

**How to run:**
```bash
cd backend
python migrations/scripts/sync_response_templates.py
```

**What it does:**
1. Creates templates for all official scanners (S1-S21) in each active application
2. Creates templates for all custom scanners (S100+) in their respective applications
3. Creates templates for all purchased marketplace scanners in each application
4. Creates templates for all blacklists in their respective applications

**Safety:**
- ✅ Safe to run multiple times
- ✅ Only creates missing templates (no duplicates)
- ✅ Skips inactive applications, scanners, and blacklists
- ✅ Includes interactive confirmation before execution

**Example output:**
```
Response Template Sync Script
================================================================================

This script will create response templates for existing:
  1. Official scanners (S1-S21)
  2. Custom scanners (S100+)
  3. Marketplace scanners (purchased packages)
  4. Blacklists

Only missing templates will be created (no duplicates).

Do you want to proceed? (yes/no): yes

=== Syncing Official Scanner Templates ===
Found 21 official scanner(s)
Found 3 active application(s)

  Processing application: My AI App (ID: xxx)
    ✓ Created template for S1 (General Political Topics)
    ✓ Created template for S2 (Sensitive Political Topics)
    ...

✅ Created 63 official scanner template(s)

=== Syncing Custom Scanner Templates ===
Found 2 custom scanner(s)
  ✓ Created template for S100 (Bank Fraud) in app My AI App
  ✓ Created template for S101 (Travel Discussion) in app My AI App

✅ Created 2 custom scanner template(s)

=== Syncing Blacklist Templates ===
Found 1 active blacklist(s)
  ✓ Created template for blacklist 'Financial Terms' in app My AI App

✅ Created 1 blacklist template(s)

================================================================================
SUMMARY
================================================================================
Official Scanner Templates:   63
Custom Scanner Templates:     2
Marketplace Scanner Templates: 0
Blacklist Templates:          1
--------------------------------------------------------------------------------
Total Templates Created:      66
================================================================================

✅ Response template sync completed successfully!
```

### 2. `populate_scanner_names.py`

**Purpose:** Populate missing `scanner_name` fields in `knowledge_bases` and `response_templates` tables.

**When to use:**
- After upgrading from a version before migration 026
- If you notice missing scanner names in the UI (showing only "S105" instead of "S105 - Scanner Name")
- As part of database maintenance to ensure data consistency

**How to run:**
```bash
cd backend
python migrations/scripts/populate_scanner_names.py
```

**What it does:**
1. Finds all knowledge bases with NULL `scanner_name`
2. Finds all response templates with NULL `scanner_name`
3. Looks up the correct scanner name from related tables (scanners, blacklist, whitelist)
4. Updates the records with the correct scanner names

**Safety:**
- ✅ Safe to run multiple times
- ✅ Only updates NULL fields
- ✅ Does not modify existing scanner_name values
- ✅ Read-only on source tables (scanners, blacklist, whitelist)

**Example output:**
```
=== Scanner Name Population Tool ===

=== Populating Knowledge Base Scanner Names ===
Found 3 knowledge base(s) with missing scanner_name

  ✓ KB #16: custom_scanner/S105 → 禁止讨论旅游话题
  ✓ KB #22: official_scanner/S9 → 提示词攻击
  ✓ KB #30: blacklist/Financial Terms → Financial Terms

✅ Updated 3 knowledge base(s)

=== Populating Response Template Scanner Names ===
✓ All response templates already have scanner_name populated

=== Summary ===
Knowledge Bases Updated: 3
Response Templates Updated: 0
Total Records Updated: 3

✅ All missing scanner_name fields have been populated!
```

## For New Deployments

**Good news!** If you're deploying OpenGuardrails for the first time or from the latest version, you don't need to run these scripts. The application now automatically:
- Creates response templates when scanners or blacklists are created
- Populates `scanner_name` fields when creating new knowledge bases and response templates

These scripts are only needed for:
1. Existing databases that were created before these features
2. Data that was created during the transition period
3. Manual data fixes or consistency checks
4. **One-time migration:** Run `sync_response_templates.py` after upgrading to the automatic template feature

## Adding New Maintenance Scripts

When adding new maintenance scripts to this directory:

1. **Make them safe to run multiple times** - Use idempotent operations
2. **Add clear documentation** - Explain what, when, and why
3. **Include progress output** - Show what's being done
4. **Handle errors gracefully** - Don't leave partial updates
5. **Update this README** - Add a new section for your script

## Migration vs Maintenance Scripts

**Migrations** (`backend/migrations/versions/*.sql`):
- Run automatically during deployment
- Create or modify database schema
- Should include data population for new fields
- Run once per version

**Maintenance Scripts** (this directory):
- Run manually when needed
- Fix or update existing data
- Safe to run multiple times
- Used for data consistency and repairs

## Need Help?

If you encounter issues running these scripts:
1. Check your database connection in `backend/config.py` or `.env`
2. Ensure migration 026 has been run (adds scanner_name columns)
3. Check the logs for detailed error messages
4. Contact support at thomas@openguardrails.com

