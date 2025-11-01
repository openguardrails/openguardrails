#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/tom/xiangxinai/openguardrails/backend')

from database.connection import SessionLocal
from database.models import KnowledgeBase
from models.responses import KnowledgeBaseResponse

print("Testing KnowledgeBase model...")

db = SessionLocal()
try:
    kb = db.query(KnowledgeBase).first()
    if kb:
        print(f"\nFound KB: id={kb.id}, name={kb.name}")
        print(f"Has similarity_threshold: {hasattr(kb, 'similarity_threshold')}")

        if hasattr(kb, 'similarity_threshold'):
            print(f"Value: {kb.similarity_threshold}")
            print(f"Type: {type(kb.similarity_threshold)}")

            # Test creating response model
            try:
                response = KnowledgeBaseResponse(
                    id=kb.id,
                    category=kb.category,
                    name=kb.name,
                    description=kb.description,
                    file_path=kb.file_path,
                    vector_file_path=kb.vector_file_path,
                    total_qa_pairs=kb.total_qa_pairs,
                    similarity_threshold=kb.similarity_threshold,
                    is_active=kb.is_active,
                    is_global=kb.is_global,
                    created_at=kb.created_at,
                    updated_at=kb.updated_at
                )
                print("\n✓ KnowledgeBaseResponse created successfully!")
                print(f"  Response similarity_threshold: {response.similarity_threshold}")
            except Exception as e:
                print(f"\n✗ Failed to create KnowledgeBaseResponse: {e}")
        else:
            print("✗ similarity_threshold attribute not found!")
    else:
        print("No knowledge bases found in database")
finally:
    db.close()
