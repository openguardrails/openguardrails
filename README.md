<p align="center">
    <img src="frontend/public/logo_dark.png" width="400"/>
<p>
<br>

<p align="center">
        🤗 <a href="https://huggingface.co/openguardrails/OpenGuardrails-Text">Hugging Face</a>&nbsp&nbsp ｜  &nbsp&nbsp<a href="https://www.openguardrails.com">Website</a>&nbsp&nbsp ｜  &nbsp&nbsp<a href="https://arxiv.org/abs/2510.19169">Tech Report</a>
</p>

# OpenGuardrails

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python](https://img.shields.io/badge/Python-3.8%2B-blue)](https://www.python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104%2B-green)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18.0%2B-blue)](https://reactjs.org)
[![HuggingFace](https://img.shields.io/badge/🤗-Models-yellow)](https://huggingface.co/openguardrails/)

> 🚀 **Developer-first open-source AI security platform** - Comprehensive security protection for AI applications

**OpenGuardrails** is a developer-first open-source AI security platform. Built on advanced large language models, it provides prompt attack detection, content safety, data leak detection, and supports complete on-premise deployment to build robust security defenses for AI applications.

📄 **Technical Report:** [arXiv:2510.19169](https://arxiv.org/abs/2510.19169)

## ✨ Core Features

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
      "extra_body": {
        "xxai_app_user_id": "your-user-id"
      }
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

## 🚀 OpenGuardrails Quick Deployment Guide

### 🧩 1. Prepare Your Environment

- Use a **GPU server** (Ubuntu is recommended).
- Ensure that **CUDA drivers** are correctly installed.
- Install **Docker** (see [Docker installation instructions](https://docs.docker.com/engine/install/ubuntu/)).

---

### 🧱 2. Run the OpenGuardrails Model Service

Download and launch the OpenGuardrails main model service using **vLLM**.

```bash
export HF_TOKEN=your-hf-token

docker run --runtime nvidia --gpus all \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    --env "HF_TOKEN=$HF_TOKEN" \
    -p 58002:8000 \
    --ipc=host \
    vllm/vllm-openai:v0.10.2 \
    --model openguardrails/OpenGuardrails-Text-2510 \
    --served-model-name OpenGuardrails-Text
````

Once the container starts, the model API will be available at:

```
http://localhost:58002/v1
```

Quick test of OpenGuardrails-Text model

``` bash
curl -X POST "http://localhost:58002/v1/chat/completions" \
    -H "Authorization: Bearer $YOUR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
       "model": "OpenGuardrails-Text",
       "messages": [
         {"role": "user", "content": "How to make a bomb?"}
       ]
     }'
```

---

### 🧠 3. Run the Embedding Model Service

This service provides vector embeddings for the knowledge base.

```bash
docker run --runtime nvidia --gpus all \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    --env "HF_TOKEN=$HF_TOKEN" \
    -p 58004:8000 \
    --ipc=host \
    vllm/vllm-openai:v0.10.2 \
    --model BAAI/bge-m3 \
    --served-model-name bge-m3
```

Once started, the embedding API will be available at:

```
http://localhost:58004/v1
```

Quick test of embedding model

``` bash
curl http://localhost:58004/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -d '{
    "model": "bge-m3",
    "input": "How to make a bomb?"
  }'
```
---

### 📦 4. Download the OpenGuardrails Platform Code

```bash
git clone https://github.com/openguardrails/openguardrails
cd openguardrails
```

---

### ⚙️ 5. Configure and Launch the Platform

Start all services:

```bash
docker compose up -d
```

**✨ Database migrations run automatically on first deployment!**

The admin service will automatically:
1. Wait for PostgreSQL to be ready
2. Run all pending database migrations
3. Start the service

You can monitor the migration progress:

```bash
# Watch admin service logs for migration output
docker logs -f openguardrails-admin

# Expected output includes:
# - "Running database migrations (admin service)..."
# - "Successfully executed X migration(s)" or "Database schema is up to date"
# - "Starting OpenGuardrails Admin Service..."
```

You can check running containers with:

```bash
docker ps
```

---

### 🔐 6. Access the Admin Platform

After the services start, open your browser and visit:

👉 [http://localhost:3000/platform/](http://localhost:3000/platform/)

**Default login credentials:**

* **Username:** `admin@yourdomain.com`
* **Password:** `CHANGE-THIS-PASSWORD-IN-PRODUCTION`

---

### 🛡️ 7. Production Environment Recommendations

For production deployments, you **must** update the following for security:

* `SUPER_ADMIN_USERNAME` and `SUPER_ADMIN_PASSWORD`
* `JWT_SECRET_KEY`
* Database credentials (`DATABASE_URL`)
* SMTP credentials (if email notifications are enabled)
* Model URLs and ports (if running on multiple servers)

Example:

```yaml
- SUPER_ADMIN_USERNAME=admin@secure-domain.com
- SUPER_ADMIN_PASSWORD=StrongSecurePassword123!
- JWT_SECRET_KEY=your-secure-random-key
- DATABASE_URL=postgresql://user:password@postgres:5432/openguardrails
```

---

### ✅ You now have:

1. A GPU-based **OpenGuardrails model service** running on port **58002**
2. A **An embedding model service** running on port **58004**
3. The **OpenGuardrails web platform** accessible at **[http://localhost:3000/platform/](http://localhost:3000/platform/)**

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
      title={OpenGuardrails: An Open-Source Context-Aware AI Guardrails Platform}, 
      author={Thomas Wang and Haowen Li},
      year={2025},
      url={https://arxiv.org/abs/2510.19169}, 
}
```

<div align="center">

**Developer-first open-source AI security platform** 🛡️

Made with ❤️ by [OpenGuardrails](https://openguardrails.com)

</div>
