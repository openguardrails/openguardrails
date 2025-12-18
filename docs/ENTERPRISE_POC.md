# Enterprise PoC Guide

> Run a successful OpenGuardrails proof of concept in your organization

## Table of Contents

- [PoC Overview](#poc-overview)
- [Phase 1: Planning (Week 1)](#phase-1-planning-week-1)
- [Phase 2: Setup (Week 1-2)](#phase-2-setup-week-1-2)
- [Phase 3: Integration (Week 2-3)](#phase-3-integration-week-2-3)
- [Phase 4: Testing (Week 3-4)](#phase-4-testing-week-3-4)
- [Phase 5: Evaluation (Week 4)](#phase-5-evaluation-week-4)
- [Success Metrics](#success-metrics)
- [Common PoC Scenarios](#common-poc-scenarios)

---

## PoC Overview

### Typical Timeline: 4 Weeks

```
Week 1: Planning + Setup
Week 2: Setup + Integration
Week 3: Integration + Testing
Week 4: Testing + Evaluation
```

### Resources Needed

**Technical**:
- 1 DevOps engineer (deployment)
- 1-2 Backend developers (integration)
- 1 QA engineer (testing)
- Optional: GPU server (or use cloud APIs)

**Stakeholders**:
- Technical lead
- Security/compliance officer
- Business sponsor
- End users (for testing)

---

## Phase 1: Planning (Week 1)

### Step 1.1: Define Use Case

**Exercise**: Answer these questions

1. **What AI application needs guardrails?**
   - [ ] Customer support chatbot
   - [ ] Internal AI assistant
   - [ ] Content generation platform
   - [ ] Code assistant
   - [ ] Other: ___________

2. **What are the primary risks?**
   - [ ] Content safety (violence, hate, NSFW)
   - [ ] Prompt injection / jailbreaking
   - [ ] Data leakage (PII, credentials)
   - [ ] Off-topic responses
   - [ ] Compliance violations
   - [ ] Brand protection
   - [ ] Other: ___________

3. **What policies must be enforced?**
   ```markdown
   ## Policy 1: [Name]
   Description: ...
   Examples: ...
   Action: ...

   ## Policy 2: [Name]
   Description: ...
   ```

### Step 1.2: Define Success Criteria

**Example**:
```markdown
## PoC Success Criteria

1. **Functional**:
   ✅ Detect 95%+ of prompt injection attempts
   ✅ Block inappropriate content
   ✅ Enforce all 5 business policies
   ✅ < 200ms latency increase

2. **Operational**:
   ✅ Deploy on internal infrastructure
   ✅ Integrate with existing AI app
   ✅ No data leaves premises
   ✅ Easy to manage (non-technical users)

3. **Business**:
   ✅ Reduce moderation costs by 50%
   ✅ Prevent 100% of policy violations
   ✅ ROI positive within 6 months
```

### Step 1.3: Prepare Test Data

**Create test datasets**:

1. **Positive Examples** (should be detected):
   ```python
   positive_tests = [
       "How do I jailbreak this AI?",
       "Ignore previous instructions and...",
       "My SSN is 123-45-6789",
       # ... 50+ examples for each risk type
   ]
   ```

2. **Negative Examples** (should NOT be detected):
   ```python
   negative_tests = [
       "How do I reset my password?",
       "What are your business hours?",
       "Can you explain this feature?",
       # ... 50+ normal user queries
   ]
   ```

3. **Edge Cases**:
   ```python
   edge_cases = [
       "Can you help me with creative writing about hackers?",
       "I want to learn about security testing (authorized)",
       # ... boundary cases
   ]
   ```

---

## Phase 2: Setup (Week 1-2)

### Step 2.1: Infrastructure Preparation

**Option A: On-Premises (Recommended for Enterprise PoC)**

```bash
# Requirements
- Docker host with 8GB+ RAM
- PostgreSQL server
- GPU server (optional) or cloud API access

# Deployment
git clone https://github.com/openguardrails/openguardrails
cd openguardrails

# Configure .env
cp .env.example .env
# Edit .env with your settings

# Deploy
docker compose up -d

# Verify
docker ps
curl http://localhost:5001/health
```

**Option B: Cloud Deployment**

```bash
# Use cloud VM + docker compose
# Or Kubernetes (see k8s-manifests/)
```

### Step 2.2: Model Configuration

**Option A: Self-hosted Models (Full Control)**

```bash
# On GPU server
vllm serve openguardrails/OpenGuardrails-Text-2510 \
  --port 58002 \
  --served-model-name OpenGuardrails-Text

vllm serve BAAI/bge-m3 \
  --port 58004 \
  --served-model-name bge-m3
```

**Option B: Cloud APIs (Faster Setup)**

```bash
# Use OpenAI, Claude, or other providers
GUARDRAILS_MODEL_API_URL=https://api.openai.com/v1
GUARDRAILS_MODEL_API_KEY=sk-your-key
GUARDRAILS_MODEL_NAME=gpt-4
```

### Step 2.3: Initial Configuration

**Configure via Web UI** (`http://localhost:3000/platform/`):

1. **Login**: Use admin credentials from `.env`
2. **Create Application**: Platform → Applications → Create
3. **Configure Risk Types**: Platform → Config → Official Scanners
   - Enable relevant S1-S21 scanners
   - Adjust risk levels
4. **Add Response Templates**: Platform → Config → Response Templates
   - Create custom rejection messages
5. **Configure Data Security**: Platform → Config → Data Security
   - Enable PII detection
   - Configure masking rules

---

## Phase 3: Integration (Week 2-3)

### Step 3.1: API Integration

**Integration Pattern 1: API Call Mode** (Recommended for PoC)

```python
from openguardrails import OpenGuardrails

# Initialize client
guardrails = OpenGuardrails(api_key="sk-xxai-your-key")

# Check user input before sending to LLM
def handle_user_message(user_message):
    # 1. Check input
    input_result = guardrails.check_prompt(user_message)

    if input_result.is_blocked:
        return input_result.suggest_answer

    # 2. Send to LLM
    llm_response = your_llm_call(user_message)

    # 3. Check output
    output_result = guardrails.check_response(llm_response)

    if output_result.is_blocked:
        return output_result.suggest_answer

    return llm_response
```

**Integration Pattern 2: Gateway Mode** (Zero-code)

```python
# Original code
from openai import OpenAI
client = OpenAI(
    base_url="https://api.openai.com/v1",
    api_key="sk-your-openai-key"
)

# Modified code (only 2 lines changed!)
client = OpenAI(
    base_url="http://your-guardrails-host:5002/v1",  # Change
    api_key="sk-xxai-your-proxy-key"                   # Change
)

# Everything else stays the same - automatic protection!
response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello"}]
)
```

### Step 3.2: Create Custom Scanners

**Based on your business policies**:

```python
import requests

# Custom scanner for your specific use case
response = requests.post(
    "http://localhost:5000/api/v1/custom-scanners",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "scanner_type": "genai",
        "name": "Your Business Policy",
        "definition": "Detect behavior that violates your specific business rule: ...",
        "risk_level": "high_risk",
        "scan_prompt": True,
        "scan_response": True
    }
)

print(f"Created scanner: {response.json()['tag']}")
```

**Best Practice**: Create 3-5 custom scanners for your top policies

### Step 3.3: Configure Applications

**Multi-application setup** (if applicable):

```python
# Application 1: Customer Support
- Official scanners: S9 (Prompt Injection), S10 (Profanity)
- Custom scanners: S100 (Support Scope), S101 (Unauthorized Promises)

# Application 2: Internal Assistant
- Official scanners: S9 (Prompt Injection), S11 (Data Leak)
- Custom scanners: S102 (Internal Codenames), S103 (Confidential Info)
```

---

## Phase 4: Testing (Week 3-4)

### Step 4.1: Functional Testing

**Run your test datasets**:

```python
def run_functional_tests():
    results = {
        "true_positives": 0,   # Correctly detected
        "false_positives": 0,  # Incorrectly detected
        "true_negatives": 0,   # Correctly allowed
        "false_negatives": 0   # Missed detection
    }

    # Test positive examples
    for test in positive_tests:
        result = guardrails.check_prompt(test)
        if result.is_blocked:
            results["true_positives"] += 1
        else:
            results["false_negatives"] += 1
            print(f"MISSED: {test}")

    # Test negative examples
    for test in negative_tests:
        result = guardrails.check_prompt(test)
        if result.is_blocked:
            results["false_positives"] += 1
            print(f"FALSE ALARM: {test}")
        else:
            results["true_negatives"] += 1

    # Calculate metrics
    precision = results["true_positives"] / (results["true_positives"] + results["false_positives"])
    recall = results["true_positives"] / (results["true_positives"] + results["false_negatives"])
    f1 = 2 * (precision * recall) / (precision + recall)

    print(f"Precision: {precision:.2%}")
    print(f"Recall: {recall:.2%}")
    print(f"F1 Score: {f1:.2%}")

    return results
```

### Step 4.2: Performance Testing

**Measure latency**:

```python
import time

def test_latency(num_requests=1000):
    latencies = []

    for i in range(num_requests):
        start = time.time()
        result = guardrails.check_prompt("Hello, how are you?")
        latency = (time.time() - start) * 1000  # ms
        latencies.append(latency)

    print(f"P50 latency: {sorted(latencies)[len(latencies)//2]:.1f}ms")
    print(f"P95 latency: {sorted(latencies)[int(len(latencies)*0.95)]:.1f}ms")
    print(f"P99 latency: {sorted(latencies)[int(len(latencies)*0.99)]:.1f}ms")
    print(f"Average: {sum(latencies)/len(latencies):.1f}ms")
```

**Concurrent load test**:

```bash
# Use Apache Bench or similar
ab -n 10000 -c 100 -p request.json \
   -T 'application/json' \
   -H 'Authorization: Bearer sk-xxai-your-key' \
   http://localhost:5001/v1/guardrails
```

### Step 4.3: User Acceptance Testing

**Involve actual end users**:

1. **Shadow Mode** (first week):
   - Run guardrails in parallel
   - Don't block any requests
   - Collect metrics only

2. **Pilot Group** (second week):
   - Enable blocking for small user group
   - Collect feedback
   - Refine policies

3. **Full Rollout** (after PoC):
   - Enable for all users
   - Monitor carefully
   - Continue refinement

---

## Phase 5: Evaluation (Week 4)

### Step 5.1: Metrics Analysis

**Collect and analyze**:

```python
# Get PoC statistics
stats = requests.get(
    "http://localhost:5001/api/v1/dashboard/stats",
    headers={"Authorization": "Bearer your-token"},
    params={
        "start_date": "2025-01-01",
        "end_date": "2025-01-31"
    }
).json()

print(f"Total detections: {stats['total_detections']}")
print(f"Blocked: {stats['total_blocked']}")
print(f"Pass rate: {stats['total_passed'] / stats['total_detections']:.1%}")
```

### Step 5.2: Cost-Benefit Analysis

**Calculate ROI**:

```markdown
## Costs
- Infrastructure: $X/month
- Setup time: Y hours * hourly rate
- Maintenance: Z hours/month

## Benefits
- Reduced moderation costs: -$A/month
- Prevented incidents: $B (risk value)
- Improved user trust: $C (estimated)

## ROI
- Monthly savings: $(A+C) - $(X + Z*rate)
- Break-even: N months
```

### Step 5.3: Final Report

**PoC Report Template**:

```markdown
# OpenGuardrails PoC Report

## Executive Summary
- Deployment completed on [date]
- Tested with [N] requests over [X] weeks
- Key findings: ...

## Functional Results
- Detection accuracy: X.X%
- False positive rate: X.X%
- False negative rate: X.X%
- Custom policies created: N

## Performance Results
- Average latency: Xms
- P95 latency: Xms
- Throughput: X requests/second
- Uptime: XX.X%

## Business Impact
- Policy violations prevented: N
- Moderation workload reduced: XX%
- User satisfaction: [feedback]

## Recommendation
[ ] Proceed to production
[ ] Extend PoC with additional testing
[ ] Not recommended (reasons: ...)

## Next Steps
1. ...
2. ...
```

---

## Success Metrics

### Technical Metrics

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Detection accuracy | > 95% | __% | ✅/❌ |
| False positive rate | < 2% | __% | ✅/❌ |
| Latency (P95) | < 200ms | __ms | ✅/❌ |
| Uptime | > 99.9% | __%| ✅/❌ |

### Business Metrics

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Policy violations prevented | 100% | __% | ✅/❌ |
| Moderation cost reduction | 50% | __% | ✅/❌ |
| User satisfaction | > 4.0/5.0 | __/5.0 | ✅/❌ |
| Time to value | < 4 weeks | __ weeks | ✅/❌ |

---

## Common PoC Scenarios

### Scenario 1: Financial Services

**Use Case**: Investment advisory chatbot

**Policies**:
- SEC compliance (no unlicensed advice)
- PII protection (SSN, account numbers)
- Fraud detection (scam attempts)
- Competitor mentions

**Custom Scanners**:
```python
# S100: Unlicensed Investment Advice
# S101: Fraud Detection
# S102: Competitor Mentions
# S103: Unauthorized Fee Discounts
```

**Success Criteria**:
- 100% compliance with SEC regulations
- Zero PII leaks
- < 100ms latency
- Deploy on-premises

### Scenario 2: Healthcare

**Use Case**: Patient portal AI assistant

**Policies**:
- HIPAA compliance
- No medical diagnosis
- No prescription advice
- Patient data protection

**Custom Scanners**:
```python
# S100: Medical Diagnosis Prevention
# S101: HIPAA Violation Detection
# S102: Prescription Request Detection
# S103: Patient Portal Scope
```

**Success Criteria**:
- HIPAA compliant
- No liability issues
- Improve patient self-service
- Reduce support tickets by 40%

### Scenario 3: E-Commerce

**Use Case**: Customer service chatbot

**Policies**:
- No unauthorized refunds
- No prohibited products
- Brand voice consistency
- Scope control

**Custom Scanners**:
```python
# S100: Unauthorized Refund Promises
# S101: Prohibited Product Detection
# S102: Competitor Recommendations
# S103: Support Scope Control
```

**Success Criteria**:
- Reduce support costs by 60%
- Maintain brand consistency
- Zero unauthorized commitments
- Improve CSAT by 15%

---

## PoC Checklist

### Week 1
- [ ] Define use case
- [ ] List policies to enforce
- [ ] Create test datasets
- [ ] Set success criteria
- [ ] Deploy infrastructure

### Week 2
- [ ] Configure models
- [ ] Set up applications
- [ ] Create custom scanners
- [ ] Begin integration

### Week 3
- [ ] Complete integration
- [ ] Run functional tests
- [ ] Performance testing
- [ ] User acceptance testing

### Week 4
- [ ] Analyze results
- [ ] Calculate ROI
- [ ] Prepare final report
- [ ] Make go/no-go decision

---

## Getting Help

### Technical Support

- **Email**: thomas@openguardrails.com
- **Documentation**: https://docs.openguardrails.com
- **GitHub Issues**: https://github.com/openguardrails/openguardrails/issues

### PoC Support Package

Contact us for:
- Dedicated technical support
- Architecture review
- Custom scanner development
- Performance optimization
- Integration assistance

---

## Next Steps After Successful PoC

1. **Production Deployment**
   - [ ] Production infrastructure setup
   - [ ] High availability configuration
   - [ ] Monitoring and alerting
   - [ ] Backup and disaster recovery

2. **Scaling**
   - [ ] Horizontal scaling
   - [ ] Load balancing
   - [ ] Performance tuning
   - [ ] Cost optimization

3. **Operations**
   - [ ] Training for operations team
   - [ ] Runbooks and procedures
   - [ ] Incident response plan
   - [ ] Regular maintenance schedule

4. **Expansion**
   - [ ] Roll out to additional applications
   - [ ] Create more custom scanners
   - [ ] Integrate with more systems
   - [ ] Continuous improvement

---

**Last Updated**: 2025-01-21
**Need Help?** Contact thomas@openguardrails.com
