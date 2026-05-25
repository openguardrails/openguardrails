#!/usr/bin/env python3
"""
Sync Response Templates - Data Migration Script
This script creates response templates for existing scanners and blacklists.

Use this script when:
1. After implementing the automatic response template creation feature
2. To create templates for scanners and blacklists that existed before this feature
3. As part of database maintenance to ensure all scanners have templates

This is a safe operation that only creates missing templates (no duplicates).

The script will:
- Create templates for all official scanners (S1-S21) in each application
- Create templates for all custom scanners (S100+) in their respective applications
- Create templates for all purchased marketplace scanners in each application
- Create templates for all blacklists in their respective applications
"""

import sys
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from config import settings
from database.models import (
    Application, Scanner, ScannerPackage, CustomScanner, 
    Blacklist, PackagePurchase, ResponseTemplate
)
from services.response_template_service import ResponseTemplateService


def sync_official_scanner_templates(db):
    """Create templates for official scanners (S1-S21)"""
    print("\n=== Syncing Official Scanner Templates ===")
    
    # Get the built-in scanner package
    builtin_package = db.query(ScannerPackage).filter(
        ScannerPackage.package_code == 'builtin',
        ScannerPackage.is_active == True
    ).first()
    
    if not builtin_package:
        print("⚠ No built-in scanner package found")
        return 0
    
    # Get all official scanners (S1-S21)
    official_scanners = db.query(Scanner).filter(
        Scanner.package_id == builtin_package.id,
        Scanner.is_active == True
    ).all()
    
    if not official_scanners:
        print("⚠ No official scanners found")
        return 0
    
    print(f"Found {len(official_scanners)} official scanner(s)")
    
    # Get all active applications
    applications = db.query(Application).filter(
        Application.is_active == True
    ).all()
    
    print(f"Found {len(applications)} active application(s)")
    
    template_service = ResponseTemplateService(db)
    created_count = 0
    
    for app in applications:
        print(f"\n  Processing application: {app.name} (ID: {app.id})")
        
        for scanner in official_scanners:
            try:
                template = template_service.create_template_for_official_scanner(
                    scanner=scanner,
                    application_id=app.id,
                    tenant_id=app.tenant_id
                )
                
                if template:
                    created_count += 1
                    print(f"    ✓ Created template for {scanner.tag} ({scanner.name})")
                else:
                    print(f"    - Template for {scanner.tag} already exists")
            
            except Exception as e:
                print(f"    ✗ Error creating template for {scanner.tag}: {e}")
    
    print(f"\n✅ Created {created_count} official scanner template(s)")
    return created_count


def sync_custom_scanner_templates(db):
    """Create templates for custom scanners (S100+)"""
    print("\n=== Syncing Custom Scanner Templates ===")
    
    # Get all custom scanners
    custom_scanners = db.query(CustomScanner).join(Scanner).filter(
        Scanner.is_active == True
    ).all()
    
    if not custom_scanners:
        print("✓ No custom scanners found")
        return 0
    
    print(f"Found {len(custom_scanners)} custom scanner(s)")
    
    template_service = ResponseTemplateService(db)
    created_count = 0
    
    for cs in custom_scanners:
        scanner = cs.scanner
        app_id = cs.application_id
        tenant_id = cs.created_by
        
        # Get application to verify it's still active
        app = db.query(Application).filter(
            Application.id == app_id,
            Application.is_active == True
        ).first()
        
        if not app:
            print(f"  - Skipping {scanner.tag}: Application {app_id} not active")
            continue
        
        try:
            template = template_service.create_template_for_custom_scanner(
                scanner=scanner,
                application_id=app_id,
                tenant_id=tenant_id
            )
            
            if template:
                created_count += 1
                print(f"  ✓ Created template for {scanner.tag} ({scanner.name}) in app {app.name}")
            else:
                print(f"  - Template for {scanner.tag} already exists")
        
        except Exception as e:
            print(f"  ✗ Error creating template for {scanner.tag}: {e}")
    
    print(f"\n✅ Created {created_count} custom scanner template(s)")
    return created_count


