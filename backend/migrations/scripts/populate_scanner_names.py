#!/usr/bin/env python3
"""
Populate Scanner Names - Data Maintenance Script
This script populates missing scanner_name fields in knowledge_bases and response_templates tables.

Use this script when:
1. After running migration 026 on an existing database with data
2. If scanner_name fields are missing or null for existing records
3. As part of database maintenance to ensure data consistency

This is a safe operation that only updates NULL scanner_name fields.
"""

import sys
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from config import settings
from database.models import KnowledgeBase, ResponseTemplate, Scanner, Blacklist, Whitelist

def populate_knowledge_base_scanner_names(db):
    """Populate scanner_name for knowledge bases"""
    print("\n=== Populating Knowledge Base Scanner Names ===")
    
    # Get all knowledge bases with null scanner_name
    kb_records = db.query(KnowledgeBase).filter(
        KnowledgeBase.scanner_name.is_(None),
        KnowledgeBase.scanner_type.isnot(None),
        KnowledgeBase.scanner_identifier.isnot(None)
    ).all()
    
    if not kb_records:
        print("✓ All knowledge bases already have scanner_name populated")
        return 0
    
    print(f"Found {len(kb_records)} knowledge base(s) with missing scanner_name\n")
    
    updated_count = 0
    for kb in kb_records:
        scanner_name = None
        
        try:
            if kb.scanner_type == 'blacklist':
                # Get name from blacklist table
                blacklist = db.query(Blacklist).filter(
                    Blacklist.application_id == kb.application_id,
                    Blacklist.name == kb.scanner_identifier
                ).first()
                if blacklist:
                    scanner_name = blacklist.name
            
            elif kb.scanner_type == 'whitelist':
                # Get name from whitelist table
                whitelist = db.query(Whitelist).filter(
                    Whitelist.application_id == kb.application_id,
                    Whitelist.name == kb.scanner_identifier
                ).first()
                if whitelist:
                    scanner_name = whitelist.name
            
            elif kb.scanner_type in ['official_scanner', 'marketplace_scanner', 'custom_scanner']:
                # Get name from scanners table
                scanner = db.query(Scanner).filter(
                    Scanner.tag == kb.scanner_identifier
                ).first()
                if scanner:
                    scanner_name = scanner.name
            
            if scanner_name:
                kb.scanner_name = scanner_name
                updated_count += 1
                print(f"  ✓ KB #{kb.id}: {kb.scanner_type}/{kb.scanner_identifier} → {scanner_name}")
            else:
                print(f"  ⚠ KB #{kb.id}: Could not find scanner for {kb.scanner_type}/{kb.scanner_identifier}")
        
        except Exception as e:
            print(f"  ✗ KB #{kb.id}: Error - {e}")
    
    if updated_count > 0:
        db.commit()
        print(f"\n✅ Updated {updated_count} knowledge base(s)")
    
    return updated_count

def populate_response_template_scanner_names(db):
    """Populate scanner_name for response templates"""
    print("\n=== Populating Response Template Scanner Names ===")
    
    # Get all response templates with null scanner_name
    rt_records = db.query(ResponseTemplate).filter(
        ResponseTemplate.scanner_name.is_(None),
        ResponseTemplate.scanner_type.isnot(None),
        ResponseTemplate.scanner_identifier.isnot(None)
    ).all()
    
    if not rt_records:
        print("✓ All response templates already have scanner_name populated")
        return 0
    
    print(f"Found {len(rt_records)} response template(s) with missing scanner_name\n")
    
    updated_count = 0
    for rt in rt_records:
        scanner_name = None
        
        try:
            if rt.scanner_type == 'blacklist':
                # Get name from blacklist table
                blacklist = db.query(Blacklist).filter(
                    Blacklist.application_id == rt.application_id,
                    Blacklist.name == rt.scanner_identifier
                ).first()
                if blacklist:
                    scanner_name = blacklist.name
            
            elif rt.scanner_type == 'whitelist':
                # Get name from whitelist table
                whitelist = db.query(Whitelist).filter(
                    Whitelist.application_id == rt.application_id,
                    Whitelist.name == rt.scanner_identifier
                ).first()
                if whitelist:
                    scanner_name = whitelist.name
            
            elif rt.scanner_type in ['official_scanner', 'marketplace_scanner', 'custom_scanner']:
                # Get name from scanners table
                scanner = db.query(Scanner).filter(
                    Scanner.tag == rt.scanner_identifier
                ).first()
                if scanner:
                    scanner_name = scanner.name
            
            if scanner_name:
                rt.scanner_name = scanner_name
                updated_count += 1
                print(f"  ✓ Template #{rt.id}: {rt.scanner_type}/{rt.scanner_identifier} → {scanner_name}")
            else:
                print(f"  ⚠ Template #{rt.id}: Could not find scanner for {rt.scanner_type}/{rt.scanner_identifier}")
        
        except Exception as e:
            print(f"  ✗ Template #{rt.id}: Error - {e}")
    
    if updated_count > 0:
        db.commit()
        print(f"\n✅ Updated {updated_count} response template(s)")
    
    return updated_count

def main():
    print("=== Scanner Name Population Tool ===")
    print("This script populates missing scanner_name fields for knowledge bases and response templates.\n")
    
    # Create database session
    engine = create_engine(settings.database_url)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    
    try:
        # Populate knowledge base scanner names
        kb_count = populate_knowledge_base_scanner_names(db)
        
        # Populate response template scanner names
        rt_count = populate_response_template_scanner_names(db)
        
        # Summary
        print("\n=== Summary ===")
        print(f"Knowledge Bases Updated: {kb_count}")
        print(f"Response Templates Updated: {rt_count}")
        print(f"Total Records Updated: {kb_count + rt_count}")
        
        if kb_count + rt_count > 0:
            print("\n✅ All missing scanner_name fields have been populated!")
        else:
            print("\n✓ No updates needed - all records are already up to date")
    
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        db.rollback()
        return 1
    finally:
        db.close()
    
    return 0

if __name__ == "__main__":
    sys.exit(main())

