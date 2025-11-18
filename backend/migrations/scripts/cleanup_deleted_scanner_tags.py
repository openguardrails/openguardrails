#!/usr/bin/env python3
"""
Cleanup script to rename tags of soft-deleted scanners to avoid unique constraint violations.

This script should be run once after deploying the fix for scanner deletion.
It will rename all inactive scanner tags to include a deletion timestamp,
allowing those tags to be reused for new scanners.

Usage:
    cd backend
    python migrations/scripts/cleanup_deleted_scanner_tags.py
"""

import sys
import os
import time

# Add backend directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from database.connection import get_db
from database.models import Scanner, CustomScanner
from sqlalchemy import and_

def cleanup_deleted_scanner_tags():
    """Rename tags of all inactive scanners to avoid unique constraint violations"""
    
    db = next(get_db())
    
    try:
        # Find all inactive scanners
        inactive_scanners = db.query(Scanner).filter(
            Scanner.is_active == False
        ).all()
        
        if not inactive_scanners:
            print("✓ No inactive scanners found. Database is clean.")
            return
        
        print(f"Found {len(inactive_scanners)} inactive scanner(s) to clean up\n")
        
        updated_count = 0
        for scanner in inactive_scanners:
            original_tag = scanner.tag
            
            # Skip if already renamed (contains '_deleted_')
            if '_deleted_' in original_tag:
                print(f"  - Skipping {original_tag}: already renamed")
                continue
            
            # Generate new tag with deletion timestamp
            deleted_tag = f"{original_tag}_deleted_{int(time.time())}"
            
            # Check if this tag is still in use (shouldn't happen, but be safe)
            existing = db.query(Scanner).filter(
                and_(
                    Scanner.tag == deleted_tag,
                    Scanner.id != scanner.id
                )
            ).first()
            
            if existing:
                # If collision, add a counter
                counter = 1
                while existing:
                    deleted_tag = f"{original_tag}_deleted_{int(time.time())}_{counter}"
                    existing = db.query(Scanner).filter(
                        and_(
                            Scanner.tag == deleted_tag,
                            Scanner.id != scanner.id
                        )
                    ).first()
                    counter += 1
            
            # Update the tag
            scanner.tag = deleted_tag
            updated_count += 1
            print(f"  ✓ Renamed: {original_tag} → {deleted_tag}")
        
        # Commit all changes
        db.commit()
        
        print(f"\n✓ Successfully cleaned up {updated_count} scanner tag(s)")
        print("  You can now create new scanners with these tags.")
        
    except Exception as e:
        db.rollback()
        print(f"\n✗ Error during cleanup: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    print("=" * 70)
    print("Cleanup Script: Rename Deleted Scanner Tags")
    print("=" * 70)
    print()
    
    # Confirm before running
    response = input("This will rename all inactive scanner tags. Continue? (y/N): ")
    if response.lower() != 'y':
        print("Aborted.")
        sys.exit(0)
    
    print()
    cleanup_deleted_scanner_tags()
    print()
    print("=" * 70)
    print("Cleanup completed!")
    print("=" * 70)

