<p align="center">
    <img src="frontend/public/logo_dark.png" width="400"/>
<p>
<br>

<p align="center">
        🤗 <a href="https://huggingface.co/openguardrails">Hugging Face</a>&nbsp&nbsp ｜  &nbsp&nbsp<a href="https://www.openguardrails.com/platform/">Free Platform</a>&nbsp&nbsp ｜  &nbsp&nbsp<a href="https://arxiv.org/abs/2510.19169">Tech Report</a>
</p>

# OpenGuardrails

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python](https://img.shields.io/badge/Python-3.8%2B-blue)](https://www.python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104%2B-green)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18.0%2B-blue)](https://reactjs.org)
[![HuggingFace](https://img.shields.io/badge/🤗-Models-yellow)](https://huggingface.co/openguardrails/)

> 🚀 **Developer-first open-source AI security platform** - Comprehensive security protection for AI applications

**OpenGuardrails** is a developer-first open-source AI security platform. Built on advanced large language models, it provides prompt attack detection, content safety, data leak detection, and supports complete on-premise deployment to build robust security defenses for AI applications.

📄 **Technical Report:** [OpenGuardrails: A Configurable, Unified, and Scalable Guardrails Platform for Large Language Models (arXiv:2510.19169)](https://arxiv.org/abs/2510.19169) 

## ✨ Core Features

- 🏗️ **Scanner Package System** 🆕 - Flexible detection architecture with official, purchasable, and custom scanners
- 📱 **Multi-Application Management** - Manage multiple applications within one tenant account, each with isolated configurations
- 🪄 **Two Usage Modes** - Detection API + Security Gateway
- 🛡️ **Triple Protection** - Prompt attack detection + Content compliance detection + Data leak detection
- 🧠 **Context Awareness** - Intelligent safety detection based on conversation context
- 📋 **Content Safety** - Support custom training for content safety of different cultures and regions.
- 🔧 **Configurable Policy Adaptation** - Introduces a practical solution to the long-standing policy inconsistency problem observed in existing safety benchmarks and guard models.
- 🧠 **Knowledge Base Responses** - Vector similarity-based intelligent Q&A matching with custom knowledge bases
- 🏢 **Private Deployment** - Support for complete local deployment, controllable data security
- 🚫 **Ban Policy** - Intelligently identify attack patterns and automatically ban malicious users
- 🖼️ **Multimodal Detection** - Support for text and image content safety detection
- 🔌 **Customer System Integration** - Deep integration with existing customer user systems, API-level configuration management
- 📊 **Visual Management** - Intuitive web management interface and real-time monitoring
- ⚡ **High Performance** - Asynchronous processing, supporting high-concurrency access
- 🔌 **Easy Integration** - Compatible with OpenAI API format, one-line code integration
- 🎯 **Configurable Sensitivity** - Three-tier sensitivity threshold configuration for automated pipeline scenarios

## 🏗️ Scanner Package System 🆕

**OpenGuardrails v4.1+ introduces a revolutionary flexible scanner package system** that replaces the traditional hardcoded risk types with a dynamic, extensible architecture.

### 📦 Three Types of Scanner Packages

#### 🔧 **Built-in Official Packages**
System-provided packages that come pre-installed with OpenGuardrails:
- **Sensitive Topics Package**: S1-S18 (covers political content, violence, hate speech, etc.)
- **Restricted Topics Package**: S19-S21 (professional advice categories)
- Ready to use out of the box with configurable risk levels

#### 🛒 **Purchasable Official Packages**
Premium scanner packages available through the admin marketplace:
- Commercial-grade detection patterns for specific industries
- Curated by OpenGuardrails team with regular updates
- Purchase approval workflow for enterprise customers
- Example packages: Healthcare Compliance, Financial Regulations, Legal Industry

#### ✨ **Custom Scanners (S100+)**
User-defined scanners for business-specific needs:
- **Auto-tagged**: S100, S101, S102... automatically assigned
- **Application-scoped**: Custom scanners belong to specific applications
- **Three Scanner Types**:
  - **GenAI Scanner**: Uses OpenGuardrails-Text model for intelligent detection
  - **Regex Scanner**: Python regex patterns for structured data detection
  - **Keyword Scanner**: Comma-separated keyword lists for simple matching

### 🎯 Key Advantages

**vs Traditional Risk Types:**
- ✅ **Unlimited Flexibility**: Create unlimited custom scanners without code changes
- ✅ **No Database Migrations**: Add new scanners without schema updates
- ✅ **Business-Specific Detection**: Tailor detection rules to your specific use case
- ✅ **Performance Optimized**: Parallel processing maintains <10% latency impact
- ✅ **Marketplace Ecosystem**: Share and sell scanner packages

**Example Use Cases:**
```python
# Create custom scanner for banking applications
curl -X POST "http://localhost:5000/api/v1/custom-scanners" \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "scanner_type": "genai",
    "name": "Bank Fraud Detection",
    "definition": "Detect banking fraud attempts, financial scams, and illegal financial advice",
    "risk_level": "high_risk",
    "scan_prompt": true,
    "scan_response": true
  }'

# Returns auto-assigned tag: "S100"
```

### 🎨 Management Interface

- **Official Scanners** (`/platform/config/official-scanners`): Manage built-in and purchased packages
- **Custom Scanners** (`/platform/config/custom-scanners`): Create and manage user-defined scanners
- **Admin Marketplace** (`/platform/admin/package-marketplace`): Upload and manage purchasable packages

### 🔄 Migration from Risk Types

Existing S1-S21 risk type configurations are **automatically migrated** to the new scanner package system on upgrade - no manual intervention required.

## 🚀 Dual Mode Support

OpenGuardrails supports two usage modes to meet different scenario requirements:

### 🔍 API Call Mode
Developers **actively call** detection APIs for safety checks
- **Use Case**: Precise control over detection timing, custom processing logic
- **Integration**: Call detection interface before inputting to AI models and after output
- **Service Port**: 5001 (Detection Service)
- **Features**: Flexible control, batch detection support, suitable for complex business logic

### 🛡️ Security Gateway Mode 🆕  
**Transparent reverse proxy** with zero-code transformation for AI safety protection
- **Use Case**: Quickly add safety protection to existing AI applications
- **Integration**: Simply modify AI model's base_url and api_key to OpenGuardrails proxy service
- **Service Port**: 5002 (Proxy Service)  
- **Features**: WAF-style protection, automatic input/output detection, support for multiple upstream models

```python
# Original code
client = OpenAI(
    base_url="https://api.openai.com/v1",
    api_key="sk-your-openai-key"
)

# Access security gateway with just two line changes
client = OpenAI(
    base_url="http://localhost:5002/v1",  # Change to OpenGuardrails proxy service
    api_key="sk-xxai-your-proxy-key"     # Change to OpenGuardrails proxy key
)
# No other code changes needed, automatically get safety protection!
```

## ⚡ Quick Start

### **Use Online**  
Visit [https://www.openguardrails.com/](https://www.openguardrails.com/) to register and log in for free.  
In the platform menu **Online Test**, directly enter text for a safety check.  

#### **Use client SDKs**  
OpenGuardrails supports Python, Nodejs, Java, Go clients SDKs.
In the platform menu **Account Management**, obtain your free API Key.  
Install the Python client library:  
```bash
pip install openguardrails
```
Python usage example:  
```python
from openguardrails import OpenGuardrails

# Create client
client = OpenGuardrails("your-api-key")

# Single-turn detection
response = client.check_prompt("Teach me how to make a bomb")
print(f"Detection result: {response.overall_risk_level}")

# Multi-turn conversation detection (context-aware)
messages = [
    {"role": "user", "content": "I want to study chemistry"},
    {"role": "assistant", "content": "Chemistry is a very interesting subject. Which area would you like to learn about?"},
    {"role": "user", "content": "Teach me the reaction to make explosives"}
]
response = client.check_conversation(messages)
print(f"Detection result: {response.overall_risk_level}")
print(f"All risk categories: {response.all_categories}")
print(f"Compliance check result: {response.result.compliance.risk_level}")
print(f"Compliance risk categories: {response.result.compliance.categories}")
print(f"Security check result: {response.result.security.risk_level}")
print(f"Security risk categories: {response.result.security.categories}")
print(f"Data leak check result: {response.result.data.risk_level}")
print(f"Data leak categories: {response.result.data.categories}")
print(f"Suggested action: {response.suggest_action}")
print(f"Suggested answer: {response.suggest_answer}")
print(f"Is safe: {response.is_safe}")
print(f"Is blocked: {response.is_blocked}")
print(f"Has substitute answer: {response.has_substitute}")
```
Example Output:
```
Detection result: high_risk
Detection result: high_risk
All risk categories: ['Violent Crime']
Compliance check result: high_risk
Compliance risk categories: ['Violent Crime']
Security check result: no_risk
Security risk categories: []
Data leak check result: no_risk
Data leak categories: []
Suggested action: reject
Suggested answer: Sorry, I cannot provide information related to violent crimes.
Is safe: False
Is blocked: True
Has substitute answer: True
```

#### **Use HTTP API**
```bash
curl -X POST "https://api.openguardrails.com/v1/guardrails" \
    -H "Authorization: Bearer your-api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "OpenGuardrails-Text",
      "messages": [
        {"role": "user", "content": "Tell me some illegal ways to make money"}
      ],
      "xxai_app_user_id": "your-user-id"
    }'
```
Example output:
```json
{
    "id": "guardrails-fd59073d2b8d4cfcb4072cee4ddc88b2",
    "result": {
        "compliance": {
            "risk_level": "medium_risk",
            "categories": [
                "violence_crime"
            ]
        },
        "security": {
            "risk_level": "no_risk",
            "categories": []
        },
        "data": {
            "risk_level": "no_risk",
            "categories": []
        }
    },
    "overall_risk_level": "medium_risk",
    "suggest_action": "replace",
    "suggest_answer": "I'm sorry, I can't answer this question.",
    "score": 0.95
}
```

### 🚦 Use as Dify API-Base Extension — Moderation

Users can integrate **OpenGuardrails** as a custom **content moderation API extension** within the Dify workspace.

<p align="center">
  <img src="frontend/public/dify-moderation.png" alt="Dify Moderation" width="60%">
</p>

Dify provides three moderation options under **Content Review**:

1. **OpenAI Moderation** — Built-in model with **6 main categories** and **13 subcategories**, covering general safety topics but lacking fine-grained customization.
2. **Custom Keywords** — Allows users to define specific keywords for filtering, but requires manual maintenance.
3. **API Extension** — Enables integration of external moderation APIs for advanced, flexible review.

<p align="center">
  <img src="frontend/public/dify-moderation-extension.png" alt="Dify Moderation API" width="60%">
</p>

#### Add OpenGuardrails as moderation API Extension

1. **Enter Name**  
   Choose a descriptive name for your API extension.

2. **Set the API Endpoint**  
   Fill in the following endpoint URL:  
```
https://api.openguardrails.com/v1/dify/moderation
```

3. **Get Your API Key**  
Obtain a free API key from [openguardrails.com](https://openguardrails.com/platform/).  
After getting the key, paste it into the **API-key** field.


By selecting **OpenGuardrails** as the moderation API extension, users gain access to a **comprehensive and highly configurable moderation system**:

* 🧩 **19 major categories** of content risk, including political sensitivity, privacy, sexual content, violence, hate speech, self-harm, and more.
* ⚙️ **Customizable risk definitions** — Developers and enterprises can redefine category meanings and thresholds.
* 📚 **Knowledge-based response moderation** — supports contextual and knowledge-aware moderation.
* 💰 **Free and open** — no per-request cost or usage limit.
* 🔒 **Privacy-friendly** — can be deployed locally or on private infrastructure.

## 🔧 Creating Custom Scanners 🆕

One of the most powerful features of OpenGuardrails v4.1+ is the ability to create custom scanners tailored to your specific business needs.

### ⚡ Quick Example: Banking Fraud Detection

```python
import requests

# 1. Create a custom scanner for banking applications
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
print(f"Created custom scanner: {scanner['tag']}")  # Auto-assigned: S100
```

### 🎯 Using Custom Scanners in Detection

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("sk-xxai-your-api-key")

# Detection automatically uses all enabled scanners (including custom)
response = client.check_prompt(
    "How can I launder money through my bank account?",
    application_id="your-banking-app-id"  # Custom scanners are app-specific
)

# Response includes matched custom scanner tags
print(f"Risk level: {response.overall_risk_level}")
print(f"Matched scanners: {getattr(response, 'matched_scanner_tags', 'N/A')}")
# Output: "high_risk" and "S5,S100" (existingViolent Crime + custom Bank Fraud)
```

### 📚 Available Custom Scanner Types

| Type | Best For | Example | Performance |
|------|----------|---------|-------------|
| **GenAI** | Complex concepts, contextual understanding | Medical advice detection | Model call (high accuracy) |
| **Regex** | Structured data, pattern matching | Credit card numbers, phone numbers | Instant (no model call) |
| **Keyword** | Simple blocking, keyword lists | Competitor brands, prohibited terms | Instant (no model call) |

### 🎨 Management UI

Access the visual scanner management interface:
- **Official Scanners**: `/platform/config/official-scanners`
- **Custom Scanners**: `/platform/config/custom-scanners`
- **Admin Marketplace**: `/platform/admin/package-marketplace`

## 🚀 OpenGuardrails Quick Deployment Guide

OpenGuardrails uses a **separation of concerns** architecture where AI models and the platform run independently. This design provides:
- ✅ Flexibility to deploy models on different servers (GPU requirements)
- ✅ Freedom to use any compatible model API (OpenAI-compatible)
- ✅ Simplified platform deployment (no GPU dependency)

### 📋 Prerequisites

- **Docker** and **Docker Compose** installed ([installation guide](https://docs.docker.com/engine/install/ubuntu/))
- **GPU server** (for model deployment) - Ubuntu recommended with CUDA drivers
- **Hugging Face account** for model access token

---

### Step 1️⃣: Deploy AI Models (vLLM Services)

**⚠️ Deploy these on a GPU server first**

The platform requires two AI model services running via vLLM:

#### 🧠 Text Model (OpenGuardrails-Text-2510)

```bash
# Install vLLM (if not already installed)
pip install vllm

# Set your Hugging Face token
export HF_TOKEN=your-hf-token

# Start the text model service
vllm serve openguardrails/OpenGuardrails-Text-2510 \
  --port 58002 \
  --served-model-name OpenGuardrails-Text \
  --trust-remote-code \
  --max-model-len 8192

# Or use Docker:
docker run --gpus all -p 58002:8000 \
  -e HF_TOKEN=your-hf-token \
  vllm/vllm-openai:latest \
  --model openguardrails/OpenGuardrails-Text-2510 \
  --port 8000 \
  --served-model-name OpenGuardrails-Text \
  --trust-remote-code \
  --max-model-len 8192
```

**Verify it's running:**
```bash
curl http://YOUR_GPU_SERVER_IP:58002/v1/models
```

#### 🔍 Embedding Model (bge-m3)

```bash
# Start the embedding model service
vllm serve BAAI/bge-m3 \
  --port 58004 \
  --served-model-name bge-m3 \
  --trust-remote-code

# Or use Docker:
docker run --gpus all -p 58004:8000 \
  -e HF_TOKEN=your-hf-token \
  vllm/vllm-openai:latest \
  --model BAAI/bge-m3 \
  --port 8000 \
  --served-model-name bge-m3 \
  --trust-remote-code
```

**Verify it's running:**
```bash
curl http://YOUR_GPU_SERVER_IP:58004/v1/models
```

---

### Step 2️⃣: Deploy OpenGuardrails Platform

**Choose your deployment method:**

#### **Method 1: Quick Deployment with Pre-built Images (Recommended)** ⚡

**Best for**: Production deployment, end-users, no source code needed

```bash
# 1. Download production docker-compose file
curl -O https://raw.githubusercontent.com/openguardrails/openguardrails/main/docker-compose.prod.yml

# 2. Create .env file with your configuration
cat > .env << EOF
# Model API endpoints (replace with your GPU server IPs)
GUARDRAILS_MODEL_API_URL=http://YOUR_GPU_SERVER_IP:58002/v1
GUARDRAILS_MODEL_API_KEY=EMPTY
GUARDRAILS_MODEL_NAME=OpenGuardrails-Text

EMBEDDING_API_BASE_URL=http://YOUR_GPU_SERVER_IP:58004/v1
EMBEDDING_API_KEY=EMPTY
EMBEDDING_MODEL_NAME=bge-m3

# Optional: Vision-Language model (if you have it deployed)
# GUARDRAILS_VL_MODEL_API_URL=http://YOUR_GPU_SERVER_IP:58003/v1
# GUARDRAILS_VL_MODEL_API_KEY=EMPTY
# GUARDRAILS_VL_MODEL_NAME=OpenGuardrails-VL

# Security (CHANGE THESE IN PRODUCTION!)
SUPER_ADMIN_USERNAME=admin@yourdomain.com
SUPER_ADMIN_PASSWORD=CHANGE-THIS-PASSWORD-IN-PRODUCTION
JWT_SECRET_KEY=your-secret-key-change-in-production
POSTGRES_PASSWORD=your_password

# Specify pre-built image from Docker Hub (or your private registry)
PLATFORM_IMAGE=openguardrails/openguardrails-platform:latest
# For private registry: PLATFORM_IMAGE=your-registry.com/openguardrails-platform:version
EOF

# 3. Launch the platform (uses pre-built image, no build required)
docker compose -f docker-compose.prod.yml up -d
```

#### **Method 2: Build from Source (Development)** 🛠️

**Best for**: Developers, customization

```bash
# 1. Clone the repository
git clone https://github.com/openguardrails/openguardrails
cd openguardrails

# 2. Create .env file with your model endpoints
cat > .env << EOF
# Model API endpoints (replace with your GPU server IPs)
GUARDRAILS_MODEL_API_URL=http://YOUR_GPU_SERVER_IP:58002/v1
GUARDRAILS_MODEL_API_KEY=EMPTY
GUARDRAILS_MODEL_NAME=OpenGuardrails-Text

EMBEDDING_API_BASE_URL=http://YOUR_GPU_SERVER_IP:58004/v1
EMBEDDING_API_KEY=EMPTY
EMBEDDING_MODEL_NAME=bge-m3

# Security (CHANGE THESE IN PRODUCTION!)
SUPER_ADMIN_USERNAME=admin@yourdomain.com
SUPER_ADMIN_PASSWORD=CHANGE-THIS-PASSWORD-IN-PRODUCTION
JWT_SECRET_KEY=your-secret-key-change-in-production
POSTGRES_PASSWORD=your_password
EOF

# 3. Build and launch
docker compose up -d --build
```

---

### Step 3️⃣: Monitor Deployment

```bash
# Watch platform startup
docker logs -f openguardrails-platform

# Expected output:
# - "Running database migrations..."
# - "Successfully executed X migration(s)"
# - "Starting services via supervisord..."

# Check all containers
docker ps

# Expected output:
# - openguardrails-postgres (healthy)
# - openguardrails-platform (healthy)
```

---

### Step 4️⃣: Access the Platform

👉 **Web Interface**: [http://localhost:3000/platform/](http://localhost:3000/platform/)

**Default credentials:**
- **Username**: `admin@yourdomain.com`
- **Password**: `CHANGE-THIS-PASSWORD-IN-PRODUCTION`

**API Endpoints:**
- Admin API: `http://localhost:5000`
- Detection API: `http://localhost:5001`
- Proxy API: `http://localhost:5002`

---

### 🎯 Alternative: Use Any OpenAI-Compatible Model

OpenGuardrails is **model-agnostic**! You can use any OpenAI-compatible API:

```bash
# Example: Using OpenAI directly
GUARDRAILS_MODEL_API_URL=https://api.openai.com/v1
GUARDRAILS_MODEL_API_KEY=sk-your-openai-key
GUARDRAILS_MODEL_NAME=gpt-4

# Example: Using local Ollama
GUARDRAILS_MODEL_API_URL=http://localhost:11434/v1
GUARDRAILS_MODEL_API_KEY=ollama
GUARDRAILS_MODEL_NAME=llama2

# Example: Using Anthropic Claude via proxy
GUARDRAILS_MODEL_API_URL=https://api.anthropic.com/v1
GUARDRAILS_MODEL_API_KEY=sk-ant-your-key
GUARDRAILS_MODEL_NAME=claude-3-sonnet
```

---

### 🛡️ Production Security Checklist

Before deploying to production, update these in your `.env` file:

```bash
# ✅ Change default credentials
SUPER_ADMIN_USERNAME=admin@your-company.com
SUPER_ADMIN_PASSWORD=YourSecurePassword123!

# ✅ Generate secure JWT secret
JWT_SECRET_KEY=$(openssl rand -hex 32)

# ✅ Secure database password
POSTGRES_PASSWORD=$(openssl rand -hex 16)

# ✅ Configure model API keys (if using commercial APIs)
GUARDRAILS_MODEL_API_KEY=sk-your-actual-api-key
EMBEDDING_API_KEY=sk-your-actual-embedding-key

# ✅ Update CORS origins for your domain
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com

# ✅ Configure SMTP for email notifications
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=notifications@yourdomain.com
SMTP_PASSWORD=your-smtp-password
SMTP_USE_TLS=true
SMTP_USE_SSL=false
```

---

### ✅ What You Have Now

1. **AI Models** (on GPU server):
   - Text model service on port **58002**
   - Embedding model service on port **58004**

2. **OpenGuardrails Platform** (can run on any server):
   - PostgreSQL database - Port **54321**
   - Web interface - Port **3000**
   - Admin API - Port **5000**
   - Detection API - Port **5001**
   - Proxy API - Port **5002**

3. **Automatic Features**:
   - ✅ Database migrations run automatically
   - ✅ Admin user created on first startup
   - ✅ All services managed by Supervisor

![Dashboard Overview](frontend/public//dashboard.png)

## 🛡️ Safety Detection Capabilities

### Detection Dimensions

| Label | Category                              | Risk Level | Description                                                                      |
| ----- | ------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| S1    | General Political Topics              | 🟢 Low     | General political issues without sensitive content |
| S2    | Sensitive Political Topics            | 🔴 High    | Topics involving subversion, separatism, or threats to national security         |
| S3    | Insult to National Symbols or Leaders | 🔴 High    | Insulting national leaders, flag, emblem, or anthem                              |
| S4    | Harm to Minors                        | 🟡 Medium  | Child exploitation, nudity, abuse, or harmful content                            |
| S5    | Violent Crime                         | 🔴 High    | Promoting or glorifying violence (e.g., murder, terrorism)                       |
| S6    | Non-Violent Crime                     | 🟡 Medium  | Encouraging fraud, drugs, hacking, or other non-violent crimes                   |
| S7    | Pornography                           | 🟡 Medium  | Adult nudity, sexual acts, or obscene erotic content                             |
| S8    | Hate & Discrimination                 | 🟢 Low     | Discrimination or hate based on race, gender, religion, etc.                     |
| S9    | Prompt Attacks                        | 🔴 High    | Jailbreaks, injections, or prompt manipulation against the model                 |
| S10   | Profanity                      | 🟢 Low     | Profanity, insults, or vulgar and threatening speech                             |
| S11   | Privacy Invasion                      | 🟢 Low     | Leaking personal data such as ID, address, or medical info                       |
| S12   | Commercial Violations                 | 🟢 Low     | Fraud, unfair competition, or disclosure of trade secrets                        |
| S13   | Intellectual Property Infringement    | 🟢 Low     | Plagiarism or copyright/patent violations                                        |
| S14   | Harassment                            | 🟢 Low     | Verbal abuse, humiliation, or targeted attacks on others                         |
| S15   | Weapons of Mass Destruction           | 🔴 High    | Promoting or describing WMDs (chemical, biological, nuclear)                     |
| S16   | Self-Harm                             | 🟡 Medium  | Encouraging suicide, self-injury, or eating disorders                            |
| S17   | Sexual Crimes                         | 🔴 High    | Promoting or depicting sexual assault or exploitation                            |
| S18   | Threats                               | 🟢 Low    | Issuing or implying violent threats or intimidation                              |
| S19   | Professional Financial Advice                   | 🟢 Low  | Providing financial advice beyond general info                              |
| S20   | Professional Medical Advice                   | 🟢 Low  | Providing medical advice beyond general info                              |
| S21   | Professional Legal Advice                   | 🟢 Low  | Providing legal advice beyond general info                              |

### Processing Strategies

- **🔴 High Risk**: **Substitute** with preset safety responses
- **🟡 Medium Risk**: **Substitute** responses base on custom knowledge base
- **🟢 Low Risk**: **Allow** normal processing
- **⚪ Safe**: **Allow** no risk content

### Data Leak Detection

OpenGuardrails provides **Input** and **Output** data leak detection with different behaviors:

#### 📥 Input Detection
When sensitive data (ID card, phone number, bank card, etc.) is detected in **user input**:
- ✅ **Desensitize FIRST**, then send to LLM for processing
- ❌ **NOT blocked** - the desensitized text is forwarded to the LLM
- 🎯 **Use case**: Protect user privacy data from leaking to external LLM providers

**Example:**
```
User Input: "My ID is 110101199001011234, phone is 13912345678"
↓ Detected & Desensitized
Sent to LLM: "My ID is 110***********1234, phone is 139****5678"
```

#### 📤 Output Detection
When sensitive data is detected in **LLM output**:
- ✅ **Desensitize FIRST**, then return to user
- ❌ **NOT blocked** - the desensitized text is returned to user
- 🎯 **Use case**: Prevent LLM from leaking sensitive data to users

**Example:**
```
Q: What is John's contact info?
A (from LLM): "John's ID is 110101199001011234, phone is 13912345678"
↓ Detected & Desensitized
Returned to User: "John's ID is 110***********1234, phone is 139****5678"
```

**Configuration**: Each entity type can be configured independently for input/output detection in the Data Security page.

## 🏗️ Architecture

```
                           Users/Developers
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
                 ▼             ▼             ▼
        ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐
        │  Management  │ │  API Call    │ │ Security Gateway │
        │  Interface   │ │  Mode        │ │    Mode         │
        │ (React Web)  │ │ (Active Det) │ │ (Transparent    │
        │              │ │              │ │  Proxy)         │
        └──────┬───────┘ └──────┬───────┘ └────────┬────────┘
               │ HTTP API       │ HTTP API          │ OpenAI API
               ▼                ▼                   ▼
    ┌──────────────┐  ┌──────────────┐    ┌──────────────────┐
    │  Admin       │  │  Detection   │    │   Proxy          │
    │  Service     │  │  Service     │    │   Service        │
    │ (Port 5000)  │  │ (Port 5001)  │    │  (Port 5002)     │
    │ Low Conc.    │  │ High Conc.   │    │  High Conc.      │
    └──────┬───────┘  └──────┬───────┘    └─────────┬────────┘
           │                 │                      │
           │          ┌──────┼──────────────────────┼───────┐
           │          │      │                      │       │
           ▼          ▼      ▼                      ▼       ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                PostgreSQL Database                          │
    │   Users | Results | Blacklist | Whitelist | Templates      │
    │         | Proxy Config | Upstream Models                   │
    └─────────────────────┬───────────────────────────────────────┘
                          │
    ┌─────────────────────▼───────────────────────────────────────┐
    │              OpenGuardrails Model                   │
    │           (OpenGuardrails-Text)                       │
    │             🤗 HuggingFace Open Source                     │
    └─────────────────────┬───────────────────────────────────────┘
                          │ (Proxy Service Only)
    ┌─────────────────────▼───────────────────────────────────────┐
    │                   Upstream AI Models                        │
    │       OpenAI | Anthropic | Local Models | Other APIs       │
    └─────────────────────────────────────────────────────────────┘
```

### 🏭 Three-Service Architecture

1. **Admin Service (Port 5000)**
   - Handles management platform APIs and web interface
   - User management, configuration, data statistics
   - Low concurrency optimization: 2 worker processes

2. **Detection Service (Port 5001)** 
   - Provides high-concurrency guardrails detection API
   - Supports single-turn and multi-turn conversation detection
   - High concurrency optimization: 32 worker processes

3. **Proxy Service (Port 5002)** 🆕
   - OpenAI-compatible security gateway reverse proxy
   - Automatic input/output detection with intelligent blocking
   - High concurrency optimization: 24 worker processes

## 📊 Management Interface

### Dashboard
- 📈 Detection statistics display
- 📊 Risk distribution charts
- 📉 Detection trend graphs
- 🎯 Real-time monitoring panel

### Detection Results
- 🔍 Historical detection queries
- 🏷️ Multi-dimensional filtering
- 📋 Detailed result display
- 📤 Data export functionality

### Protection Configuration
- ⚫ Blacklist management
- ⚪ Whitelist management
- 💬 Response template configuration
- ⚙️ Flexible rule settings

## 🤗 Open Source Model

Our guardrail model is open-sourced on HuggingFace:

- **Model**: [openguardrails/OpenGuardrails-Text-2510](https://huggingface.co/openguardrails/OpenGuardrails-Text-2510)
- **Model Size**: 3.3B parameters
- **Languages**: 119 languages
- **SOTA Performance**

## 🤝 Commercial Services

We provide professional AI safety solutions:

### 🎯 Model Fine-tuning Services
- **Industry Customization**: Professional fine-tuning for finance, healthcare, education
- **Scenario Optimization**: Optimize detection for specific use cases
- **Continuous Improvement**: Ongoing optimization based on usage data

### 🏢 Enterprise Support
- **Technical Support**: 24/7 professional technical support
- **SLA Guarantee**: 99.9% availability guarantee
- **Private Deployment**: Completely offline private deployment solutions

### 🔧 Custom Development
- **API Customization**: Custom API interfaces for business needs
- **UI Customization**: Customized management interface and user experience
- **Integration Services**: Deep integration with existing systems
- **n8n Workflow Integration**: Complete integration with n8n automation platform

## 🔌 n8n Integration 🆕

Automate your AI safety workflows with OpenGuardrails + n8n integration! Perfect for content moderation bots, automated customer service, and workflow-based AI systems.

### 🎯 Two Easy Integration Methods

#### Method 1: OpenGuardrails Community Node (Recommended)
```bash
# Install in your n8n instance
# Settings → Community Nodes → Install
n8n-nodes-openguardrails
```

**Features:**
- ✅ Content safety validation
- ✅ Input/output moderation for chatbots
- ✅ Context-aware multi-turn conversation checks
- ✅ Configurable risk thresholds and actions

#### Method 2: HTTP Request Node
Use n8n's built-in HTTP Request node to call OpenGuardrails API directly.

### 🛠️ Ready-to-Use Workflow Templates

Check the `n8n-integrations/http-request-examples/` folder for pre-built templates:

- **`basic-content-check.json`** - Simple content moderation workflow
- **`chatbot-with-moderation.json`** - Complete AI chatbot with input/output protection

### 📖 Example Workflow: Protected AI Chatbot

```
1️⃣ Webhook (receive user message)
2️⃣ OpenGuardrails - Input Moderation
3️⃣ IF (action = pass)
   ├─ ✅ YES → Continue to LLM
   └ ❌ NO → Return safe response
4️⃣ OpenAI/Assistant API
5️⃣ OpenGuardrails - Output Moderation
6️⃣ IF (action = pass)
   ├─ ✅ YES → Return to user
   └ ❌ NO → Return safe response
```

### 🚀 Quick Setup

**Header Auth Setup:**
- Name: `Authorization`
- Value: `Bearer sk-xxai-YOUR-API-KEY`

**HTTP Request Configuration:**
```json
{
  "method": "POST",
  "url": "https://api.openguardrails.com/v1/guardrails",
  "body": {
    "model": "OpenGuardrails-Text",
    "messages": [
      {"role": "user", "content": "{{ $json.message }}"}
    ],
    "enable_security": true,
    "enable_compliance": true,
    "enable_data_security": true
  }
}
```

### 📚 More Resources

- [n8n Community Node Documentation](https://github.com/openguardrails/n8n-nodes-openguardrails)
- [Workflow Examples](n8n-integrations/http-request-examples/)
- [Integration Guide](docs/N8N_INTEGRATION.md)

> 📧 **Contact Us**: thomas@openguardrails.com
> 🌐 **Official Website**: https://openguardrails.com

## 📚 Documentation

- [API Reference](docs/API_REFERENCE.md) - Complete API documentation
- [Deployment Guide](docs/DEPLOYMENT.md) - Deployment instructions
- [Migration Guide](docs/MIGRATION_GUIDE.md) - Database migration guide

## 🤝 Contributing

We welcome all forms of contributions!

### How to Contribute
- 🐛 [Submit Bug Reports](https://github.com/openguardrails/openguardrails/issues)
- 💡 [Propose New Features](https://github.com/openguardrails/openguardrails/issues)
- 📖 Improve documentation
- 🧪 Add test cases
- 💻 Submit code

## 📄 License

This project is licensed under [Apache 2.0](LICENSE).

## 🌟 Support Us

If this project helps you, please give us a ⭐️

[![Star History Chart](https://api.star-history.com/svg?repos=OpenGuardrails/openguardrails&type=Date)](https://star-history.com/#OpenGuardrails/openguardrails&Date)

## 📞 Contact Us

- 📧 **Technical Support**: thomas@openguardrails.com
- 🌐 **Official Website**: https://openguardrails.com
- 💬 **Community**: Join our technical discussion group

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

<div align="center">

**Developer-first open-source AI security platform** 🛡️

Made with ❤️ by [OpenGuardrails](https://openguardrails.com)

</div>
