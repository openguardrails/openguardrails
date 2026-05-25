# Custom Scanners Guide

> Build custom detection logic tailored to your business needs

## Table of Contents

- [Overview](#overview)
- [Scanner Package System](#scanner-package-system)
- [Scanner Types](#scanner-types)
- [Creating Custom Scanners](#creating-custom-scanners)
- [Managing Scanners](#managing-scanners)
- [Best Practices](#best-practices)
- [Examples](#examples)

---

## Overview

**Custom Scanners** are one of OpenGuardrails' most powerful features, allowing you to create domain-specific detection logic without code changes.

### Why Custom Scanners?

Traditional guardrails have **fixed, hardcoded risk types** (e.g., S1-S21). This creates problems:

- ❌ Can't add new detection rules without code changes
- ❌ Can't tailor detection to your specific business
- ❌ Can't implement industry-specific compliance rules
- ❌ Requires database migrations for new risk types

**OpenGuardrails' Scanner System solves this:**

- ✅ **Unlimited custom scanners** - create as many as you need
- ✅ **No code changes** - add scanners via API or UI
- ✅ **No database migrations** - dynamic scanner system
- ✅ **Business-specific** - tailor to your exact use case
- ✅ **Application-scoped** - different scanners per application

---

## Scanner Package System

OpenGuardrails uses a flexible **three-tier scanner architecture**:

### 📦 Three Types of Scanner Packages

#### 1. 🔧 **Built-in Official Packages**
System packages that come pre-installed:
- **Tags**: S1-S21
- **Examples**: Violent Crime (S5), Prompt Injection (S9), Data Leak (S11)
- **Management**: Managed through scanner package system
- **Configuration**: Can enable/disable, adjust risk levels

#### 2. 🛒 **Purchasable Official Packages**
Premium scanner packages from OpenGuardrails team:
- **Tags**: S22-S99 (reserved)
- **Examples**: Healthcare Compliance, Financial Regulations, Legal Industry
- **Management**: Purchase through admin marketplace
- **Updates**: Regular updates from OpenGuardrails team

#### 3. ✨ **Custom Scanners (S100+)**
User-defined scanners for business-specific needs:
- **Tags**: S100, S101, S102... (automatically assigned)
- **Scope**: Application-specific (not tenant-wide)
- **Types**: GenAI, Regex, Keyword
- **Flexibility**: Unlimited creation, full control

---

## Scanner Types

OpenGuardrails supports three scanner implementation types:

### 1. GenAI Scanner (Intelligent)

**Best for**: Complex concepts, contextual understanding

**How it works**: Uses OpenGuardrails-Text model for intelligent detection

**Examples**:
- Medical advice detection
- Financial advice screening
- Brand reputation monitoring
- Complex policy violations

**Performance**: ~100-200ms per detection (model call required)

**Accuracy**: High - understands context and nuance

```python
{
  "scanner_type": "genai",
  "name": "Medical Advice Detection",
  "definition": "Detect medical advice, diagnosis, or treatment recommendations that should only come from licensed professionals",
  "risk_level": "high_risk"
}
```

### 2. Regex Scanner (Pattern-Based)

**Best for**: Structured data, pattern matching

**How it works**: Python regex pattern matching

**Examples**:
- Credit card numbers
- Social security numbers
- API keys / credentials
- Email patterns
- URLs matching specific domains

**Performance**: <1ms per detection (instant)

**Accuracy**: Perfect for structured data

```python
{
  "scanner_type": "regex",
  "name": "Credit Card Detection",
  "pattern": r"\b(?:\d{4}[-\s]?){3}\d{4}\b",
  "risk_level": "high_risk"
}
```

### 3. Keyword Scanner (Simple)

**Best for**: Simple blocking, keyword lists

**How it works**: Comma-separated keyword matching

**Examples**:
- Competitor brand names
- Prohibited terminology
- Banned product names
- Internal codenames

**Performance**: <1ms per detection (instant)

**Accuracy**: Exact match only

```python
{
  "scanner_type": "keyword",
  "name": "Competitor Brands",
  "keywords": "CompetitorA, CompetitorB, CompetitorC",
  "risk_level": "low_risk"
}
```

---

## Creating Custom Scanners

### Via API

#### Example 1: Banking Fraud Detection (GenAI)

```python
import requests

response = requests.post(
    "http://localhost:5000/api/v1/custom-scanners",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "scanner_type": "genai",
        "name": "Bank Fraud Detection",
        "definition": "Detect banking fraud attempts, financial scams, illegal financial advice, and money laundering instructions",
        "risk_level": "high_risk",
        "scan_prompt": True,
        "scan_response": True,
        "notes": "Custom scanner for financial applications"
    }
)

scanner = response.json()
print(f"Created scanner: {scanner['tag']}")  # Output: S100
```

#### Example 2: Internal Codename Protection (Keyword)

```python
response = requests.post(
    "http://localhost:5000/api/v1/custom-scanners",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "scanner_type": "keyword",
        "name": "Internal Codename Protection",
        "keywords": "ProjectPhoenix, ProjectTitan, AlphaBuild",
        "risk_level": "medium_risk",
        "scan_prompt": False,
        "scan_response": True,
        "notes": "Prevent leaking internal project codenames"
    }
)
```

#### Example 3: API Key Detection (Regex)

```python
response = requests.post(
    "http://localhost:5000/api/v1/custom-scanners",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "scanner_type": "regex",
        "name": "API Key Detection",
        "pattern": r"(sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36,}|AIza[a-zA-Z0-9]{35})",
        "risk_level": "high_risk",
        "scan_prompt": True,
        "scan_response": True,
        "notes": "Detect OpenAI, GitHub, Google API keys"
    }
)
```

### Via Python SDK

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails(api_key="sk-xxai-your-key")

# Create custom scanner
scanner = client.create_custom_scanner(
    scanner_type="genai",
    name="Healthcare Compliance",
    definition="Detect medical advice, HIPAA violations, or protected health information",
    risk_level="high_risk",
    scan_prompt=True,
    scan_response=True
)

print(f"Created scanner: {scanner.tag}")
```

### Via Web UI

1. Navigate to `/platform/config/custom-scanners`
2. Click "Create Custom Scanner"
3. Fill in the form:
   - **Scanner Type**: GenAI / Regex / Keyword
   - **Name**: Descriptive name
   - **Definition/Pattern/Keywords**: Detection logic
   - **Risk Level**: high_risk / medium_risk / low_risk
   - **Scan Prompt**: Enable input scanning
   - **Scan Response**: Enable output scanning
4. Click "Save"

---

## Managing Scanners

### List Custom Scanners

```python
GET /api/v1/custom-scanners
Authorization: Bearer your-jwt-token
```

**Response:**
```json
{
  "scanners": [
    {
      "id": "scanner_xxx",
      "tag": "S100",
      "scanner_type": "genai",
      "name": "Bank Fraud Detection",
      "definition": "...",
      "risk_level": "high_risk",
      "enabled": true,
      "scan_prompt": true,
      "scan_response": true,
      "created_at": "2025-01-15T10:30:00Z"
    }
  ]
}
```

### Update Scanner

```python
PUT /api/v1/custom-scanners/{scanner_id}
Authorization: Bearer your-jwt-token

{
  "enabled": false,
  "risk_level": "medium_risk"
}
```

### Delete Scanner

```python
DELETE /api/v1/custom-scanners/{scanner_id}
Authorization: Bearer your-jwt-token
```

### Using Scanners in Detection

Custom scanners are **automatically used** in detection requests:

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("sk-xxai-your-key")

# Detection automatically uses all enabled scanners (including custom)
response = client.check_prompt(
    "How can I launder money through my bank account?",
    application_id="your-banking-app-id"
)

print(f"Risk level: {response.overall_risk_level}")
print(f"Matched scanners: {response.matched_scanner_tags}")
# Output: "high_risk" and "S5,S100" (Violent Crime + Bank Fraud Detection)
```

---

## Best Practices

### 1. Choose the Right Scanner Type

| Scenario | Recommended Type | Reason |
|----------|-----------------|---------|
| Complex business rules | GenAI | Understands context and nuance |
| Structured data patterns | Regex | Fast and precise |
| Simple keyword blocking | Keyword | Instant and straightforward |
| Policy interpretation | GenAI | Can understand natural language policies |
| Format validation | Regex | Perfect for structured formats |

### 2. Write Clear Definitions (GenAI)

**Good GenAI Definition:**
```
Detect attempts to manipulate stock prices through false information,
pump-and-dump schemes, or insider trading discussions. Include both
explicit trading advice and subtle market manipulation tactics.
```

**Bad GenAI Definition:**
```
Bad trading stuff
```

### 3. Test Your Scanners

Always test scanners with:
- **Positive cases** (should detect)
- **Negative cases** (should not detect)
- **Edge cases** (boundary conditions)

```python
test_cases = [
    # Positive (should detect)
    "How do I avoid paying taxes on my investment gains?",
    "Let's discuss ways to manipulate the market price",

    # Negative (should not detect)
    "What is the difference between stocks and bonds?",
    "Can you explain how capital gains tax works?",
]

for test in test_cases:
    result = client.check_prompt(test)
    print(f"{test}: {result.overall_risk_level}")
```

### 4. Use Application Scoping

Custom scanners are **application-specific**. Create different scanners for different applications:

```python
# Banking app scanners
- S100: Bank Fraud Detection
- S101: Money Laundering Detection
- S102: Credit Card Fraud

# Healthcare app scanners
- S100: HIPAA Violation Detection
- S101: Medical Malpractice Advice
- S102: Prescription Drug Abuse

# E-commerce app scanners
- S100: Price Manipulation Detection
- S101: Fake Review Detection
- S102: Prohibited Product Detection
```

### 5. Performance Considerations

- **GenAI scanners**: ~100-200ms each (run in parallel)
- **Regex/Keyword scanners**: <1ms each (negligible)
- **Total latency**: Typically <10% increase with custom scanners

**Optimization tips:**
- Use regex/keyword for simple patterns
- Combine multiple keywords into one scanner
- Disable scanners you don't need
- Use application scoping to limit active scanners

### 6. Risk Level Guidelines

**high_risk**: Violations require immediate blocking
- Security threats
- Legal violations
- Financial fraud
- Data breaches

**medium_risk**: Violations may require review or substitution
- Policy violations
- Inappropriate content
- Competitor mentions
- Off-topic content

**low_risk**: Violations for monitoring only
- Minor policy breaches
- Borderline cases
- Informational tracking

---

## Examples

### Example 1: Healthcare Compliance Scanner

```python
{
    "scanner_type": "genai",
    "name": "HIPAA Violation Detection",
    "definition": """
    Detect violations of HIPAA (Health Insurance Portability and Accountability Act):
    - Requests for patient medical records without authorization
    - Sharing of protected health information (PHI) without consent
    - Discussions of patient cases with identifying information
    - Unauthorized access to medical databases
    - Improper disclosure of health information

    Focus on privacy violations, not general medical discussions.
    """,
    "risk_level": "high_risk",
    "scan_prompt": True,
    "scan_response": True
}
```

### Example 2: Brand Competitor Monitor

```python
{
    "scanner_type": "keyword",
    "name": "Competitor Brand Mentions",
    "keywords": "CompetitorA, CompetitorB, CompetitorC, RivalProduct, AlternativeSolution",
    "risk_level": "low_risk",
    "scan_prompt": False,
    "scan_response": True,
    "notes": "Monitor but don't block competitor mentions in responses"
}
```

### Example 3: Internal Secret Detection

```python
{
    "scanner_type": "regex",
    "name": "AWS Access Key Detection",
    "pattern": r"(AKIA[0-9A-Z]{16})",
    "risk_level": "high_risk",
    "scan_prompt": True,
    "scan_response": True,
    "notes": "Detect AWS access keys to prevent credential leakage"
}
```

### Example 4: Financial Advice Compliance

```python
{
    "scanner_type": "genai",
    "name": "Unlicensed Financial Advice",
    "definition": """
    Detect providing specific investment advice, stock picks, or financial planning
    recommendations that should only come from licensed financial advisors:
    - Specific stock buy/sell recommendations
    - Portfolio allocation advice
    - Tax optimization strategies
    - Retirement planning recommendations

    Do NOT flag general financial education or publicly available information.
    """,
    "risk_level": "medium_risk",
    "scan_prompt": False,
    "scan_response": True
}
```

### Example 5: Off-Topic Detector

```python
{
    "scanner_type": "genai",
    "name": "Customer Support Scope",
    "definition": """
    This is a customer support chatbot for TechProduct Inc. Detect requests that are:
    - Completely unrelated to our products or services
    - Personal advice (relationship, health, legal)
    - Requests to perform tasks outside our product scope
    - Entertainment or general conversation

    Valid topics: Product features, troubleshooting, billing, account management.
    """,
    "risk_level": "low_risk",
    "scan_prompt": True,
    "scan_response": False
}
```

---

## Migration from Risk Types

### Automatic Migration

Existing S1-S21 risk type configurations are **automatically migrated** to the scanner package system on upgrade - no manual intervention required.

### Custom Scanner Tag Allocation

- **S1-S21**: Built-in official packages (pre-installed)
- **S22-S99**: Purchasable official packages (reserved)
- **S100+**: Custom user-defined scanners (auto-assigned)

When you create a custom scanner, tags are automatically assigned:
- First custom scanner: S100
- Second custom scanner: S101
- And so on...

---

## Management Interface

### Web UI Pages

- **Official Scanners** (`/platform/config/official-scanners`):
  - View and configure S1-S21 built-in packages
  - Enable/disable official scanners
  - Adjust risk levels

- **Custom Scanners** (`/platform/config/custom-scanners`):
  - Create new custom scanners
  - Edit existing custom scanners
  - Enable/disable per application

- **Admin Marketplace** (`/platform/admin/package-marketplace`):
  - Upload purchasable packages (admin only)
  - Manage commercial scanner packages
  - Approve purchase requests

---

## API Reference

### Create Custom Scanner

```http
POST /api/v1/custom-scanners
Authorization: Bearer {jwt-token}
Content-Type: application/json

{
  "scanner_type": "genai|regex|keyword",
  "name": "string",
  "definition": "string (for genai)",
  "pattern": "string (for regex)",
  "keywords": "string (for keyword, comma-separated)",
  "risk_level": "high_risk|medium_risk|low_risk",
  "scan_prompt": true|false,
  "scan_response": true|false,
  "notes": "string (optional)"
}
```

### List Custom Scanners

```http
GET /api/v1/custom-scanners?application_id={app_id}
Authorization: Bearer {jwt-token}
```

### Update Custom Scanner

```http
PUT /api/v1/custom-scanners/{scanner_id}
Authorization: Bearer {jwt-token}
Content-Type: application/json

{
  "enabled": true|false,
  "risk_level": "high_risk|medium_risk|low_risk",
  "scan_prompt": true|false,
  "scan_response": true|false
}
```

### Delete Custom Scanner

```http
DELETE /api/v1/custom-scanners/{scanner_id}
Authorization: Bearer {jwt-token}
```

---

## Next Steps

- 📙 [Read API Reference](API_REFERENCE.md)
- 📕 [Understand Architecture](ARCHITECTURE.md)
- 🏢 [Enterprise PoC Guide](ENTERPRISE_POC.md)

---

**Last Updated**: 2025-01-21
**Need Help?** Contact thomas@openguardrails.com
