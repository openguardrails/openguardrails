# Disposal Strategy

> Understanding OpenGuardrails' detection and disposal priority logic.

## Table of Contents

- [Overview](#overview)
- [Detection Types](#detection-types)
- [Disposal Priority Logic](#disposal-priority-logic)
- [Input Content Flow](#input-content-flow)
- [Output Content Flow](#output-content-flow)
- [Output Detection Details](#output-detection-details)
- [Disposal Actions](#disposal-actions)
- [Configuration](#configuration)
- [Performance Benefits](#performance-benefits)

---

## Overview

OpenGuardrails uses a **priority-based disposal strategy** that processes detection results in a specific order. This ensures efficient resource usage and logical consistency in handling risks.

### Core Principle

**Security/Compliance detection runs first. DLP (Data Leakage Prevention) detection only runs if Security/Compliance passes.**

This design follows the principle that:
1. If content violates security or compliance policies, it should be blocked or replaced immediately
2. DLP detection is unnecessary when content is already being blocked or replaced
3. DLP detection only matters when the content is otherwise allowed

---

## Detection Types

OpenGuardrails performs three types of detection:

### 1. Security Detection
Detects content that poses security risks:
- Prompt injection attacks (S9)
- Violent crime content (S5)
- Weapons of mass destruction (S15)
- Sexual crimes (S17)

### 2. Compliance Detection
Detects content that violates compliance policies:
- Sensitive political topics (S2, S3)
- Harm to minors (S4)
- Non-violent crime (S6)
- Pornography (S7)
- Professional advice risks (S19, S20, S21)

### 3. DLP Detection (Data Leakage Prevention)
Detects sensitive data in content:
- Personal identifiable information (PII)
- Credit card numbers
- ID card numbers
- Phone numbers
- Addresses
- Custom entity types

---

## Disposal Priority Logic

### Priority Order

```
┌─────────────────────────────────────────────────────────────┐
│                    DETECTION FLOW                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Blacklist Check                                         │
│     └─ If hit → BLOCK immediately                           │
│                                                             │
│  2. Whitelist Check                                         │
│     └─ If hit → PASS immediately                            │
│                                                             │
│  3. Security/Compliance Detection                           │
│     └─ Analyze content for policy violations                │
│                                                             │
│  4. Check Security/Compliance Disposal Action               │
│     ├─ If action = BLOCK or REPLACE                         │
│     │   └─ Skip DLP detection (not needed)                  │
│     │   └─ Return block/replace response                    │
│     │                                                       │
│     └─ If action = PASS                                     │
│         └─ Continue to DLP detection                        │
│                                                             │
│  5. DLP Detection (only if Security/Compliance passes)      │
│     └─ Detect sensitive data in content                     │
│                                                             │
│  6. Final Disposal Action                                   │
│     └─ Based on DLP results (if any)                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Why This Order?

1. **Logical Consistency**: If content is already being blocked for security reasons, there's no need to check for data leakage - the content won't be processed anyway.

2. **Performance Optimization**: DLP detection can be expensive (especially GenAI-based entity detection). Skipping it when unnecessary improves response time.

3. **Clear Decision Making**: The final action is determined by the highest-priority concern. Security/Compliance violations take precedence over data leakage concerns.

---

## Input Content Flow

For user input (prompts), the disposal strategy follows this flow:

```
User Input
    │
    ▼
┌───────────────────────────────────┐
│ 1. Blacklist/Whitelist Check      │
│    - Blacklist hit → Block        │
│    - Whitelist hit → Pass         │
└───────────────┬───────────────────┘
                │
                ▼
┌───────────────────────────────────┐
│ 2. Security/Compliance Detection  │
│    - Scanner-based detection      │
│    - Risk categories: S1-S21      │
└───────────────┬───────────────────┘
                │
                ▼
┌───────────────────────────────────┐
│ 3. Get Security/Compliance Action │
│    ┌────────────────────────────┐ │
│    │ High Risk  → Block/Replace │ │
│    │ Medium Risk → Replace      │ │
│    │ Low Risk   → Pass/Replace  │ │
│    │ No Risk    → Pass          │ │
│    └────────────────────────────┘ │
└───────────────┬───────────────────┘
                │
        ┌───────┴───────┐
        │               │
        ▼               ▼
┌─────────────┐   ┌─────────────────────┐
│ Block/Replace│   │ Pass                │
│             │   │                     │
│ Skip DLP    │   │ Run DLP Detection   │
│ Return now  │   │                     │
└─────────────┘   └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ 4. DLP Detection    │
                  │    - Detect PII     │
                  │    - Assess risk    │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ 5. DLP Disposal     │
                  │   - Block           │
                  │   - Switch Private  │
                  │   - Anonymize       │
                  │   - Pass            │
                  └─────────────────────┘
```

---

## Output Content Flow

For LLM output (responses), the same priority logic applies:

```
LLM Output
    │
    ▼
┌───────────────────────────────────┐
│ 1. Restore Anonymized Data        │
│    (if input was anonymized)      │
└───────────────┬───────────────────┘
                │
                ▼
┌───────────────────────────────────┐
│ 2. Security/Compliance Detection  │
│    - Same scanners as input       │
│    - Output-specific policies     │
└───────────────┬───────────────────┘
                │
                ▼
┌───────────────────────────────────┐
│ 3. Get Security/Compliance Action │
│    - Same priority logic          │
│    - Output-specific thresholds   │
└───────────────┬───────────────────┘
                │
        ┌───────┴───────┐
        │               │
        ▼               ▼
┌─────────────┐   ┌─────────────────────┐
│ Block/Replace│   │ Pass                │
│             │   │                     │
│ Skip DLP    │   │ Run DLP Detection   │
│ Return now  │   │                     │
└─────────────┘   └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ 4. DLP Detection    │
                  │    - Check output   │
                  │    - Detect leakage │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ 5. DLP Disposal     │
                  │   - Anonymize       │
                  │   - Pass            │
                  └─────────────────────┘
```

---

## Output Detection Details

This section clarifies what content is actually detected during output detection, especially for different input disposal actions.

### What Content is Detected in Output?

| Input Disposal Action | Content Sent to LLM | Output Detection Target |
|----------------------|---------------------|------------------------|
| `pass` | Original content | LLM's original output |
| `anonymize` | Anonymized content (with placeholders) | **Restored content** (after placeholder replacement) |
| `switch_private_model` | Original content | **Private model's output** (still detected) |
| `block` / `replace` | N/A (request blocked) | N/A |

### Anonymization Flow: Detection on Restored Content

When input is anonymized, the output detection flow is:

```
Input: "My phone is 13812345678"
         │
         ▼
┌─────────────────────────────────┐
│ Input Anonymization             │
│ "My phone is __phone_1__"       │
│                                 │
│ restore_mapping:                │
│   {"__phone_1__": "13812345678"}│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ LLM Processing                  │
│ (receives anonymized content)   │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ LLM Output                      │
│ "Your phone __phone_1__ is..."  │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 1. Restore Placeholders         │
│    "Your phone 13812345678..."  │
│    (using restore_mapping)      │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 2. Output Detection             │◄── Detects RESTORED content
│    - Security/Compliance check  │
│    - DLP check on real data     │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 3. Final Response               │
│    - May anonymize again        │
│    - Or pass through            │
└─────────────────────────────────┘
```

**Key Point**: Output detection runs on the **restored content** (with real sensitive data), not on the placeholder-containing output from the LLM. This ensures:

1. **Complete Protection**: Real sensitive data is checked even after restoration
2. **Consistent Policy**: Output DLP policies apply to actual data, not placeholders
3. **Audit Accuracy**: Detection logs reflect the true content being returned

### Private Model Switching: Output Still Detected

When input triggers `switch_private_model` action, the private model's output is **still subject to output detection**:

```
Input with sensitive data
         │
         ▼
┌─────────────────────────────────┐
│ Input Detection                 │
│ DLP Risk: medium_risk           │
│ Action: switch_private_model    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Route to Private Model          │
│ (on-premise / data-safe model)  │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Private Model Output            │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Output Detection                │◄── Still runs on private model output
│ - Security/Compliance check     │
│ - DLP check                     │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Apply Output Disposal           │
│ - May block/anonymize if needed │
└─────────────────────────────────┘
```

**Rationale**: Even private models can generate outputs that:
- Contain security/compliance violations (e.g., harmful content)
- Leak sensitive data from training or context
- Violate output-specific policies

Therefore, output detection is **always performed** regardless of which model generates the response.

### Streaming vs Non-Streaming Output Detection

| Mode | Detection Timing | Behavior on Risk Detected |
|------|-----------------|---------------------------|
| **Non-streaming** | Synchronous (before response) | Can block/modify response |
| **Streaming** | Asynchronous (after stream ends) | Log only (cannot unsend chunks) |

For streaming mode, output detection happens after the full response is streamed to the client. If a risk is detected, it is logged for audit but cannot block the already-sent content.

### Code Reference

The output detection logic is implemented in:

- **Restoration**: `gateway_integration_service.py:368-372`
  ```python
  if effective_mapping:
      restored_content = self._restore_content(content, effective_mapping)
  ```

- **Detection on restored content**: `gateway_integration_service.py:382-392`
  ```python
  messages.append({"role": "assistant", "content": restored_content})
  detection_result = await detection_guardrail_service.detect_messages(messages, ...)
  ```

- **Private model output detection**: `proxy_api.py:870-899` (both streaming and non-streaming paths call output detection)

---

## Disposal Actions

### Security/Compliance Actions

| Action | Description | When Used |
|--------|-------------|-----------|
| `block` | Reject the request with error message | High-risk violations |
| `replace` | Return a predefined response | Medium/Low-risk violations |
| `pass` | Allow the content to proceed | No violations detected |

### DLP Actions (Input)

| Action | Description | When Used |
|--------|-------------|-----------|
| `block` | Reject the request | High-risk data exposure |
| `switch_private_model` | Route to private/on-premise model | Medium-risk data exposure |
| `anonymize` | Replace sensitive data with placeholders | Low-risk data exposure |
| `pass` | Allow content as-is | No sensitive data |

### DLP Actions (Output)

| Action | Description | When Used |
|--------|-------------|-----------|
| `anonymize` | Mask sensitive data in response | Data leakage detected |
| `pass` | Return response as-is | No sensitive data |

---

## Configuration

### Application-Level Policy

Each application can configure its own disposal actions:

```json
{
  "application_id": "app-123",

  // Security/Compliance disposal (input)
  "general_input_high_risk_action": "block",
  "general_input_medium_risk_action": "replace",
  "general_input_low_risk_action": "pass",

  // Security/Compliance disposal (output)
  "general_output_high_risk_action": "block",
  "general_output_medium_risk_action": "replace",
  "general_output_low_risk_action": "pass",

  // DLP disposal (input)
  "input_high_risk_action": "block",
  "input_medium_risk_action": "switch_private_model",
  "input_low_risk_action": "anonymize",

  // DLP disposal (output)
  "output_high_risk_action": "anonymize",
  "output_medium_risk_action": "anonymize",
  "output_low_risk_action": "pass"
}
```

### Tenant-Level Defaults

Tenant-level policies serve as defaults when no application-specific policy exists.

---

## Performance Benefits

The priority-based disposal strategy provides significant performance benefits:

### 1. Reduced DLP Processing

When security/compliance detection triggers a block or replace action:
- DLP detection is completely skipped
- No GenAI-based entity detection calls
- No format detection or segmentation overhead

### 2. Typical Savings

| Scenario | Without Priority | With Priority |
|----------|-----------------|---------------|
| Security violation detected | ~200ms (DLP runs) | ~50ms (DLP skipped) |
| Compliance violation detected | ~200ms (DLP runs) | ~50ms (DLP skipped) |
| No violations | ~200ms | ~200ms |

### 3. Resource Efficiency

- Fewer API calls to GenAI entity detection
- Reduced database queries for entity type configurations
- Lower CPU usage for regex pattern matching

---

## Code Reference

The disposal strategy is implemented in:

- **Detection Service**: `backend/services/detection_guardrail_service.py`
  - `check_guardrails()` - Main detection orchestration
  - `_get_general_policy_action()` - Get security/compliance disposal action
  - `_get_policy_action()` - Get final disposal action (including DLP)

- **Gateway Integration**: `backend/services/gateway_integration_service.py`
  - `process_input()` - Input content processing
  - `process_output()` - Output content processing

- **Disposal Service**: `backend/services/data_leakage_disposal_service.py`
  - `get_general_risk_action()` - Security/compliance action lookup
  - `get_disposal_action()` - DLP action lookup

---

## Summary

The disposal strategy follows a clear priority:

1. **Security/Compliance First**: Always run security and compliance detection
2. **Early Exit**: If block or replace is required, skip DLP detection
3. **DLP Only When Needed**: Only run DLP detection when content passes security/compliance
4. **Configurable**: Both security/compliance and DLP actions are configurable per application

This design ensures both logical consistency and optimal performance.