def sync_marketplace_scanner_templates(db):
    """Create templates for purchased marketplace scanners"""
    print("\n=== Syncing Marketplace Scanner Templates ===")
    
    # Get all approved purchases
    approved_purchases = db.query(PackagePurchase).filter(
        PackagePurchase.status == 'approved'
    ).all()
    
    if not approved_purchases:
        print("✓ No approved purchases found")
        return 0
    
    print(f"Found {len(approved_purchases)} approved purchase(s)")
    
    template_service = ResponseTemplateService(db)
    created_count = 0
    
    for purchase in approved_purchases:
        package = purchase.package
        tenant_id = purchase.tenant_id
        
        if not package or not package.is_active:
            print(f"  - Skipping purchase {purchase.id}: Package not active")
            continue
        
        # Get all applications for this tenant
        applications = db.query(Application).filter(
            Application.tenant_id == tenant_id,
            Application.is_active == True
        ).all()
        
        if not applications:
            print(f"  - Skipping purchase {purchase.id}: No active applications for tenant {tenant_id}")
            continue
        
        # Get all scanners in the package
        scanners = db.query(Scanner).filter(
            Scanner.package_id == package.id,
            Scanner.is_active == True
        ).all()
        
        if not scanners:
            print(f"  - Skipping package {package.package_name}: No active scanners")
            continue
        
        print(f"\n  Processing package: {package.package_name} ({len(scanners)} scanner(s))")
        
        for app in applications:
            for scanner in scanners:
                try:
                    template = template_service.create_template_for_marketplace_scanner(
                        scanner=scanner,
                        application_id=app.id,
                        tenant_id=tenant_id
                    )
                    
                    if template:
                        created_count += 1
                        print(f"    ✓ Created template for {scanner.tag} ({scanner.name}) in app {app.name}")
                    else:
                        print(f"    - Template for {scanner.tag} in app {app.name} already exists")
                
                except Exception as e:
                    print(f"    ✗ Error creating template for {scanner.tag} in app {app.name}: {e}")
    
    print(f"\n✅ Created {created_count} marketplace scanner template(s)")
    return created_count


def sync_blacklist_templates(db):
    """Create templates for all blacklists"""
    print("\n=== Syncing Blacklist Templates ===")
    
    # Get all active blacklists
    blacklists = db.query(Blacklist).filter(
        Blacklist.is_active == True
    ).all()
    
    if not blacklists:
        print("✓ No active blacklists found")
        return 0
    
    print(f"Found {len(blacklists)} active blacklist(s)")
    
    template_service = ResponseTemplateService(db)
    created_count = 0
    
    for blacklist in blacklists:
        app_id = blacklist.application_id
        tenant_id = blacklist.tenant_id
        
        # Get application to verify it's still active
        app = db.query(Application).filter(
            Application.id == app_id,
            Application.is_active == True
        ).first()
        
        if not app:
            print(f"  - Skipping blacklist '{blacklist.name}': Application {app_id} not active")
            continue
        
        try:
            template = template_service.create_template_for_blacklist(
                blacklist=blacklist,
                application_id=app_id,
                tenant_id=tenant_id
            )
            
            if template:
                created_count += 1
                print(f"  ✓ Created template for blacklist '{blacklist.name}' in app {app.name}")
            else:
                print(f"  - Template for blacklist '{blacklist.name}' already exists")
        
        except Exception as e:
            print(f"  ✗ Error creating template for blacklist '{blacklist.name}': {e}")
    
    print(f"\n✅ Created {created_count} blacklist template(s)")
    return created_count


def main():
    """Main execution"""
    print("=" * 80)
    print("Response Template Sync Script")
    print("=" * 80)
    print("\nThis script will create response templates for existing:")
    print("  1. Official scanners (S1-S21)")
    print("  2. Custom scanners (S100+)")
    print("  3. Marketplace scanners (purchased packages)")
    print("  4. Blacklists")
    print("\nOnly missing templates will be created (no duplicates).\n")
    
    # Confirm execution
    confirm = input("Do you want to proceed? (yes/no): ").strip().lower()
    if confirm not in ['yes', 'y']:
        print("\n❌ Operation cancelled by user")
        return
    
    # Create database connection
    print(f"\nConnecting to database: {settings.database_url.split('@')[1]}")
    engine = create_engine(settings.database_url)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    
    try:
        # Run sync operations
        official_count = sync_official_scanner_templates(db)
        custom_count = sync_custom_scanner_templates(db)
        marketplace_count = sync_marketplace_scanner_templates(db)
        blacklist_count = sync_blacklist_templates(db)
        
        # Summary
        total_count = official_count + custom_count + marketplace_count + blacklist_count
        
        print("\n" + "=" * 80)
        print("SUMMARY")
        print("=" * 80)
        print(f"Official Scanner Templates:   {official_count}")
        print(f"Custom Scanner Templates:     {custom_count}")
        print(f"Marketplace Scanner Templates: {marketplace_count}")
        print(f"Blacklist Templates:          {blacklist_count}")
        print("-" * 80)
        print(f"Total Templates Created:      {total_count}")
        print("=" * 80)
        
        if total_count > 0:
            print("\n✅ Response template sync completed successfully!")
        else:
            print("\n✓ All templates already exist - no action needed")
    
    except Exception as e:
        print(f"\n❌ Error during sync: {e}")
        db.rollback()
        raise
    
    finally:
        db.close()


if __name__ == "__main__":
    main()

