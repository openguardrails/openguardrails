<p align="center">
    <img src="frontend/public/logo-dark.png" width="360"/>
</p>

<p align="center">
<a href="https://huggingface.co/openguardrails">Hugging Face</a> ·
<a href="https://www.openguardrails.com/platform/">Free Platform</a> ·
<a href="https://arxiv.org/abs/2510.19169">Tech Report</a>
</p>

# OpenGuardrails — Open-source AI Security Gateway

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Version](https://img.shields.io/badge/Version-5.1.0-green.svg)](https://github.com/openguardrails/openguardrails-safety/releases)
[![Stars](https://img.shields.io/github/stars/openguardrails/openguardrails?style=social)](https://github.com/openguardrails/openguardrails-safety)

> **Open-source AI Security Gateway — guardrails, multi-tenant configs, and policy-based routing for every LLM call your enterprise makes**

**OpenGuardrails** is an **open-source AI Security Gateway** that sits between your AI applications and model providers. Every LLM call passes through a single OpenAI-compatible endpoint where guardrails, multi-tenant configs, and policy-based routing are applied — so all AI agents behave consistently under your organization's policies, regardless of model, framework, or use case.

It protects enterprise AI systems from:
- **PII cross-border transfer**
- **Sensitive data leakage to external LLMs**
- **Non-compliant content** (NSFW, violence, extremism)
- **Prompt injection and adversarial attacks**
- **Policy violations** (e.g. non-work-related usage during work time)

More importantly, OpenGuardrails enforces a **unified standard of behavior across all AI agents**:
- Same safety rules across different models (OpenAI, open-source, etc.)
- Same behavior across different agent frameworks (LangChain, custom agents, etc.)
- Same output standards across different contexts and applications  

You can define your own:
- **Security policies**
- **Compliance rules**
- **Enterprise culture and communication style**

So every AI agent in your organization speaks, behaves, and responds **in alignment with your company’s standards**.

<p align="center">
    <a href="https://www.youtube.com/watch?v=b1ZRODONTm8" target="_blank">
        <img src="https://img.youtube.com/vi/b1ZRODONTm8/0.jpg" alt="Video Introduction" width="480">
    </a>
</p>

---

## The Enterprise AI Data Masking Problem

When employees use AI applications (Copilot, ChatGPT, internal AI agents), sensitive enterprise data flows to external model providers:

- **PII**: Employee emails, customer phone numbers, government IDs
- **Credentials**: API keys, database passwords, access tokens in code
- **Confidentials**: Trade secrets, internal project names, financial data

**The challenge**: Blocking these requests breaks user workflows. Allowing them creates compliance and security risks.

**OpenGuardrails solves this** with intelligent data protection that keeps AI applications usable while keeping sensitive data secure.

---

## How It Works

OpenGuardrails acts as an AI Gateway between your AI applications and model providers, automatically detecting and protecting sensitive data:
<p align="center">
    <img src="frontend/public/arch.png" width="800"/>
</p>

### Strategy 1: Mask & Restore (Anonymization)

Sensitive data is masked before sending to external LLMs, then restored in the response — users see correct results, but external providers never see real data.

<p align="center">
    <img src="frontend/public/seqflow_mask_restore.png" width="800"/>
</p>

**Flow:**
1. User request contains sensitive data (e.g., `thomas@openguardrails.com`)
2. Gateway detects and masks: `__email_1__@openguardrails.com`
3. Sanitized request sent to external LLM
4. Response received with masked placeholders
5. Original values restored before returning to user

### Strategy 2: Private Model Routing

For high-risk data, requests are automatically routed to your private/on-premise LLM — the original data never leaves your infrastructure.

<p align="center">
    <img src="frontend/public/seqflow_swich_private_model.png" width="800"/>
</p>

**Flow:**
1. User request contains high-risk sensitive data
2. Gateway classifies risk level and applies policy
3. Request routed to private LLM (with original data intact)
4. Response returned to user seamlessly

**Users experience zero disruption** — they don't know their request was rerouted for security.

---

## AI-Powered Sensitive Data Recognition

Unlike rule-based DLP systems, OpenGuardrails uses **GenAI-powered recognition** to detect sensitive data that regex patterns miss:

### Natural Language Anonymization

Detects sensitive information expressed in natural language:

| Input | Detection |
|-------|-----------|
| "My employee ID is 12345" | `employee_id` detected |
| "Contact John at his personal cell" | `phone_number` context detected |
| "The Q3 revenue was $2.5M" | `financial_data` detected |
| "Our AWS secret key starts with AKIA..." | `cloud_credential` detected |

### Code Logic Anonymization

Detects credentials and secrets embedded in code:

```python
# Input code snippet
db_password = "super_secret_123"
api_key = "sk-proj-abc123..."
conn_string = "postgresql://admin:password@internal-db:5432"
```

All three sensitive values are detected and masked, even without explicit patterns.

### Recognition Methods

| Method | Best For | Examples |
|--------|----------|----------|
| **GenAI Recognition** | Context-dependent, natural language | Trade secrets, business confidentials, implicit references |
| **Regex Patterns** | Structured data with known formats | Credit cards, SSN, phone numbers, emails |
| **Custom Keywords** | Organization-specific terms | Project codenames, internal system names |

---

## Policy-Based Data Classification

Define what's sensitive **according to your organization's policy**, not just generic PII:

```yaml
# Example: Enterprise Data Classification Policy
high_risk:
  - customer_pii
  - financial_records
  - source_code
  - api_credentials
  action: switch_private_model

medium_risk:
  - employee_emails
  - internal_project_names
  action: anonymize

low_risk:
  - general_business_info
  action: anonymize
```

**Configurable actions per risk level:**
- `block` — Reject the request entirely
- `switch_private_model` — Route to on-premise LLM
- `anonymize` — Mask and restore sensitive data
- `pass` — Allow with audit logging

---

## Quick Start

### Option 1: Try Online (Fastest)

https://www.openguardrails.com/platform/

### Option 2: Python SDK

```bash
pip install openguardrails
```

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("your-api-key")
result = client.check_prompt("Send report to john@company.com with Q3 revenue $2.5M")

print(result.detected_entities)
# [{"type": "email", "value": "john@company.com"},
#  {"type": "financial_data", "value": "$2.5M"}]
print(result.suggest_action)  # anonymize
```

### Option 3: OpenAI-Compatible Gateway (Zero Code Change)

```python
from openai import OpenAI

# Just change the base_url — all other code stays the same
client = OpenAI(
    base_url="http://localhost:5002/v1",
    api_key="sk-xxai-your-key"
)

# Automatic data protection — no code changes needed!
response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Summarize the contract for Acme Corp deal #12345"}]
)
# Sensitive data automatically masked/routed based on your policy
```

---

## Enterprise Deployment

OpenGuardrails is designed for **air-gapped and regulated environments**:

- **Fully on-premise** — No data leaves your infrastructure
- **Private cloud ready** — Deploy on AWS, Azure, GCP VPC
- **Compliance friendly** — SOC2, HIPAA, GDPR compatible architecture
- **High performance** — <50ms latency overhead, 1000+ req/sec

### Deployment Options

```bash
# Quick start with Docker
docker compose up -d

# Production deployment
curl -O https://raw.githubusercontent.com/openguardrails/openguardrails/main/docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
```

### Integration Points

- **API Gateway** — Nginx, Kong, AWS API Gateway
- **AI Platforms** — Dify, n8n, LangChain, LlamaIndex
- **Direct Integration** — SDK for Python, REST API

See [Deployment Guide](docs/DEPLOYMENT.md) for detailed instructions.

---

## Gateway Capabilities

OpenGuardrails is positioned as an AI Gateway. The table below reflects what is shipping today versus what is on the roadmap — please rely on it rather than any marketing copy elsewhere.

### Shipping today

- **Guardrails** — Prompt-injection detection, 19-category content safety, custom scanner packages
- **Data Masking** — GenAI + regex DLP with mask/restore and private-model routing
- **Multi-tenant configs** — Per-application blacklist / whitelist / response templates / ban policy / risk-type config
- **Policy-based routing** — Route by risk level to a private/on-premise model (`switch_private_model`)
- **OpenAI-compatible proxy** — Single `/v1/chat/completions` endpoint in front of any upstream
- **Per-tenant rate limiting** — Request-rate and global concurrency limits
- **Audit logging** — Complete request/response history with detection results
- **Agent protection** — Pre/post tool-call validation

### On the roadmap (not yet implemented)

- **Retries** — Automatic retry on upstream 5xx / timeout
- **Fallbacks** — Cascade to a backup model when the primary fails
- **Load balancing** — Weighted / least-loaded distribution across multiple upstream replicas of the same model

If any of these are blocking for you, please open an issue — that helps us prioritize.

---

## Model

- **OpenGuardrails-Text-2510**
  - 3.3B parameters
  - 119 languages
  - Purpose-built for guardrails & sensitive data detection
  - [Download on HuggingFace](https://huggingface.co/openguardrails/OpenGuardrails-Text-2510)

---

## Documentation

- [Deployment Guide](docs/DEPLOYMENT.md) — Complete deployment instructions
- [Data Masking Guide](docs/DATA_LEAKAGE_GUIDE.md) — DLP configuration details
- [Custom Scanners](docs/CUSTOM_SCANNERS.md) — Build your own detectors
- [API Reference](docs/API_REFERENCE.md) — Complete API documentation
- [Architecture](docs/ARCHITECTURE.md) — System architecture & design
- [Enterprise PoC Guide](docs/ENTERPRISE_POC.md) — PoC deployment guide
- [Technical Report (arXiv)](https://arxiv.org/abs/2510.19169)

---

## Community & Support

- Star us on GitHub if this project helps you
- Contributions welcome — see [Contributing Guide](CONTRIBUTING.md)
- Contact: **[thomas@openguardrails.com](mailto:thomas@openguardrails.com)**
- Website: [https://openguardrails.com](https://openguardrails.com)
- Issues: [GitHub Issues](https://github.com/openguardrails/openguardrails-safety/issues)

---

## Citation

If you find our work helpful, feel free to give us a cite.

```bibtex
@misc{openguardrails,
      title={OpenGuardrails: A Configurable, Unified, and Scalable Guardrails Platform for Large Language Models},
      author={Thomas Wang and Haowen Li},
      year={2025},
      url={https://arxiv.org/abs/2510.19169},
}
```

---

<div align="center">

**Protect enterprise data in AI workflows — automatically.**

Made with care by [OpenGuardrails](https://openguardrails.com)

</div>
