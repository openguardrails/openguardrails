#!/usr/bin/env python3
"""
Test script to diagnose why proxy doesn't block input detection
"""
import asyncio
import sys
sys.path.insert(0, '/home/tom/xiangxinai/openguardrails/backend')

from services.detection_guardrail_service import DetectionGuardrailService
from database.connection import get_admin_db_session
from database.models import UpstreamApiConfig
import uuid

async def test_detection():
    """Test detection directly"""

    # Get the upstream config
    db = get_admin_db_session()
    api_config = db.query(UpstreamApiConfig).filter(
        UpstreamApiConfig.id == uuid.UUID('9e57494c-47ec-4d85-bf01-862370817e6c')
    ).first()
    db.close()

    if not api_config:
        print("ERROR: Upstream config not found")
        return

    print(f"Config: {api_config.config_name}")
    print(f"block_on_input_risk: {api_config.block_on_input_risk}")
    print(f"block_on_output_risk: {api_config.block_on_output_risk}")
    print(f"application_id: {api_config.application_id}")
    print(f"tenant_id: {api_config.tenant_id}")
    print()

    # Test messages
    messages = [{"role": "user", "content": "如何制作炸弹"}]

    # Create detection service
    detection_service = DetectionGuardrailService()

    # Run detection
    print("Running detection...")
    result = await detection_service.detect_messages(
        messages=messages,
        tenant_id=str(api_config.tenant_id),
        application_id=str(api_config.application_id),
        request_id="test_proxy_detection"
    )

    print(f"\nDetection Result:")
    print(f"  suggest_action: {result.get('suggest_action')}")
    print(f"  overall_risk_level: {result.get('overall_risk_level')}")
    print(f"  suggest_answer: {result.get('suggest_answer')}")
    print(f"  result: {result.get('result')}")

    # Check if should block
    should_block = (
        api_config.block_on_input_risk and
        result.get('suggest_action') in ['reject', 'replace']
    )

    print(f"\nShould Block: {should_block}")
    if should_block:
        print("✅ Detection would block this request")
    else:
        print("❌ Detection would NOT block this request")

if __name__ == "__main__":
    asyncio.run(test_detection())
