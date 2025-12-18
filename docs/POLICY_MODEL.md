# Policy vs Safety Model

> Understanding OpenGuardrails' enterprise-first approach to AI governance

## Table of Contents

- [The Fundamental Difference](#the-fundamental-difference)
- [Content Safety vs Policy Enforcement](#content-safety-vs-policy-enforcement)
- [Why Enterprises Need Policy Enforcement](#why-enterprises-need-policy-enforcement)
- [OpenGuardrails' Approach](#openguardrails-approach)
- [Real-World Examples](#real-world-examples)
- [Implementation Guide](#implementation-guide)

---

## The Fundamental Difference

Most LLM guardrails ask:

> *"Is this content unsafe?"*

OpenGuardrails asks:

> **"Is this behavior allowed by your enterprise policy at runtime?"**

This is a **fundamental shift** in how we think about AI safety in enterprise contexts.

---

## Content Safety vs Policy Enforcement

### Traditional Content Safety Guardrails

**Focus**: Detecting universally unsafe content

**Typical Categories**:
- Violence
- Hate speech
- Sexual content
- Self-harm
- Illegal activities

**Decision**: Binary safe/unsafe judgment

**Use Case**: Consumer-facing AI products

**Example Tools**:
- OpenAI Moderation API
- Perspective API
- Content filtering services

**Limitations**:
- ❌ Fixed categories
- ❌ No business context
- ❌ One-size-fits-all approach
- ❌ Can't enforce enterprise-specific rules
- ❌ Limited customization

### OpenGuardrails Policy Enforcement

**Focus**: Runtime enforcement of enterprise policies

**Policy Types**:
- Content safety (yes, included)
- **Business constraints**
- **Scope control**
- **Compliance requirements**
- **Brand protection**
- **Data governance**
- **Custom enterprise rules**

**Decision**: Policy-based action (pass/reject/substitute)

**Use Case**: Enterprise AI applications

**Capabilities**:
- ✅ Custom scanners for any policy
- ✅ Business context awareness
- ✅ Configurable per application
- ✅ Enforce ANY enterprise rule
- ✅ Unlimited customization

---

## Why Enterprises Need Policy Enforcement

### Enterprise AI Has Different Requirements

#### 1. **Scope Control**

**Problem**: AI should only answer questions within its designated scope

**Example**: Customer support chatbot should only help with product issues, not give dating advice

**How it works**:
```python
# Create custom scanner for scope control
{
    "scanner_type": "genai",
    "name": "Customer Support Scope",
    "definition": "This chatbot is for TechProduct support only. Detect off-topic requests including personal advice, entertainment, or unrelated products.",
    "risk_level": "medium_risk"
}
```

**Traditional safety guardrails**: ❌ Can't detect this
**OpenGuardrails**: ✅ Policy-enforced scope control

#### 2. **Brand Protection**

**Problem**: AI shouldn't recommend competitors or make unauthorized commitments

**Example**: Don't mention competitor products, don't promise discounts without approval

**How it works**:
```python
# Competitor mention scanner
{
    "scanner_type": "keyword",
    "name": "Competitor Mentions",
    "keywords": "CompetitorA, CompetitorB, AlternativeProduct",
    "risk_level": "low_risk"
}

# Unauthorized commitment scanner
{
    "scanner_type": "genai",
    "name": "Unauthorized Commitments",
    "definition": "Detect promises of refunds, discounts, or policy exceptions without proper authorization.",
    "risk_level": "high_risk"
}
```

**Traditional safety guardrails**: ❌ Not designed for this
**OpenGuardrails**: ✅ Business policy enforcement

#### 3. **Compliance Requirements**

**Problem**: Industry-specific regulations must be enforced

**Example**: Financial advisors can't give specific investment advice without disclaimers

**How it works**:
```python
# Financial compliance scanner
{
    "scanner_type": "genai",
    "name": "Financial Advice Compliance",
    "definition": "Detect specific investment advice, stock picks, or financial planning that requires licensed advisor disclaimer.",
    "risk_level": "high_risk"
}
```

**Traditional safety guardrails**: ❌ Generic categories only
**OpenGuardrails**: ✅ Industry-specific compliance

#### 4. **Data Governance**

**Problem**: Internal information should never be exposed

**Example**: Project codenames, unreleased features, internal metrics

**How it works**:
```python
# Internal information scanner
{
    "scanner_type": "keyword",
    "name": "Internal Codenames",
    "keywords": "ProjectPhoenix, AlphaRelease, InternalMetric247",
    "risk_level": "high_risk",
    "scan_response": True  # Only check outputs
}
```

**Traditional safety guardrails**: ❌ No concept of proprietary info
**OpenGuardrails**: ✅ Data governance enforcement

#### 5. **Professional Licensing**

**Problem**: AI shouldn't give advice that requires professional licensing

**Example**: Medical diagnosis, legal advice, tax planning

**How it works**:
```python
# Medical advice scanner
{
    "scanner_type": "genai",
    "name": "Medical Diagnosis Prevention",
    "definition": "Detect specific medical diagnoses, treatment recommendations, or prescriptions that require licensed medical professional.",
    "risk_level": "high_risk"
}
```

**Traditional safety guardrails**: ✅ Sometimes included (but as "safety", not "policy")
**OpenGuardrails**: ✅ Policy-based approach with custom definitions

---

## OpenGuardrails' Approach

### Three-Layer Policy Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 1: Safety                          │
│  Traditional content safety (violence, hate, NSFW)          │
│  ✓ Universal unsafe content detection                       │
└─────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                Layer 2: Compliance                          │
│  Industry regulations and legal requirements                │
│  ✓ HIPAA, GDPR, financial regulations                      │
│  ✓ Professional licensing requirements                      │
└─────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Layer 3: Business Policy                       │
│  Enterprise-specific rules and constraints                  │
│  ✓ Scope control                                           │
│  ✓ Brand protection                                        │
│  ✓ Data governance                                         │
│  ✓ Custom business rules                                   │
└─────────────────────────────────────────────────────────────┘
```

### Policy Configuration

Each layer is **independently configurable**:

```python
{
    # Layer 1: Safety
    "enable_security": True,        # Prompt injection, jailbreak
    "enable_compliance": True,      # Violence, hate, NSFW

    # Layer 2: Compliance (via official scanners)
    "official_scanners": ["S1", "S2", "S5", "S9"],

    # Layer 3: Business Policy (via custom scanners)
    "custom_scanners": ["S100", "S101", "S102"]
}
```

---

## Real-World Examples

### Example 1: Financial Services Chatbot

**Business Context**: Investment advisory chatbot for retail customers

**Policies to Enforce**:

1. **Safety**: No violence, hate, or inappropriate content
2. **Compliance**: SEC regulations on investment advice
3. **Business**: No specific stock picks without disclaimers
4. **Scope**: Only answer investment-related questions
5. **Brand**: Don't mention competitor brokers

**Implementation**:

```python
# Official scanners (built-in)
- S9: Prompt Injection
- S5: Violent Crime

# Custom scanners (business-specific)
- S100: Unlicensed Investment Advice
- S101: Off-Topic Financial Questions
- S102: Competitor Broker Mentions
- S103: Unauthorized Fee Discounts
```

**Result**: Comprehensive policy enforcement, not just "safe/unsafe"

### Example 2: Healthcare Patient Portal

**Business Context**: AI assistant in patient portal

**Policies to Enforce**:

1. **Safety**: No harmful health advice
2. **Compliance**: HIPAA privacy requirements
3. **Business**: No medical diagnosis (liability)
4. **Scope**: Only answer portal usage questions
5. **Data**: Never expose other patients' data

**Implementation**:

```python
# Official scanners
- S9: Prompt Injection
- S11: Privacy/Data Leak

# Custom scanners
- S100: Medical Diagnosis Attempts
- S101: HIPAA Violation Detection
- S102: Patient Portal Scope Control
- S103: Prescription Requests
```

### Example 3: E-Commerce Support Bot

**Business Context**: Customer service chatbot for e-commerce

**Policies to Enforce**:

1. **Safety**: No abuse or harassment
2. **Compliance**: Consumer protection laws
3. **Business**: No unauthorized refunds/discounts
4. **Scope**: Only help with orders and products
5. **Brand**: Maintain brand voice and values

**Implementation**:

```python
# Official scanners
- S9: Prompt Injection
- S10: Profanity
- S14: Harassment

# Custom scanners
- S100: Unauthorized Refund Promises
- S101: Discount Code Generation
- S102: Competitor Product Recommendations
- S103: Support Scope Control
```

---

## Implementation Guide

### Step 1: Define Your Policies

**Exercise**: List all rules your AI must follow

**Categories**:
- [ ] Content safety (universal)
- [ ] Industry compliance (regulations)
- [ ] Business constraints (scope, brand)
- [ ] Data governance (confidentiality)
- [ ] Professional licensing (legal liability)
- [ ] Custom enterprise rules

**Template**:
```markdown
## Policy: [Name]

**Type**: Safety / Compliance / Business
**Severity**: High / Medium / Low
**Applies To**: Prompts / Responses / Both
**Description**: [What behavior to detect]
**Examples**:
  - Positive: [Should be detected]
  - Negative: [Should not be detected]
```

### Step 2: Choose Scanner Types

For each policy, choose implementation:

| Policy Type | Recommended Scanner |
|-------------|-------------------|
| Keyword blocking | Keyword Scanner |
| Pattern matching (emails, IDs) | Regex Scanner |
| Conceptual rules | GenAI Scanner |
| Contextual interpretation | GenAI Scanner |

### Step 3: Create Custom Scanners

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("your-api-key")

# Create scanner for each business policy
for policy in your_business_policies:
    scanner = client.create_custom_scanner(
        scanner_type=policy.scanner_type,
        name=policy.name,
        definition=policy.definition,
        risk_level=policy.severity,
        scan_prompt=policy.check_input,
        scan_response=policy.check_output
    )
```

### Step 4: Configure Risk Actions

**For each risk level, define action**:

```python
# High Risk → Block immediately
"high_risk": {
    "action": "reject",
    "response_template": "I cannot assist with that request."
}

# Medium Risk → Substitute with safe answer
"medium_risk": {
    "action": "replace",
    "use_knowledge_base": True
}

# Low Risk → Allow but log
"low_risk": {
    "action": "pass",
    "alert": True
}
```

### Step 5: Monitor and Iterate

**Continuous improvement**:
1. Review detection logs
2. Identify false positives/negatives
3. Refine scanner definitions
4. Add new scanners as policies evolve

---

## Key Takeaways

### What Makes OpenGuardrails Different

1. **Policy-First Design**
   - Not just "safe/unsafe"
   - Enforce ANY enterprise rule
   - Configurable per application

2. **Custom Scanner System**
   - Unlimited custom policies
   - No code changes
   - Instant deployment

3. **Business Context Awareness**
   - Understand your specific industry
   - Tailored to your use case
   - Evolves with your business

4. **Runtime Enforcement**
   - Policies enforced at inference time
   - Prevents policy violations before they happen
   - Auditable compliance

5. **Enterprise-Ready**
   - Multi-tenant isolation
   - Application-scoped policies
   - Full audit trails

---

## Comparison Matrix

| Feature | Traditional Safety | OpenGuardrails Policy |
|---------|-------------------|---------------------|
| **Focus** | Universal unsafe content | Enterprise policy enforcement |
| **Categories** | Fixed (5-20) | Unlimited custom |
| **Customization** | Limited | Full control |
| **Business Rules** | ❌ Not supported | ✅ First-class |
| **Scope Control** | ❌ Not supported | ✅ Custom scanners |
| **Brand Protection** | ❌ Not supported | ✅ Custom scanners |
| **Compliance** | Generic | Industry-specific |
| **Deployment** | SaaS-centric | On-prem / private |
| **Multi-tenancy** | Limited | Full isolation |
| **Auditability** | Basic | Comprehensive |

---

## When to Use Each Approach

### Use Traditional Safety When:
- Consumer-facing AI
- Simple content filtering
- Universal safety rules only
- No enterprise requirements

### Use OpenGuardrails Policy When:
- Enterprise AI applications
- Industry-specific compliance
- Business rule enforcement
- Custom policy requirements
- Private deployment needed
- Multi-application platform
- Audit trails required

---

## Next Steps

- 📗 [Create Custom Scanners](CUSTOM_SCANNERS.md)
- 📙 [Read API Reference](API_REFERENCE.md)
- 🏢 [Enterprise PoC Guide](ENTERPRISE_POC.md)

---

**Last Updated**: 2025-01-21
**Need Help?** Contact thomas@openguardrails.com
