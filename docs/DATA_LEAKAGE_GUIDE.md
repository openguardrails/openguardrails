# Data Leakage Prevention Guide

> Comprehensive guide for configuring and using OpenGuardrails' data leakage prevention system.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Safe Model Configuration](#safe-model-configuration)
- [Policy Configuration](#policy-configuration)
- [Format Detection](#format-detection)
- [Smart Segmentation](#smart-segmentation)
- [Disposal Strategies](#disposal-strategies)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [API Integration](#api-integration)

---

## Overview

OpenGuardrails' Data Leakage Prevention (DLP) system provides **multi-layer protection** against sensitive data exposure when using AI models. The system automatically:

1. **Detects sensitive data** in user prompts (ID cards, phone numbers, addresses, etc.)
2. **Assesses risk levels** (High/Medium/Low) based on entity types and context
3. **Applies disposal strategies** based on configured policies
4. **Protects data** through blocking, model switching, or anonymization

### Key Features

- **Format-Aware Detection**: Automatically identifies JSON, YAML, CSV, Markdown, or plain text
- **Smart Segmentation**: Splits content intelligently based on format for parallel processing
- **Three Disposal Methods**: Block, switch to safe model, or anonymize
- **Application-Level Policies**: Customize strategies per application
- **Safe Model Priority System**: Flexible fallback model selection

---

## Architecture

### Detection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User Request                                                  │
│    - Text prompt with potential sensitive data                   │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Format Detection (if enabled)                                 │
│    - JSON: Detect by parsing                                     │
│    - YAML: Detect by YAML syntax                                 │
│    - CSV: Detect by comma/tab patterns                           │
│    - Markdown: Detect by headers/lists                           │
│    - Plain Text: Fallback                                        │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Smart Segmentation (if enabled)                               │
│    - JSON: Split by top-level objects                            │
│    - YAML: Split by top-level keys                               │
│    - CSV: Split by rows                                          │
│    - Markdown: Split by sections (## headers)                    │
│    - Plain Text: Process as single segment                       │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Parallel Entity Detection                                     │
│    ┌──────────────────┐  ┌──────────────────┐                   │
│    │ Regex Entities   │  │ GenAI Entities   │                   │
│    │ - Full text only │  │ - Per segment    │                   │
│    │ - ID cards       │  │ - Context-aware  │                   │
│    │ - Phone numbers  │  │ - Parallel async │                   │
│    └──────────────────┘  └──────────────────┘                   │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Risk Aggregation                                              │
│    - Aggregate results from all segments                         │
│    - Highest risk level wins                                     │
│    - Merge all detected entities                                 │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. Policy-Based Disposal                                         │
│    ┌─────────────┬──────────────┬───────────────┐               │
│    │ High Risk   │ Medium Risk  │ Low Risk      │               │
│    │ → Block     │ → Safe Model │ → Anonymize   │ (defaults)    │
│    └─────────────┴──────────────┴───────────────┘               │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. Action Execution                                              │
│    - Block: Return error, log incident                           │
│    - Switch Model: Forward to safe model, log switch             │
│    - Anonymize: Replace entities, forward to original model      │
│    - Pass: Allow request, log detection                          │
└─────────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Proxy Service (Port 5002)                                        │
│ - Receives /v1/chat/completions requests                         │
│ - Calls DataLeakageDisposalService                               │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ DataLeakageDisposalService                                       │
│ - Fetches policy for application                                 │
│ - Coordinates disposal based on risk level                       │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ├─────────────────────┬──────────────────────┐
                     ▼                     ▼                      ▼
┌──────────────────────────┐ ┌──────────────────┐ ┌──────────────┐
│ FormatDetectionService   │ │ SegmentationSvc  │ │ DataSecSvc   │
│ - Detect content format  │ │ - Smart split    │ │ - Entity det │
└──────────────────────────┘ └──────────────────┘ └──────────────┘
```

---

## Quick Start

### Step 1: Configure Safe Models

1. Navigate to **Config > Proxy Models**
2. Create or edit a model configuration
3. Enable **"Data Safety Attributes"**:
   - **Is Data Safe**: Mark as safe (e.g., on-premise, private deployment)
   - **Is Default Safe Model**: Set as tenant-wide default
   - **Safe Model Priority**: Set priority (0-100, higher = preferred)

**Example**: Enterprise private deployment
```
Model: gpt-4o (Private)
Provider: Azure OpenAI
Is Data Safe: ✓ Enabled
Is Default Safe Model: ✓ Enabled
Safe Model Priority: 90
```

### Step 2: Configure Data Leakage Policy

1. Navigate to **Config > Data Leakage Policy**
2. Configure **Risk Level Actions**:
   - **High Risk**: Choose disposal action (default: Block)
   - **Medium Risk**: Choose disposal action (default: Switch Safe Model)
   - **Low Risk**: Choose disposal action (default: Anonymize)
3. Select **Safe Model** (or leave as "Current Safe Model - Default")
4. Enable **Feature Toggles**:
   - **Format Detection**: Recommended ✓
   - **Smart Segmentation**: Recommended ✓
5. Click **Save Policy**

### Step 3: Test Protection

Send a test request with sensitive data:

```bash
curl -X POST http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-xxai-your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {
        "role": "user",
        "content": "My ID card number is 110101199001011234, can you help me?"
      }
    ]
  }'
```

**Expected Behavior** (with default high-risk = block):
- Request is blocked
- Error response returned
- Incident logged in detection results

---

## Safe Model Configuration

### What is a Safe Model?

A **safe model** is a model marked as **data-safe** for handling sensitive information. Common examples:

- **On-Premise Models**: Self-hosted models (Ollama, vLLM, etc.)
- **Private Cloud**: Enterprise Azure OpenAI, AWS Bedrock with private endpoints
- **Air-Gapped Models**: Fully isolated deployments
- **Compliance-Certified**: Models meeting specific regulatory requirements (GDPR, HIPAA, etc.)

### Safety Attributes

#### `is_data_safe` (Boolean)

Marks the model as safe for sensitive data.

**When to enable**:
- ✅ Enterprise private deployment
- ✅ On-premise/self-hosted
- ✅ Air-gapped environment
- ✅ Compliance-certified endpoint
- ❌ Public cloud APIs (OpenAI, Anthropic, etc.)

#### `is_default_safe_model` (Boolean)

Sets this model as the **tenant-wide default** for safe model switching.

**Rules**:
- Only **one model per tenant** should have this enabled
- Used when policy doesn't specify a `safe_model_id`
- Overrides priority-based selection

#### `safe_model_priority` (Integer 0-100)

Sets selection priority when multiple safe models exist.

**Priority Rules**:
1. Higher number = higher priority
2. Used when no default safe model is set
3. Ties are broken by creation time (newest first)

**Recommended Ranges**:
- **90-100**: Production-grade, fully compliant
- **70-89**: Standard safe models
- **50-69**: Testing/staging safe models
- **0-49**: Low-priority fallbacks

### Safe Model Selection Priority

When the disposal action is **"switch_safe_model"**, the system selects a model using this priority:

```
1. Application Policy Safe Model (safe_model_id in policy)
   ↓ (if null)
2. Tenant Default Safe Model (is_default_safe_model = true)
   ↓ (if none)
3. Highest Priority Safe Model (safe_model_priority DESC)
   ↓ (if none)
4. ERROR: No safe model available
```

### Configuration Examples

#### Example 1: Single Safe Model

```
Model: llama-3-70b-local
Provider: Ollama
API Base URL: http://local-ollama:11434
Is Data Safe: ✓ Enabled
Is Default Safe Model: ✓ Enabled
Safe Model Priority: 80
```

**Result**: This model is always selected for "switch_safe_model" actions.

---

#### Example 2: Multi-Tier Safe Models

**Production Model**:
```
Model: gpt-4o-azure-private
Provider: Azure OpenAI
Is Data Safe: ✓ Enabled
Is Default Safe Model: ✓ Enabled (tenant default)
Safe Model Priority: 95
```

**Staging Model**:
```
Model: gpt-4o-mini-azure-private
Provider: Azure OpenAI
Is Data Safe: ✓ Enabled
Is Default Safe Model: ✗ Disabled
Safe Model Priority: 70
```

**Fallback Model**:
```
Model: llama-3-8b-local
Provider: Ollama
Is Data Safe: ✓ Enabled
Is Default Safe Model: ✗ Disabled
Safe Model Priority: 50
```

**Result**: gpt-4o-azure-private is selected by default (default flag overrides priority).

---

#### Example 3: Application-Specific Safe Model

**Tenant Default**:
```
Model: gpt-4o-mini-safe
Is Default Safe Model: ✓ Enabled
```

**High-Security Application Policy**:
```
Application: HIPAA-Compliant-App
Safe Model ID: llama-3-70b-airgap (explicitly configured)
```

**Result**: HIPAA app uses llama-3-70b-airgap; other apps use gpt-4o-mini-safe.

---

## Policy Configuration

### Risk Level Actions

Configure disposal actions for each risk level:

#### High Risk (Default: Block)

**Recommended Action**: **Block**

Entities typically classified as high risk:
- ID card numbers (exact patterns)
- Credit card numbers
- Social security numbers
- Bank account numbers
- Passport numbers

**Alternative Actions**:
- **Switch Safe Model**: If you have a compliant model that can handle these
- **Anonymize**: For testing environments only (not recommended for production)

---

#### Medium Risk (Default: Switch Safe Model)

**Recommended Action**: **Switch Safe Model**

Entities typically classified as medium risk:
- Full names with context
- Detailed addresses
- Company internal information
- Medical record IDs
- License plate numbers

**Alternative Actions**:
- **Block**: For zero-tolerance policies
- **Anonymize**: For development/testing

---

#### Low Risk (Default: Anonymize)

**Recommended Action**: **Anonymize**

Entities typically classified as low risk:
- Phone numbers (generic patterns)
- Email addresses
- Partial addresses (city names only)
- Organization names
- Generic personal information

**Alternative Actions**:
- **Pass**: For audit-only mode
- **Switch Safe Model**: For maximum protection

---

#### Pass (Allow)

**Use Case**: Audit-only mode

When set to **Pass**:
- Request is allowed to proceed unchanged
- Detection result is logged for audit
- No protective action taken
- Useful for monitoring before enforcement

---

### Safe Model Selection in Policy

#### Option 1: Use Current Safe Model (Default)

```json
{
  "safe_model_id": null
}
```

**Behavior**: Use tenant's default safe model or highest priority safe model.

**Use When**:
- Standard protection is sufficient
- Tenant has one primary safe model
- Centralized management is preferred

---

#### Option 2: Specify Application-Specific Safe Model

```json
{
  "safe_model_id": "uuid-of-safe-model"
}
```

**Behavior**: Always use this specific model for this application.

**Use When**:
- Application has specific compliance requirements
- Different apps need different safe models
- Multi-tier protection strategy

---

### Feature Toggles

#### Enable Format Detection

**Default**: Enabled (Recommended)

**When Enabled**:
- Automatically detects JSON, YAML, CSV, Markdown, Plain Text
- Enables format-aware smart segmentation
- Improves detection accuracy for structured data

**When to Disable**:
- All content is plain text
- Performance is critical (saves ~5-10ms per request)
- Testing legacy behavior

---

#### Enable Smart Segmentation

**Default**: Enabled (Recommended)

**Requires**: Format Detection enabled

**When Enabled**:
- Splits content based on format structure
- Processes segments in parallel (faster)
- Improves context accuracy for GenAI entities

**When to Disable**:
- Content is always short (< 500 chars)
- Only using regex entities (segmentation not needed)
- Testing legacy behavior

**Performance Impact**:
- **Small content (< 1KB)**: Negligible
- **Medium content (1-10KB)**: 20-40% faster (parallel processing)
- **Large content (> 10KB)**: 40-60% faster

---

## Format Detection

### Supported Formats

| Format      | Detection Method                  | Confidence Threshold |
|-------------|-----------------------------------|----------------------|
| JSON        | `json.loads()` parsing            | 100% (parse success) |
| YAML        | YAML syntax patterns              | 70%+                 |
| CSV         | Comma/tab delimiters, row count   | 60%+                 |
| Markdown    | Headers, lists, code blocks       | 60%+                 |
| Plain Text  | Fallback (no structure detected)  | N/A                  |

### Format Detection Examples

#### JSON Detection

**Input**:
```json
{
  "user": {
    "name": "张三",
    "id_card": "110101199001011234",
    "phone": "13800138000"
  }
}
```

**Detection Result**: `json` (confidence: 100%)

---

#### YAML Detection

**Input**:
```yaml
user:
  name: 张三
  id_card: 110101199001011234
  phone: 13800138000
```

**Detection Result**: `yaml` (confidence: 85%)

---

#### CSV Detection

**Input**:
```csv
name,id_card,phone
张三,110101199001011234,13800138000
李四,110101199001015678,13900139000
```

**Detection Result**: `csv` (confidence: 90%)

---

#### Markdown Detection

**Input**:
```markdown
## User Information

- Name: 张三
- ID Card: 110101199001011234
- Phone: 13800138000

## Contact Details

Email: zhangsan@example.com
```

**Detection Result**: `markdown` (confidence: 80%)

---

#### Plain Text (Fallback)

**Input**:
```
My name is 张三, ID card: 110101199001011234, phone: 13800138000
```

**Detection Result**: `plain_text` (confidence: 100%, fallback)

---

## Smart Segmentation

### Segmentation Strategies

#### JSON Segmentation

**Strategy**: Split by top-level objects/arrays

**Example Input**:
```json
{
  "user1": {
    "name": "张三",
    "id_card": "110101199001011234"
  },
  "user2": {
    "name": "李四",
    "id_card": "110101199001015678"
  }
}
```

**Segments** (2):
1. `{"user1": {"name": "张三", "id_card": "110101199001011234"}}`
2. `{"user2": {"name": "李四", "id_card": "110101199001015678"}}`

**Benefit**: Each user's data is processed independently with full context.

---

#### YAML Segmentation

**Strategy**: Split by top-level keys

**Example Input**:
```yaml
user1:
  name: 张三
  id_card: 110101199001011234
user2:
  name: 李四
  id_card: 110101199001015678
```

**Segments** (2):
1. `user1:\n  name: 张三\n  id_card: 110101199001011234`
2. `user2:\n  name: 李四\n  id_card: 110101199001015678`

---

#### CSV Segmentation

**Strategy**: Split by rows (keep header)

**Example Input**:
```csv
name,id_card,phone
张三,110101199001011234,13800138000
李四,110101199001015678,13900139000
```

**Segments** (2):
1. `name,id_card,phone\n张三,110101199001011234,13800138000`
2. `name,id_card,phone\n李四,110101199001015678,13900139000`

**Benefit**: Each row retains column headers for context.

---

#### Markdown Segmentation

**Strategy**: Split by ## sections

**Example Input**:
```markdown
## User 1

Name: 张三
ID Card: 110101199001011234

## User 2

Name: 李四
ID Card: 110101199001015678
```

**Segments** (2):
1. `## User 1\n\nName: 张三\nID Card: 110101199001011234`
2. `## User 2\n\nName: 李四\nID Card: 110101199001015678`

---

#### Plain Text (No Segmentation)

**Strategy**: Process as single segment

**Example Input**:
```
My name is 张三, ID: 110101199001011234. My friend 李四's ID is 110101199001015678.
```

**Segments** (1):
1. (entire text as single segment)

---

### Segmentation Limits

| Format      | Max Segments | Max Segment Size | Behavior if Exceeded        |
|-------------|--------------|------------------|-----------------------------|
| JSON        | 50           | 10,000 chars     | Fallback to full text       |
| YAML        | 50           | 10,000 chars     | Fallback to full text       |
| CSV         | 100          | 5,000 chars/row  | Fallback to full text       |
| Markdown    | 30           | 15,000 chars     | Fallback to full text       |
| Plain Text  | 1            | Unlimited        | N/A                         |

**Fallback Behavior**: If segmentation exceeds limits, process entire content as single segment (plain text mode).

---

## Disposal Strategies

### Block

**Action**: Reject request completely

**Use Case**:
- High-risk data detected
- Zero-tolerance policies
- Compliance requirements

**Implementation**:
1. Stop request processing
2. Return error response to client
3. Log incident with detected entities
4. Optionally trigger alerts

**Response Example**:
```json
{
  "error": {
    "message": "Request blocked due to data leakage risk: High risk entities detected (ID card, credit card)",
    "type": "data_leakage_blocked",
    "code": "high_risk_detected"
  }
}
```

**Logging**:
- Risk level: HIGH
- Action taken: BLOCK
- Detected entities: [list of entity types]
- Tenant ID, Application ID, User ID
- Timestamp, request hash

---

### Switch Safe Model

**Action**: Redirect request to data-safe model

**Use Case**:
- Medium/high-risk data detected
- Safe model available
- Maintain user experience while protecting data

**Implementation**:
1. Fetch safe model using priority logic
2. Replace `model` parameter in request
3. Forward to safe model API
4. Return response to client
5. Log model switch

**Example Flow**:
```
User Request:
  model: gpt-4o (public API)
  content: "My ID is 110101199001011234"

↓ Detection: Medium Risk

↓ Policy: switch_safe_model

Safe Model Selection:
  gpt-4o-azure-private (is_default_safe_model)

Modified Request:
  model: gpt-4o-azure-private
  content: "My ID is 110101199001011234" (unchanged)

↓ Forward to Azure Private Endpoint

Response: (from safe model)
```

**Logging**:
- Risk level: MEDIUM
- Action taken: SWITCH_SAFE_MODEL
- Original model: gpt-4o
- Safe model used: gpt-4o-azure-private
- Detected entities: [list]

**Error Handling**:
- If no safe model available → fallback to BLOCK
- If safe model API fails → return original error + log incident

---

### Anonymize

**Action**: Replace sensitive entities with placeholders

**Use Case**:
- Low-risk data detected
- Model needs context but not exact values
- Development/testing environments

**Implementation**:
1. Detect sensitive entities
2. Generate placeholders (e.g., `[ID_CARD_1]`, `[PHONE_NUMBER_1]`)
3. Replace entities in content
4. Forward anonymized request to original model
5. Return response (with placeholders)
6. Log anonymization

**Anonymization Examples**:

**Original**:
```
My name is 张三, ID card: 110101199001011234, phone: 13800138000
```

**Anonymized**:
```
My name is 张三, ID card: [ID_CARD_1], phone: [PHONE_NUMBER_1]
```

**Original (JSON)**:
```json
{
  "user": "张三",
  "id_card": "110101199001011234",
  "credit_card": "6222021234567890123"
}
```

**Anonymized**:
```json
{
  "user": "张三",
  "id_card": "[ID_CARD_1]",
  "credit_card": "[CREDIT_CARD_1]"
}
```

**Placeholder Format**:
- Pattern: `[{ENTITY_TYPE}_{INDEX}]`
- Preserves structure (e.g., JSON remains valid JSON)
- Reversible (for response processing, if needed)

**Logging**:
- Risk level: LOW
- Action taken: ANONYMIZE
- Entities anonymized: count by type
- Original content hash (for audit)

---

### Pass (Audit Only)

**Action**: Allow request unchanged, log detection

**Use Case**:
- Monitoring before enforcement
- Audit trails
- Low-sensitivity applications

**Implementation**:
1. Run detection as normal
2. Log results
3. Forward request unchanged
4. Return response unchanged

**Logging**:
- Risk level: (detected level)
- Action taken: PASS
- Detected entities: [list]
- Note: "Audit-only mode"

---

## Best Practices

### Policy Configuration

#### 1. Start with Default Strategy

**Recommended Initial Configuration**:
- High Risk → Block
- Medium Risk → Switch Safe Model
- Low Risk → Anonymize
- Format Detection: Enabled
- Smart Segmentation: Enabled

**Why**: This provides strong protection while maintaining usability.

---

#### 2. Use Audit Mode Before Enforcement

**Workflow**:
1. Set all actions to **Pass** initially
2. Monitor detection results for 1-2 weeks
3. Review false positives/negatives
4. Adjust entity types or thresholds
5. Enable enforcement (Block/Switch/Anonymize)

**Benefit**: Prevents disrupting users with false positives.

---

#### 3. Configure Safe Models First

**Before enabling "Switch Safe Model"**:
1. ✅ Configure at least one safe model
2. ✅ Test safe model API connectivity
3. ✅ Set default safe model or priorities
4. ✅ Document safe model selection logic

**Why**: Prevents errors when policy tries to switch but no safe model exists.

---

#### 4. Tier Policies by Application Sensitivity

**Example**:

**Public Chatbot** (low sensitivity):
- High → Anonymize
- Medium → Anonymize
- Low → Pass

**Internal HR System** (high sensitivity):
- High → Block
- Medium → Switch Safe Model
- Low → Anonymize

**Compliance-Critical App** (maximum sensitivity):
- High → Block
- Medium → Block
- Low → Switch Safe Model

---

### Safe Model Management

#### 1. Maintain Model Redundancy

**Recommendation**: Configure at least **2 safe models** per priority tier.

**Example**:
- Primary: Azure OpenAI Private (priority 95)
- Secondary: AWS Bedrock Private (priority 90)
- Fallback: Local Ollama (priority 70)

**Benefit**: Ensures availability even if primary safe model fails.

---

#### 2. Test Safe Models Regularly

**Monthly Checklist**:
- [ ] Test API connectivity
- [ ] Verify authentication tokens
- [ ] Check rate limits
- [ ] Test with sample sensitive data
- [ ] Review performance metrics

---

#### 3. Document Model Capabilities

**For each safe model, document**:
- Model name and version
- Provider and endpoint
- Data residency (region, country)
- Compliance certifications (GDPR, HIPAA, SOC2, etc.)
- Performance characteristics (latency, throughput)
- Cost per request
- Maintenance windows

---

### Detection Tuning

#### 1. Review Detection Results Weekly

**Metrics to Monitor**:
- Total detections by risk level
- False positive rate (user reports)
- Blocked requests (High risk)
- Model switches (Medium risk)
- Anonymizations (Low risk)

**Action Items**:
- Whitelist known false positives
- Adjust entity type sensitivities
- Update regex patterns if needed

---

#### 2. Balance Security and Usability

**Signs of Over-Blocking**:
- High user complaint rate
- Many legitimate requests blocked
- Users bypass system (direct API calls)

**Solution**:
- Lower high-risk thresholds
- Move some entities from high → medium risk
- Use anonymize instead of block for borderline cases

---

#### 3. Use Format Detection for Structured Data

**When to Enable**:
- Users submit JSON/YAML/CSV frequently
- API integrations (structured payloads)
- Batch data processing

**When to Disable**:
- 100% plain text chatbot
- Performance-critical (latency < 50ms required)

---

### Security Hardening

#### 1. Rotate API Keys for Safe Models

**Recommendation**: Rotate every 90 days

**Process**:
1. Generate new API key in provider console
2. Update safe model configuration
3. Test connectivity
4. Revoke old key after 7-day overlap

---

#### 2. Monitor for Data Leakage Incidents

**Set up alerts for**:
- High-risk detections (immediate alert)
- Blocked requests exceeding threshold (hourly)
- Safe model switch failures (immediate)
- Unusually high detection rate (daily)

**Alert Channels**:
- Email: Security team
- Slack/Teams: On-call engineer
- SIEM: Log aggregation system

---

#### 3. Implement Rate Limits

**Recommendation**:
- Set rate limits on proxy keys
- Separate limits for high-risk vs. normal requests
- Block users exceeding limits temporarily

**Example**:
- Normal requests: 100/minute
- High-risk detections: 10/minute (triggers alert if exceeded)

---

#### 4. Audit Logs Retention

**Recommendation**:
- Retain detection logs for **90 days** minimum
- Archive critical incidents for **1 year**
- Anonymize logs older than retention period

**Compliance**:
- GDPR: Right to erasure (delete user data on request)
- HIPAA: 6-year retention requirement

---

## Troubleshooting

### Common Issues

#### Issue 1: "No safe model available" Error

**Symptom**:
```json
{
  "error": "No safe model available for switching"
}
```

**Cause**: Policy is set to "switch_safe_model", but no safe models are configured.

**Solution**:
1. Navigate to **Config > Proxy Models**
2. Edit an existing model or create a new one
3. Enable **"Is Data Safe"**
4. Set **"Is Default Safe Model"** or assign a priority
5. Save and test again

---

#### Issue 2: Safe Model Switch Not Working

**Symptom**: Medium-risk data detected, but request still goes to original model.

**Possible Causes**:

**Cause 1**: Policy action is not set to "switch_safe_model"
- **Solution**: Check **Config > Data Leakage Policy** → Medium Risk Action

**Cause 2**: Safe model API is failing
- **Solution**: Check logs for safe model API errors, verify connectivity

**Cause 3**: Safe model is marked inactive
- **Solution**: Navigate to **Proxy Models** → ensure "Is Active" is enabled

---

#### Issue 3: Format Detection Not Working

**Symptom**: JSON content is processed as plain text.

**Possible Causes**:

**Cause 1**: Format detection is disabled
- **Solution**: Enable **"Enable Format Detection"** in policy

**Cause 2**: JSON is invalid
- **Solution**: Validate JSON syntax (use `jq` or online validator)

**Cause 3**: Content is too small (< 50 chars)
- **Solution**: Format detection requires minimum content length

---

#### Issue 4: Smart Segmentation Causing Errors

**Symptom**: Error "Segmentation failed" or "Maximum segments exceeded".

**Possible Causes**:

**Cause 1**: Content exceeds segmentation limits (50 objects, 100 rows, etc.)
- **Solution**: System should fallback to full text automatically; check logs

**Cause 2**: Malformed content (e.g., unclosed JSON objects)
- **Solution**: Validate content structure before sending

**Solution**: Disable smart segmentation temporarily:
1. Navigate to **Config > Data Leakage Policy**
2. Disable **"Enable Smart Segmentation"**
3. Save and test

---

#### Issue 5: High False Positive Rate

**Symptom**: Legitimate requests are blocked or anonymized incorrectly.

**Examples**:
- Generic IDs (e.g., "ORDER-123456") detected as ID cards
- Phone-like numbers (e.g., "40404040") detected as phone numbers

**Solutions**:

**Solution 1**: Adjust entity type sensitivity
- Navigate to **Config > Data Security** → Entity Types
- Lower sensitivity or disable problematic entity types

**Solution 2**: Use whitelist patterns
- Add known false-positive patterns to whitelist
- Example: `ORDER-\d+` for order IDs

**Solution 3**: Use "Pass" action temporarily
- Set action to "Pass" (audit-only)
- Review logs for patterns
- Create whitelist rules
- Re-enable enforcement

---

#### Issue 6: Performance Degradation

**Symptom**: Requests are slow (> 2 seconds) with format detection/segmentation enabled.

**Possible Causes**:

**Cause 1**: Very large content (> 50KB)
- **Solution**: Consider disabling segmentation for large content

**Cause 2**: Too many segments (> 50)
- **Solution**: System should fallback automatically; verify in logs

**Cause 3**: Safe model API is slow
- **Solution**: Monitor safe model latency; consider faster model

**Performance Optimization**:
1. Disable format detection if all content is plain text
2. Disable smart segmentation for short content (< 1KB)
3. Use faster safe models (e.g., gpt-4o-mini instead of gpt-4o)
4. Increase proxy service worker count

---

### Debug Mode

#### Enable Debug Logging

**Method 1**: Environment variable
```bash
export LOG_LEVEL=DEBUG
docker compose restart openguardrails-admin openguardrails-proxy
```

**Method 2**: Runtime flag (development)
```python
# In proxy_service.py or admin_service.py
import logging
logging.getLogger("openguardrails").setLevel(logging.DEBUG)
```

#### View Debug Logs

```bash
# Proxy service logs (disposal logic)
docker logs -f openguardrails-proxy | grep -i "data_leakage"

# Admin service logs (policy configuration)
docker logs -f openguardrails-admin | grep -i "policy"

# Database queries (if needed)
docker logs -f openguardrails-postgres
```

#### Key Log Messages

**Format Detection**:
```
DEBUG - Format detected: json (confidence: 95%)
DEBUG - Segmentation enabled: True, format: json
DEBUG - Segments created: 5
```

**Entity Detection**:
```
DEBUG - Regex entities detected: ['ID_CARD'] in full text
DEBUG - GenAI entities detected in segment 1: ['PHONE_NUMBER', 'ADDRESS']
DEBUG - Aggregated risk: MEDIUM (highest from 5 segments)
```

**Disposal Action**:
```
INFO - Data leakage risk: MEDIUM, action: SWITCH_SAFE_MODEL
DEBUG - Safe model selected: gpt-4o-azure-private (priority: 95)
DEBUG - Request forwarded to safe model
```

---

## API Integration

### Using the Proxy Gateway (Recommended)

**Endpoint**: `POST http://localhost:5002/v1/chat/completions`

**Authentication**: Proxy API Key (`sk-xxai-...`)

**Example Request**:
```bash
curl -X POST http://localhost:5002/v1/chat/completions \
  -H "Authorization: Bearer sk-xxai-your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {
        "role": "user",
        "content": "{\"user\": \"张三\", \"id_card\": \"110101199001011234\"}"
      }
    ]
  }'
```

**Automatic Protection**:
1. Request is intercepted by proxy
2. Content is analyzed for data leakage
3. Disposal action is applied (block/switch/anonymize)
4. Response is returned

**Advantages**:
- **Zero code changes**: Works with OpenAI SDK
- **Automatic protection**: No manual API calls
- **Transparent**: Users don't see protection layer

---

### Direct Detection API (Advanced)

**Endpoint**: `POST http://localhost:5001/v1/guardrails`

**Authentication**: Proxy API Key (`sk-xxai-...`)

**Use Case**: Custom workflows, manual control over disposal

**Example Request**:
```bash
curl -X POST http://localhost:5001/v1/guardrails \
  -H "Authorization: Bearer sk-xxai-your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "My ID card is 110101199001011234"
      }
    ],
    "enable_compliance_detection": false,
    "enable_security_detection": true,
    "enable_data_detection": true
  }'
```

**Response**:
```json
{
  "is_safe": false,
  "highest_risk_level": "MEDIUM",
  "data_risks": [
    {
      "detected": true,
      "risk_level": "MEDIUM",
      "detected_entity_types": ["ID_CARD"],
      "risk_details": ["ID card number detected: 110101..."],
      "suggested_action": "SWITCH_SAFE_MODEL"
    }
  ]
}
```

**Client-Side Disposal**:
```python
response = requests.post(
    "http://localhost:5001/v1/guardrails",
    headers={"Authorization": "Bearer sk-xxai-your-key"},
    json={"messages": messages, "enable_data_detection": True}
)

result = response.json()

if not result["is_safe"]:
    action = result["data_risks"][0]["suggested_action"]

    if action == "BLOCK":
        return {"error": "Request blocked due to data leakage risk"}

    elif action == "SWITCH_SAFE_MODEL":
        # Switch to safe model manually
        messages_safe = messages  # Send to safe model
        safe_response = openai.ChatCompletion.create(
            model="gpt-4o-azure-private",
            messages=messages_safe
        )
        return safe_response

    elif action == "ANONYMIZE":
        # Anonymize manually (simplified)
        anonymized_content = anonymize_entities(messages, result["data_risks"][0]["detected_entity_types"])
        safe_response = openai.ChatCompletion.create(
            model="gpt-4o",
            messages=anonymized_content
        )
        return safe_response

else:
    # Safe, proceed normally
    response = openai.ChatCompletion.create(model="gpt-4o", messages=messages)
    return response
```

---

### Programmatic Policy Management

#### Get Current Policy

```python
import requests

response = requests.get(
    "http://localhost:5000/api/v1/config/data-leakage-policy",
    headers={
        "Authorization": "Bearer <JWT_TOKEN>",
        "X-Application-ID": "<APPLICATION_ID>"
    }
)

policy = response.json()
print(policy["high_risk_action"])  # e.g., "block"
```

#### Update Policy

```python
import requests

requests.put(
    "http://localhost:5000/api/v1/config/data-leakage-policy",
    headers={
        "Authorization": "Bearer <JWT_TOKEN>",
        "X-Application-ID": "<APPLICATION_ID>"
    },
    json={
        "high_risk_action": "block",
        "medium_risk_action": "switch_safe_model",
        "low_risk_action": "anonymize",
        "safe_model_id": "uuid-of-safe-model",  # or null for default
        "enable_format_detection": True,
        "enable_smart_segmentation": True
    }
)
```

#### List Available Safe Models

```python
response = requests.get(
    "http://localhost:5000/api/v1/config/safe-models",
    headers={"Authorization": "Bearer <JWT_TOKEN>"}
)

safe_models = response.json()
for model in safe_models:
    print(f"{model['config_name']}: priority {model['safe_model_priority']}")
```

---

## FAQ

### General Questions

**Q: What happens if I don't configure any safe models?**

A: If a disposal action is set to "switch_safe_model" and no safe models are configured, the system will **fallback to BLOCK** and return an error. Configure at least one safe model before enabling "switch_safe_model" actions.

---

**Q: Can I use multiple safe models for different risk levels?**

A: Not directly. The system uses a single safe model selection per request. However, you can:
1. Configure application-specific policies with different `safe_model_id` values
2. Use priority to prefer different models for different applications

---

**Q: Does anonymization preserve JSON/YAML structure?**

A: **Yes**. The anonymization service preserves content structure:
- Valid JSON remains valid JSON
- YAML structure is maintained
- CSV rows remain valid CSV

Placeholders are inserted in place of sensitive values (e.g., `"id_card": "[ID_CARD_1]"`).

---

**Q: What is the performance impact of format detection and segmentation?**

A:
- **Format Detection**: ~5-10ms per request
- **Smart Segmentation**: ~10-20ms per request
- **Parallel Processing Gain**: 20-60% faster for large content (> 1KB)

**Net impact**: Slight overhead for small content, significant speedup for large content.

---

### Configuration Questions

**Q: Should I enable format detection for plain text chatbots?**

A: **No**. If all content is plain text, format detection is unnecessary and adds minimal overhead. Disable it for best performance.

---

**Q: Can I set different policies for different applications?**

A: **Yes**. Policies are configured per-application using the `X-Application-ID` header. Each application can have unique risk actions and safe models.

---

**Q: What happens if the safe model API fails?**

A: The system logs the error and **falls back to BLOCK** to prevent data leakage. Configure redundant safe models to minimize failures.

---

### Detection Questions

**Q: Why are some ID cards detected as low risk instead of high risk?**

A: Risk level depends on:
1. **Entity type**: ID cards are typically high risk
2. **Detection confidence**: Low confidence may reduce risk level
3. **Context**: Partial or obfuscated IDs may be medium/low risk

Check detection logs to see specific risk assignments.

---

**Q: Can I customize entity types (e.g., add "Employee ID")?**

A: **Yes**. Navigate to **Config > Data Security > Entity Type Management** to add custom entity types with regex or GenAI-based detection.

---

**Q: How do I test data leakage protection without affecting users?**

A: Use **audit-only mode**:
1. Set all risk actions to **"Pass"**
2. Monitor detection results for 1-2 weeks
3. Review logs to identify false positives
4. Enable enforcement after tuning

---

### Compliance Questions

**Q: Is the system GDPR-compliant?**

A: OpenGuardrails provides **technical controls** for data protection (detection, blocking, anonymization). GDPR compliance depends on:
1. **Data residency**: Use on-premise or EU-region safe models
2. **Data retention**: Configure log retention policies
3. **User rights**: Implement data deletion on request

Consult legal counsel for full compliance.

---

**Q: Does anonymization meet HIPAA "de-identification" requirements?**

A: Anonymization **reduces risk** but may not meet HIPAA Safe Harbor or Expert Determination standards. For HIPAA:
1. Use **"Block"** action for high-risk PHI
2. Use **safe models** with BAAs (Business Associate Agreements)
3. Conduct formal de-identification review

---

**Q: Can I use the system for PCI DSS compliance?**

A: **Yes**, for detecting credit card numbers. Recommended configuration:
- High Risk (credit cards) → **Block**
- Medium Risk → **Switch Safe Model** (PCI-compliant endpoint)
- Safe Model: Tokenization gateway or PCI-certified API

**Note**: Full PCI DSS requires additional controls (encryption, access control, logging).

---

## Appendix

### Disposal Action Decision Matrix

| Risk Level | Default Action       | Alternative Actions              | Use Case                          |
|------------|----------------------|----------------------------------|-----------------------------------|
| **High**   | Block                | Switch Safe Model, Anonymize     | Critical data (ID, credit cards)  |
| **Medium** | Switch Safe Model    | Block, Anonymize, Pass           | Sensitive data (names, addresses) |
| **Low**    | Anonymize            | Pass, Switch Safe Model, Block   | Generic PII (phone, email)        |

---

### Entity Type Risk Mapping

| Entity Type          | Typical Risk Level | Regex-Based | GenAI-Based |
|----------------------|--------------------|-------------|-------------|
| ID Card              | High               | ✓           | ✓           |
| Credit Card          | High               | ✓           | ✗           |
| Social Security #    | High               | ✓           | ✓           |
| Bank Account         | High               | ✓           | ✓           |
| Passport Number      | High               | ✓           | ✓           |
| Full Name            | Medium             | ✗           | ✓           |
| Address              | Medium             | ✗           | ✓           |
| Medical Record ID    | Medium             | ✓           | ✓           |
| License Plate        | Medium             | ✓           | ✓           |
| Phone Number         | Low                | ✓           | ✓           |
| Email Address        | Low                | ✓           | ✓           |
| Organization Name    | Low                | ✗           | ✓           |

**Note**: Risk levels are configurable per-entity type in **Config > Data Security**.

---

### Glossary

- **Data Leakage Prevention (DLP)**: System for detecting and protecting sensitive data
- **Safe Model**: Model marked as data-safe for handling sensitive information
- **Disposal Strategy**: Action taken when data leakage is detected (block, switch, anonymize, pass)
- **Format Detection**: Automatic identification of content structure (JSON, YAML, etc.)
- **Smart Segmentation**: Format-aware content splitting for parallel processing
- **Regex Entity**: Entity detected using regular expressions (e.g., ID card patterns)
- **GenAI Entity**: Entity detected using AI models (e.g., names, addresses)
- **Risk Aggregation**: Combining detection results from multiple segments
- **Application Policy**: Per-application configuration for disposal strategies
- **Safe Model Priority**: Ranking system for selecting safe models

---

### Support

**Documentation**:
- API Reference: `/docs/API_REFERENCE.md`
- Deployment Guide: `/docs/DEPLOYMENT.md`
- Migration Guide: `/docs/MIGRATION_GUIDE.md`

**Community**:
- GitHub Issues: https://github.com/openguardrails/openguardrails/issues
- Email: thomas@openguardrails.com

**Enterprise Support**:
- Contact: thomas@openguardrails.com
- SLA: Available for enterprise customers

---

**Last Updated**: 2025-01-05
**Version**: 5.0.7+
