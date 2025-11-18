#!/usr/bin/env python3
"""
Clean Duplicate Response Templates - Data Cleanup Script
This script removes duplicate response templates, keeping only the latest version.

Cleanup logic:
1. Group by tenant_id, application_id, and scanner_identifier (or category for old records)
2. Keep the record with the highest ID (most recent)
3. Delete older duplicates
4. Update statistics
"""

import sys
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from config import settings
from utils.logger import setup_logger

logger = setup_logger()

def get_duplicate_groups(db):
    """Get groups of duplicate response templates"""
    query = text("""
    SELECT
        tenant_id,
        application_id,
        COALESCE(scanner_identifier, category) as scanner_key,
        scanner_name,
        COUNT(*) as duplicate_count,
        ARRAY_AGG(id ORDER BY created_at DESC, updated_at DESC) as ids,
        STRING_AGG(CAST(id AS TEXT), ', ' ORDER BY created_at DESC, updated_at DESC) as id_list
    FROM response_templates
    WHERE scanner_name IS NOT NULL
    GROUP BY tenant_id, application_id, COALESCE(scanner_identifier, category), scanner_name
    HAVING COUNT(*) > 1
    ORDER BY tenant_id, duplicate_count DESC
    """)

    result = db.execute(query)
    return result.fetchall()

def clean_duplicates(db, dry_run=True):
    """Clean duplicate response templates"""
    logger.info("=== " + ("DRY RUN - " if dry_run else "") + "CLEANING DUPLICATE RESPONSE TEMPLATES ===")

    duplicate_groups = get_duplicate_groups(db)

    if not duplicate_groups:
        logger.info("✅ No duplicate response templates found")
        return 0, 0

    total_duplicates = len(duplicate_groups)
    total_to_delete = 0

    logger.info(f"Found {total_duplicates} duplicate groups")

    for group in duplicate_groups:
        tenant_id = group.tenant_id
        application_id = group.application_id
        scanner_key = group.scanner_key
        scanner_name = group.scanner_name
        duplicate_count = group.duplicate_count
        ids = group.ids  # Already ordered by created_at DESC, updated_at DESC

        # Keep the first (latest) ID, delete the rest
        keep_id = ids[0]
        delete_ids = ids[1:]
        total_to_delete += len(delete_ids)

        logger.info(f"\n🔍 Duplicate Group:")
        logger.info(f"   Tenant: {tenant_id}")
        logger.info(f"   Application: {application_id}")
        logger.info(f"   Scanner: {scanner_name} ({scanner_key})")
        logger.info(f"   Count: {duplicate_count}")
        logger.info(f"   Keep: {keep_id} (latest)")
        logger.info(f"   Delete: {delete_ids}")

        if not dry_run:
            # Delete duplicates
            delete_query = text("""
                DELETE FROM response_templates
                WHERE id = ANY(:delete_ids)
            """)

            try:
                db.execute(delete_query, {"delete_ids": delete_ids})
                db.flush()
                logger.info(f"   ✅ Deleted {len(delete_ids)} duplicate records")
            except Exception as e:
                logger.error(f"   ❌ Error deleting duplicates: {e}")
                db.rollback()
                return total_duplicates, total_to_delete

    if not dry_run:
        db.commit()
        logger.info(f"\n✅ Successfully deleted {total_to_delete} duplicate response templates")
    else:
        logger.info(f"\n🔍 DRY RUN: Would delete {total_to_delete} duplicate response templates")
        logger.info("   Run without --dry-run to actually delete duplicates")

    return total_duplicates, total_to_delete

def get_statistics(db):
    """Get response template statistics before and after cleanup"""
    query = text("""
    SELECT
        COUNT(*) as total_templates,
        COUNT(DISTINCT tenant_id) as unique_tenants,
        COUNT(DISTINCT application_id) as unique_applications,
        COUNT(DISTINCT COALESCE(scanner_identifier, category)) as unique_scanners
    FROM response_templates
    """)

    result = db.execute(query).fetchone()
    return {
        'total_templates': result.total_templates,
        'unique_tenants': result.unique_tenants,
        'unique_applications': result.unique_applications,
        'unique_scanners': result.unique_scanners
    }

def main():
    import argparse

    parser = argparse.ArgumentParser(description='Clean duplicate response templates')
    parser.add_argument('--dry-run', action='store_true',
                       help='Show what would be deleted without actually deleting')
    parser.add_argument('--force', action='store_true',
                       help='Skip confirmation prompt')

    args = parser.parse_args()

    # Default to dry run for safety
    dry_run = not args.force

    print("=" * 80)
    print("CLEAN DUPLICATE RESPONSE TEMPLATES")
    print("=" * 80)

    # Create database connection
    engine = create_engine(settings.database_url)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()

    try:
        # Show statistics before
        stats_before = get_statistics(db)
        print(f"\n📊 Statistics Before Cleanup:")
        print(f"   Total Templates: {stats_before['total_templates']}")
        print(f"   Unique Tenants: {stats_before['unique_tenants']}")
        print(f"   Unique Applications: {stats_before['unique_applications']}")
        print(f"   Unique Scanners: {stats_before['unique_scanners']}")

        # Clean duplicates
        total_groups, total_to_delete = clean_duplicates(db, dry_run=dry_run)

        if total_groups == 0:
            print("\n✅ No duplicates found - nothing to do!")
            return

        if not dry_run:
            # Show statistics after
            stats_after = get_statistics(db)
            print(f"\n📊 Statistics After Cleanup:")
            print(f"   Total Templates: {stats_after['total_templates']} (-{total_to_delete})")
            print(f"   Unique Tenants: {stats_after['unique_tenants']}")
            print(f"   Unique Applications: {stats_after['unique_applications']}")
            print(f"   Unique Scanners: {stats_after['unique_scanners']}")
        else:
            print(f"\n🔍 DRY RUN SUMMARY:")
            print(f"   Duplicate Groups: {total_groups}")
            print(f"   Records to Delete: {total_to_delete}")
            print(f"\n⚠️  To actually delete duplicates, run with --force")

    except Exception as e:
        logger.error(f"❌ Error during cleanup: {e}")
        import traceback
        traceback.print_exc()
        db.rollback()
        return 1

    finally:
        db.close()

    return 0

if __name__ == "__main__":
    sys.exit(main())