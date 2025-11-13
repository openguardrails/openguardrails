# CLAUDE.md - OpenGuardrails Project Context

> 🤖 This document helps AI assistants (like Claude) quickly understand the OpenGuardrails project structure, architecture, and key components without needing to re-read all code files.

## ⚠️ CRITICAL DEPLOYMENT REQUIREMENT

**🚨 ABSOLUTE RULE: ONE-COMMAND DEPLOYMENT MUST ALWAYS WORK 🚨**

**Every code change MUST ensure that a first-time developer can successfully deploy the project with:**

Don't start frontend and backend using docker compose during development.
Start in this way:
cd frontend; npm run dev
cd backend; python start_admin_service.py
cd backend; python start_detection_service.py
cd backend; python start_proxy_service.py


```bash
docker compose up -d
```

**This is NON-NEGOTIABLE. Before making ANY changes that affect:**
- Database schema
- Service startup
- Dependencies
- Configuration
- Docker setup
- Environment variables

**You MUST verify that:**

1. ✅ Fresh deployment works: `docker compose down -v && docker compose up -d`
2. ✅ All services start successfully without manual intervention
3. ✅ Database migrations run automatically
4. ✅ No manual commands required (no SQL scripts, no migration runners)
5. ✅ Clear error messages if something fails
6. ✅ Services have proper health checks and dependency ordering

**The first-time deployment experience is CRITICAL to this project's success.**

**If your change breaks one-command deployment, you MUST:**
- Fix it immediately
- Add automatic handling (e.g., entrypoint scripts, migrations)
- Update documentation
- Test from clean state

**Testing checklist for every deployment-related change:**

```bash
# 1. Clean state test
docker compose down -v
docker volume ls | grep openguardrails  # Should be empty
docker compose up -d
docker logs -f openguardrails-admin  # Watch for errors
docker ps  # All services should be healthy

# 2. Verify services are accessible
curl http://localhost:3000/platform/  # Frontend
curl http://localhost:5000/health      # Admin service
curl http://localhost:5001/health      # Detection service
curl http://localhost:5002/health      # Proxy service

# 3. Verify database is initialized
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails -c "\dt"
```

**Remember: If a new developer can't deploy with `docker compose up -d`, we have FAILED.**

---

## Project Overview

**OpenGuardrails** is an enterprise-grade, open-source AI safety guardrails platform that provides comprehensive security protection for AI applications. It offers prompt attack detection, content safety checks, and data leak detection with complete on-premise deployment support.

- **License**: Apache 2.0
- **Model**: OpenGuardrails-Text-2510 (3.3B parameters, 119 languages)
- **Model Repository**: https://huggingface.co/openguardrails/OpenGuardrails-Text-2510
- **Website**: https://www.openguardrails.com
- **Contact**: thomas@openguardrails.com

## Core Capabilities

### 1. Two Usage Modes
- **API Call Mode** (Port 5001): Developers actively call detection APIs for precise control
- **Security Gateway Mode** (Port 5002): Transparent reverse proxy with zero-code transformation (WAF-style protection)

### 2. Triple Protection System
- **Prompt Attack Detection**: Jailbreaks, prompt injections, manipulation attempts
- **Content Safety Detection**: 19 risk categories with customizable thresholds
- **Data Leak Detection**: Privacy invasion, commercial violations, intellectual property

### 3. Key Features
- Context-aware multi-turn conversation detection
- Multimodal detection (text + image)
- Knowledge base-powered intelligent responses
- Ban policy for automatic malicious user blocking
- Deep customer system integration
- Three-tier sensitivity threshold configuration
- Real-time monitoring and visual management interface

## Architecture

### Three-Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Users/Developers                      │
└───────────┬─────────────┬────────────────┬──────────────┘
            │             │                │
   ┌────────▼───────┐ ┌──▼───────────┐ ┌──▼──────────────┐
   │ Management UI  │ │  API Call    │ │ Security Gateway│
   │  React Web     │ │  Mode        │ │    Mode         │
   │  (Port 3000)   │ │ (Active Det) │ │ (Transparent    │
   └────────┬───────┘ └──┬───────────┘ │  Proxy)         │
            │            │              └──┬──────────────┘
            │            │                 │
   ┌────────▼────────┐ ┌▼─────────────┐ ┌─▼──────────────┐
   │ Admin Service   │ │ Detection    │ │ Proxy Service  │
   │   Port 5000     │ │   Service    │ │   Port 5002    │
   │  (2 workers)    │ │  Port 5001   │ │  (24 workers)  │
   │  Low Conc.      │ │ (32 workers) │ │  High Conc.    │
   └────────┬────────┘ └──┬───────────┘ └─┬──────────────┘
            │             │                │
            └─────────────┴────────────────┴───────────────┐
                                                            │
                    ┌───────────────────────────────────────▼──┐
                    │        PostgreSQL Database               │
                    │  Users | Results | Blacklist/Whitelist  │
                    │  Proxy Config | Upstream Models         │
                    └──────────────────────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │     OpenGuardrails Model (vLLM)          │
                    │   OpenGuardrails-Text-2510 (3.3B)        │
                    │        Port 58002 (Text)                 │
                    │        Port 58003 (Vision-Language)      │
                    └──────────────────────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │     Embedding Model (bge-m3)             │
                    │        Port 58004                        │
                    └──────────────────────────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │      Upstream AI Models (Proxy Only)     │
                    │  OpenAI | Anthropic | Local | Others    │
                    └──────────────────────────────────────────┘
```

### Service Details

| Service | Port | Workers | Purpose | Key Routes | Deployment |
|---------|------|---------|---------|-----------|------------|
| **Text Model** | 58002 | GPU | AI safety detection model (vLLM) | `/v1/chat/completions` | 🆕 **Included in docker-compose** |
| **Embedding Model** | 58004 | GPU | Vector embeddings (vLLM) | `/v1/embeddings` | 🆕 **Included in docker-compose** |
| **Admin Service** | 5000 | 2 | User & config management | `/api/v1/auth`, `/api/v1/users`, `/api/v1/config` | Docker Compose |
| **Detection Service** | 5001 | 32 | High-concurrency safety detection | `/v1/guardrails`, `/api/v1/dashboard` | Docker Compose |
| **Proxy Service** | 5002 | 24 | OpenAI-compatible security gateway | `/v1/chat/completions` | Docker Compose |
| **Frontend** | 3000 | - | React management interface | `/platform/` | Docker Compose |
| **PostgreSQL** | 54321 | - | Primary database | - | Docker Compose |

**🚀 NEW: One-Command Deployment**
- All services (including GPU models) now start with single `docker compose up -d` command
- Models automatically download from HuggingFace on first run
- No need to manually start model services separately
- Internal Docker networking for optimal performance

## Project Structure

```
openguardrails/
├── backend/                      # Python FastAPI backend
│   ├── admin_service.py         # Admin service FastAPI app
│   ├── detection_service.py     # Detection service FastAPI app
│   ├── proxy_service.py         # Proxy service FastAPI app
│   ├── start_admin_service.py   # Admin service startup script
│   ├── start_detection_service.py  # Detection service startup script
│   ├── start_proxy_service.py   # Proxy service startup script
│   ├── config.py                # Configuration management
│   ├── database/
│   │   ├── connection.py        # Database connection and session management
│   │   └── models.py            # SQLAlchemy ORM models
│   ├── routers/                 # API route handlers
│   │   ├── auth.py              # Authentication endpoints
│   │   ├── user.py              # User management
│   │   ├── guardrails.py        # Detection API (service port 5001)
│   │   ├── detection_guardrails.py  # Detection logic
│   │   ├── proxy_api.py         # Proxy endpoints (port 5002)
│   │   ├── proxy_management.py  # Proxy config management
│   │   ├── dashboard.py         # Dashboard statistics
│   │   ├── results.py           # Detection results query
│   │   ├── config_api.py        # Configuration APIs
│   │   ├── risk_config_api.py   # Risk type configuration
│   │   ├── ban_policy_api.py    # Ban policy management
│   │   ├── data_security.py     # Data security configuration
│   │   ├── online_test.py       # Online testing interface
│   │   ├── media.py             # Media file handling
│   │   └── dify_moderation.py   # Dify integration
│   ├── services/                # Business logic services
│   │   ├── guardrail_service.py         # Core detection logic
│   │   ├── detection_guardrail_service.py  # Detection orchestration
│   │   ├── model_service.py             # Model API interaction
│   │   ├── proxy_service.py             # Proxy service logic
│   │   ├── ban_policy_service.py        # Ban policy enforcement
│   │   ├── keyword_service.py           # Keyword matching
│   │   ├── knowledge_base_service.py    # Knowledge base Q&A
│   │   ├── data_security_service.py     # Data leak detection
│   │   ├── risk_config_service.py       # Risk configuration
│   │   ├── template_service.py          # Response templates
│   │   ├── enhanced_template_service.py # Enhanced templates with KB
│   │   ├── stats_service.py             # Statistics calculation
│   │   ├── rate_limiter.py              # Rate limiting
│   │   ├── async_logger.py              # Async logging
│   │   ├── log_to_db_service.py         # Database logging
│   │   ├── keyword_cache.py             # Keyword cache management
│   │   ├── risk_config_cache.py         # Risk config cache
│   │   └── template_cache.py            # Template cache
│   ├── middleware/
│   │   ├── rate_limit_middleware.py     # Rate limiting middleware
│   │   └── concurrent_limit_middleware.py  # Concurrency control
│   ├── models/
│   │   ├── requests.py          # Pydantic request models
│   │   └── responses.py         # Pydantic response models
│   ├── utils/
│   │   ├── auth.py              # Authentication utilities
│   │   ├── auth_cache.py        # Auth result caching
│   │   ├── user.py              # User utilities
│   │   ├── validators.py        # Input validators
│   │   ├── logger.py            # Logging configuration
│   │   ├── email.py             # Email sending
│   │   ├── i18n.py              # Internationalization
│   │   ├── message_truncator.py # Message truncation
│   │   ├── image_utils.py       # Image processing
│   │   └── url_signature.py     # URL signing
│   ├── migrations/              # Database migrations (AUTO-RUN on startup)
│   │   ├── run_migrations.py   # Migration runner script (called by entrypoint.sh)
│   │   ├── create_migration.sh # Create new migration script
│   │   ├── versions/           # SQL migration files (*.sql)
│   │   ├── README.md           # Migration documentation
│   │   └── *.py                # Python migration files (008, 009, 010, etc.)
│   ├── entrypoint.sh           # 🔑 Service startup script (runs migrations automatically)
│   ├── scripts/
│   │   ├── reset_db.py          # Database reset
│   │   └── security_check.py    # Security checks
│   ├── i18n/                    # Internationalization files
│   ├── config/                  # Configuration files
│   ├── .env                     # Environment variables
│   ├── requirements.txt         # Python dependencies
│   └── Dockerfile               # Backend Docker image
│
├── frontend/                    # React + TypeScript + Ant Design
│   ├── src/
│   │   ├── App.tsx              # Main app component
│   │   ├── main.tsx             # Entry point
│   │   ├── components/          # Reusable components
│   │   │   ├── Layout/          # Main layout
│   │   │   ├── ProtectedRoute/  # Route protection
│   │   │   ├── LanguageSwitcher/ # Language switcher
│   │   │   └── ImageUpload/     # Image upload component
│   │   ├── pages/               # Page components
│   │   │   ├── Login/           # Login page
│   │   │   ├── Register/        # Registration page
│   │   │   ├── Verify/          # Email verification
│   │   │   ├── Dashboard/       # Dashboard
│   │   │   ├── OnlineTest/      # Online testing
│   │   │   ├── Results/         # Detection results
│   │   │   ├── Config/          # Configuration pages
│   │   │   │   ├── BlacklistManagement.tsx
│   │   │   │   ├── WhitelistManagement.tsx
│   │   │   │   ├── ResponseTemplateManagement.tsx
│   │   │   │   ├── BanPolicy.tsx
│   │   │   │   ├── RiskTypeManagement.tsx
│   │   │   │   ├── SensitivityThresholdManagement.tsx
│   │   │   │   ├── KnowledgeBaseManagement.tsx
│   │   │   │   └── ProxyModelManagement.tsx
│   │   │   ├── DataSecurity/    # Data security config
│   │   │   ├── SecurityGateway/ # Security gateway management
│   │   │   ├── Account/         # Account management
│   │   │   ├── Admin/           # Admin panel
│   │   │   │   ├── UserManagement.tsx
│   │   │   │   └── RateLimitManagement.tsx
│   │   │   └── Documentation/   # Documentation page
│   │   ├── contexts/
│   │   │   └── AuthContext.tsx  # Authentication context
│   │   ├── services/            # API services
│   │   ├── types/               # TypeScript types
│   │   ├── utils/               # Utility functions
│   │   ├── locales/             # i18n translations
│   │   └── i18n.ts              # i18n configuration
│   ├── public/                  # Static assets
│   ├── package.json             # Node dependencies
│   ├── vite.config.ts           # Vite configuration
│   ├── nginx.conf               # Nginx configuration
│   └── Dockerfile               # Frontend Docker image
│
├── docs/                        # Documentation
│   ├── API_REFERENCE.md         # Complete API documentation
│   ├── DEPLOYMENT.md            # Deployment guide
│   └── MIGRATION_GUIDE.md       # Database migration guide
│
├── tests/                       # Test files
│   ├── README.md
│   └── DIFY_INTEGRATION.md      # Dify integration tests
│
├── data/                        # Data directory (mounted volume)
├── docker-compose.yml           # Docker Compose configuration
├── README.md                    # Main documentation
├── SECURITY.md                  # Security policy
├── CONTRIBUTING.md              # Contribution guidelines
├── CHANGELOG.md                 # Version history
├── VERSION                      # Version number
└── LICENSE                      # Apache 2.0 license
```

## Database Schema (Key Tables)

### Access database
In dev env, database is started by docker. To access it use:
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails -c "SELECT reques

### Core Tables

1. **tenants** - User/tenant management
   - `id` (UUID, PK), `email`, `password_hash`, `api_key`
   - `is_active`, `is_verified`, `is_super_admin`
   - `language` preference

2. **detection_results** - Detection history
   - `request_id`, `tenant_id`, `content`
   - `security_risk_level`, `security_categories`
   - `compliance_risk_level`, `compliance_categories`
   - `data_risk_level`, `data_categories`
   - `suggest_action` (pass/reject/replace)
   - `suggest_answer`, `hit_keywords`
   - `has_image`, `image_count`, `image_paths`

3. **blacklist** / **whitelist** - Keyword management
   - `tenant_id`, `name`, `keywords` (JSON)
   - `description`, `is_active`

4. **response_templates** - Response template management
   - `tenant_id`, `risk_category`, `template_text`
   - `is_active`, `priority`

5. **risk_type_config** - Risk type configuration
   - `tenant_id`, `compliance_config`, `security_config`, `data_config` (JSON)

6. **ban_policy** - Ban policy configuration
   - `tenant_id`, `is_enabled`, `ban_duration_minutes`
   - `high_risk_threshold`, `medium_risk_threshold`

7. **knowledge_base** - Knowledge base Q&A pairs
   - `tenant_id`, `question`, `answer`
   - `risk_categories` (JSON), `embedding` (vector)

8. **proxy_keys** - Proxy service API keys
   - `key`, `tenant_id`, `is_active`
   - `upstream_provider`, `upstream_api_key`

9. **upstream_models** - Upstream model configurations
   - `tenant_id`, `provider`, `model_name`
   - `api_base_url`, `api_key`

10. **rate_limits** - Rate limiting configuration
    - `tenant_id`, `requests_per_minute`, `requests_per_day`

11. **data_security_entity_types** - Data entity types for leak detection
    - `tenant_id`, `entity_type`, `is_enabled`

## Risk Categories (19 Types)

| Category | Label | Risk Level | Description |
|----------|-------|------------|-------------|
| Sensitive Political Topics | S2 | High | Subversion, separatism, national security threats |
| Insult to National Symbols | S3 | High | Insulting leaders, flag, emblem, anthem |
| Violent Crime | S5 | High | Murder, terrorism, promoting violence |
| Prompt Attacks | S9 | High | Jailbreaks, injections, manipulation |
| WMDs | S15 | High | Chemical, biological, nuclear weapons |
| Sexual Crimes | S17 | High | Sexual assault, exploitation |
| Harm to Minors | S4 | Medium | Child exploitation, nudity, abuse |
| Non-Violent Crime | S6 | Medium | Fraud, drugs, hacking |
| Pornography | S7 | Medium | Adult nudity, sexual acts |
| Self-Harm | S16 | Medium | Suicide, self-injury, eating disorders |
| General Political Topics | S1 | Low | General political issues |
| Hate & Discrimination | S8 | Low | Discrimination based on race, gender, religion |
| Profanity | S10 | Low | Insults, vulgar speech |
| Privacy Invasion | S11 | Low | Leaking personal data |
| Commercial Violations | S12 | Low | Fraud, unfair competition, trade secrets |
| IP Infringement | S13 | Low | Plagiarism, copyright/patent violations |
| Harassment | S14 | Low | Verbal abuse, humiliation, attacks |
| Threats | S18 | Low | Violent threats, intimidation |
| Professional Advice | S19 | Low | Financial, medical, legal advice beyond general info |

### Processing Strategies

- **High Risk**: Substitute with preset safety responses
- **Medium Risk**: Substitute with custom knowledge base responses
- **Low Risk**: Allow normal processing
- **No Risk**: Allow with no restrictions

---

## 🚀 MAJOR ARCHITECTURAL CHANGE: Scanner Package System

> **Status**: Planning Phase (as of 2025-11-05)
> **Impact**: Breaking Change - Complete Refactoring of Risk Type System
> **Migration**: Automatic (backward compatible during transition)

### Overview

The hardcoded 21 risk types (S1-S21) are being replaced with a **flexible Scanner Package System** that supports:

1. **Built-in Official Packages**: System-provided scanners (S1-S21 migrated to 2 packages)
2. **Purchasable Official Packages**: Admin-published packages with manual purchase approval
3. **Custom Scanners**: User-defined scanners (S100+, auto-assigned tags)
4. **Three Scanner Types**: genai, regex, keyword

### Why This Change?

**Current System Problems:**
- ❌ Hardcoded database schema (21 boolean columns)
- ❌ Cannot add new risk types without migration
- ❌ No support for custom user-defined detection rules
- ❌ Risk metadata (names, descriptions) scattered in code
- ❌ Duplicate mappings across multiple files
- ❌ Frontend UI cannot adapt to new risk types

**New System Benefits:**
- ✅ Flexible scanner management (no schema changes needed)
- ✅ Users can create custom scanners (S100+)
- ✅ Admins can publish/sell scanner packages
- ✅ All metadata stored in database
- ✅ Dynamic frontend rendering
- ✅ Support for multiple scanner types (genai, regex, keyword)

### Scanner Tag Allocation

| Range | Purpose | Example |
|-------|---------|---------|
| **S1-S21** | Built-in packages (existing risk types migrated) | S2 (Sensitive Political Topics) |
| **S22-S99** | Reserved for future official packages | (Available for expansion) |
| **S100+** | Custom scanners (user-defined, per-application) | S100 (Custom Bank Fraud) |

### Scanner Types

1. **GenAI Scanner**
   - Uses OpenGuardrails-Text model for detection
   - Definition passed to model via `chat_template_kwargs.unsafe_categories`
   - Format: `"S100: [name]. [definition]"`
   - Example: "S100: Bank Fraud. Detecting attempts to commit banking fraud or scams"

2. **Regex Scanner**
   - Python regex pattern matching in backend
   - No model call required
   - Example: Chinese ID card pattern, credit card numbers, phone numbers

3. **Keyword Scanner**
   - Case-insensitive keyword matching in backend
   - Comma-separated keyword list
   - Example: "HSBC, Citibank, Wells Fargo, Bank of America"

### Built-in Package Migration

The existing 21 risk types are migrated into 2 built-in packages:

**Package 1: Restricted Topics Package**
- S19: Professional Financial Advice
- S20: Professional Medical Advice
- S21: Professional Legal Advice

**Package 2: Sensitive Topics Package**
- S1-S18: All other risk categories

Built-in packages are stored as JSON files in `backend/config/builtin_scanners/` and loaded automatically on service startup.

### New Database Schema

**Five New Tables:**
1. `scanner_packages` - Package metadata (name, author, version, type)
2. `scanners` - Individual scanner definitions (tag, type, definition, risk_level)
3. `application_scanner_configs` - Per-application scanner settings (enable/disable, overrides)
4. `package_purchases` - Tracks purchased packages (pending/approved/rejected)
5. `custom_scanners` - User-defined custom scanners (S100+)

### New API Endpoints

**Package Management:**
- `GET /api/v1/scanners/packages` - List all packages
- `GET /api/v1/scanners/packages/marketplace` - Browse purchasable packages
- `POST /api/v1/scanners/packages` - Upload purchasable package (admin)

**Scanner Configuration:**
- `GET /api/v1/scanners/configs` - Get application's scanner configs
- `PUT /api/v1/scanners/configs/{scanner_id}` - Update scanner settings
- `POST /api/v1/scanners/configs/reset` - Reset to defaults

**Custom Scanners:**
- `GET /api/v1/scanners/custom` - List custom scanners
- `POST /api/v1/scanners/custom` - Create custom scanner (auto-assign S100+)
- `PUT /api/v1/scanners/custom/{id}` - Update custom scanner
- `DELETE /api/v1/scanners/custom/{id}` - Delete custom scanner

**Purchase Management:**
- `POST /api/v1/scanners/purchases/request` - Request package purchase
- `POST /api/v1/scanners/purchases/{id}/approve` - Approve purchase (admin)

### New Frontend Pages

1. **Official Scanners** (`/platform/config/official-scanners`)
   - View built-in packages
   - View purchased packages
   - Browse marketplace (purchasable packages)
   - Configure individual scanners (enable/disable, risk level, scan targets)

2. **Custom Scanners** (`/platform/config/custom-scanners`)
   - Create custom scanners (form-based UI)
   - Edit/delete custom scanners
   - Auto-assigned tags (S100, S101, ...)

3. **Admin Package Marketplace** (`/platform/admin/package-marketplace`)
   - Upload purchasable packages
   - View purchase requests
   - Approve/reject purchases

### Detection Flow Changes

**Old Detection Flow:**
1. Get enabled risk types from `risk_type_config` (21 boolean fields)
2. Call model with hardcoded risk type definitions
3. Parse response, filter by enabled types

**New Detection Flow:**
1. Get enabled scanners from `application_scanner_configs`
2. Group by scanner type:
   - **GenAI**: Combine all definitions, single model call
   - **Regex**: Execute in backend (parallel with model call)
   - **Keyword**: Execute in backend (parallel with model call)
3. Parse results, determine highest risk level
4. User-configured risk levels override package defaults

**Performance Optimization:**
- Regex and keyword scanners run in parallel with GenAI model call
- Single model call for all GenAI scanners (combined definitions)
- Expected latency increase: < 10%

### Migration Strategy

**Automatic Migration:**
- Database migration runs automatically on service startup
- Existing S1-S21 configurations preserved
- User enable/disable states migrated to new system
- Old `risk_type_config` table kept for rollback safety

**Backward Compatibility:**
- Old API endpoints supported during transition period
- Detection results format unchanged
- One-command deployment still works: `docker compose up -d`

### Security Considerations

**Purchasable Package Protection:**
- Package definitions NOT sent to frontend before purchase
- Only metadata visible in marketplace
- Full scanner definitions visible only after purchase approval
- Prevents leaking paid content

**Custom Scanner Limits:**
- Free users: 10 custom scanners per application
- Subscribed users: 50 custom scanners per application
- Rate limiting on custom scanner creation

### Documentation

For complete implementation details, see:
- **Implementation Plan**: [docs/SCANNER_PACKAGE_IMPLEMENTATION_PLAN.md](docs/SCANNER_PACKAGE_IMPLEMENTATION_PLAN.md)
- **Example Packages**: [docs/scanner_packages_examples/](docs/scanner_packages_examples/)

### Timeline

**Estimated Implementation:** 5 weeks
- Week 1-2: Database & Backend
- Week 3: Frontend
- Week 4: Integration & Testing
- Week 5: Documentation & Deployment

---

## Environment Variables (Key Configs)

### Database
- `DATABASE_URL`: PostgreSQL connection string
- `RESET_DATABASE_ON_STARTUP`: Reset DB on startup (dev only)

### Authentication
- `JWT_SECRET_KEY`: JWT token signing key
- `SUPER_ADMIN_USERNAME`: Default admin email
- `SUPER_ADMIN_PASSWORD`: Default admin password

### Model APIs
- `GUARDRAILS_MODEL_API_URL`: OpenGuardrails-Text model endpoint (default: http://host.docker.internal:58002/v1)
- `GUARDRAILS_MODEL_API_KEY`: Model API key
- `GUARDRAILS_MODEL_NAME`: Model name (OpenGuardrails-Text)
- `GUARDRAILS_VL_MODEL_API_URL`: Vision-Language model endpoint (port 58003)
- `GUARDRAILS_VL_MODEL_NAME`: VL model name (OpenGuardrails-VL)

### Embedding Model
- `EMBEDDING_API_BASE_URL`: Embedding API endpoint (default: http://host.docker.internal:58004/v1)
- `EMBEDDING_API_KEY`: Embedding API key
- `EMBEDDING_MODEL_NAME`: Model name (bge-m3)
- `EMBEDDING_MODEL_DIMENSION`: Vector dimension (1024)
- `EMBEDDING_SIMILARITY_THRESHOLD`: Similarity threshold (0.7)

### Service Configuration
- `ADMIN_PORT`: Admin service port (5000)
- `ADMIN_UVICORN_WORKERS`: Admin workers (2)
- `DETECTION_PORT`: Detection service port (5001)
- `DETECTION_UVICORN_WORKERS`: Detection workers (32)
- `PROXY_PORT`: Proxy service port (5002)
- `PROXY_UVICORN_WORKERS`: Proxy workers (24)

### Other
- `CORS_ORIGINS`: Allowed CORS origins
- `DEBUG`: Debug mode (true/false)
- `LOG_LEVEL`: Logging level (INFO/DEBUG/WARNING/ERROR)
- `DATA_DIR`: Data directory path
- `DEPLOYMENT_MODE`: Deployment mode (local/cloud)

## API Authentication

### 1. API Key (for Detection/Proxy APIs)
```http
Authorization: Bearer sk-xxai-your-api-key-here
```

### 2. JWT Token (for Admin APIs)
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. Super Admin User Switching
```http
X-Switch-User: {user_id}
```

## Key API Endpoints

### Detection Service (Port 5001)

#### Main Detection API

**⚠️ IMPORTANT: `extra_body` Usage Note**

The `extra_body` parameter is **ONLY for OpenAI Python SDK** (and similar client libraries). The SDK automatically unfolds `extra_body` parameters to the request body's top level.

**Python SDK (CORRECT - use `extra_body`):**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:5001/v1",
    api_key="sk-xxai-your-api-key"
)

response = client.chat.completions.create(
    model="OpenGuardrails-Text",
    messages=[{"role": "user", "content": "test"}],
    extra_body={
        "xxai_app_user_id": "user123",
        "enable_security": True
    }
)
```

**curl / HTTP API (CORRECT - flatten to top level):**
```bash
curl -X POST "http://localhost:5001/v1/guardrails" \
  -H "Authorization: Bearer sk-xxai-{api-key}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "OpenGuardrails-Text",
    "messages": [{"role": "user", "content": "test"}],
    "xxai_app_user_id": "user123",
    "enable_security": true,
    "enable_compliance": true,
    "enable_data_security": true
  }'
```

**❌ WRONG (curl with extra_body - this will NOT work):**
```bash
# DO NOT USE THIS - extra_body is not a valid HTTP parameter
curl -X POST "..." -d '{
  "model": "...",
  "messages": [...],
  "extra_body": {  // ❌ WRONG - only for SDK
    "xxai_app_user_id": "user123"
  }
}'
```

#### Dify Moderation Integration
```
POST /v1/guardrails/input    # Input moderation
POST /v1/guardrails/output   # Output moderation
```

### Proxy Service (Port 5002)

#### OpenAI-Compatible Endpoint
```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-xxai-{proxy-key}

{
  "model": "gpt-4",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

### Admin Service (Port 5000)

- `/api/v1/auth/login` - User login
- `/api/v1/auth/register` - User registration
- `/api/v1/users/me` - Get current user info
- `/api/v1/config/blacklist` - Blacklist management
- `/api/v1/config/whitelist` - Whitelist management
- `/api/v1/config/templates` - Response templates
- `/api/v1/config/ban-policy` - Ban policy config
- `/api/v1/risk-config` - Risk type configuration
- `/api/v1/proxy/keys` - Proxy key management
- `/api/v1/proxy/models` - Upstream model config
- `/api/v1/dashboard/stats` - Dashboard statistics
- `/api/v1/results` - Detection results query

## Detection Flow

### Single-Turn Detection
1. Receive user input
2. Check ban status (IP/user_id)
3. Whitelist keyword check (early pass)
4. Blacklist keyword check (early reject)
5. Call OpenGuardrails-Text model for:
   - Security risk detection (prompt attacks)
   - Compliance risk detection (content safety)
   - Data security detection (data leaks)
6. Aggregate risk levels (highest risk wins)
7. Determine action: pass/reject/replace
8. If replace needed, get response from:
   - Knowledge base (vector similarity search)
   - Response templates (by risk category)
9. Log result to database (async)
10. Return detection result

### Multi-Turn Conversation Detection
- Same as single-turn but with conversation history context
- Model analyzes full conversation context for better accuracy

### Proxy Mode Detection
1. Receive OpenAI-compatible request
2. Run input detection
3. If blocked: return error or substitute response
4. If pass: forward to upstream model
5. Get upstream response
6. Run output detection
7. If blocked: return error or substitute response
8. If pass: return upstream response

## Deployment

### Quick Start (Docker Compose)
```bash
# 1. Clone repository
git clone https://github.com/openguardrails/openguardrails
cd openguardrails

# 2. Set up environment variables
cp .env.example .env
# Edit .env and set your HF_TOKEN from https://huggingface.co/settings/tokens

# 3. Start ALL services with one command (including models!)
docker compose up -d

# ✨ Everything runs automatically:
# - OpenGuardrails Text Model (port 58002) - includes GPU vLLM service
# - Embedding Model (port 58004) - includes GPU vLLM service
# - PostgreSQL Database (port 54321)
# - Admin Service (port 5000)
# - Detection Service (port 5001)
# - Proxy Service (port 5002)
# - Frontend Web UI (port 3000)
# - Database migrations run automatically!

# 4. Monitor startup (first time may take 5-10 minutes to download models)
docker compose logs -f

# Watch specific services:
docker logs -f openguardrails-admin          # Admin service + migrations
docker logs -f openguardrails-text-model     # Text model loading
docker logs -f openguardrails-embedding      # Embedding model loading

# 5. Check all services are healthy
docker ps  # All containers should show "Up" or "healthy" status

# 6. Access platform
# Frontend: http://localhost:3000/platform/
# Default credentials: admin@yourdomain.com / CHANGE-THIS-PASSWORD-IN-PRODUCTION
```

### 🔄 Automatic Database Migration System

**All database migrations run automatically on service startup!**

In PostgreSQL, the SQL syntax for migrating files does not support using IF NOT EXISTS within ADD CONSTRAINT. You need to modify the constraint addition to use a DO block to check whether the constraint already exists before adding it.

#### How It Works

1. **Entrypoint Script** ([backend/entrypoint.sh](backend/entrypoint.sh)):
   - Runs before each backend service starts
   - Waits for PostgreSQL to be ready (`pg_isready`)
   - Executes migrations (admin service only, to avoid race conditions)
   - Starts the actual service (admin/detection/proxy)

2. **Migration Runner** ([backend/migrations/run_migrations.py](backend/migrations/run_migrations.py)):
   - Uses PostgreSQL advisory locks to prevent concurrent execution
   - Reads all SQL migration files from `backend/migrations/versions/`
   - Tracks executed migrations in `schema_migrations` table
   - Executes pending migrations in order
   - Records success/failure for each migration

3. **Migration Flow**:
   ```
   docker compose up -d
   ↓
   PostgreSQL starts (with healthcheck)
   ↓
   Admin Service → entrypoint.sh
     → Wait for PostgreSQL
     → Run migrations (with lock)
     → Start admin service
   ↓
   Detection/Proxy Services → entrypoint.sh
     → Wait for PostgreSQL
     → Skip migrations (SERVICE_NAME != admin)
     → Start respective service
   ↓
   All services ready!
   ```

4. **Key Features**:
   - ✅ **Zero manual intervention** - Works on first `docker compose up -d`
   - ✅ **Concurrent-safe** - Advisory locks prevent race conditions
   - ✅ **Idempotent** - Safe to run multiple times
   - ✅ **Trackable** - All executions logged in `schema_migrations` table
   - ✅ **Safe failure** - Service won't start if migration fails

5. **⚠️ CRITICAL: Container-Level vs Worker-Level Execution**:

   **Migrations run at CONTAINER level, NOT worker level!**

   ```
   Container starts (once)
     ↓
   entrypoint.sh runs (once per container)
     ↓
   migrations/run_migrations.py runs (once)
     ↓
   exec python3 start_admin_service.py
     ↓
   Uvicorn master process starts
     ↓
   Uvicorn forks workers (ADMIN_UVICORN_WORKERS=2)
     ↓
   Worker 1 handles requests
   Worker 2 handles requests
   ```

   **Key Points**:
   - ✅ entrypoint.sh runs **ONCE per container** (not once per worker)
   - ✅ Migrations run **BEFORE uvicorn starts** (container startup phase)
   - ✅ Workers are forked **AFTER migrations complete**
   - ✅ Even with 2 admin workers, 32 detection workers, 24 proxy workers → migrations run **ONLY ONCE**
   - ✅ PostgreSQL advisory locks provide additional protection against concurrent execution

   **Services and Workers**:
   - Admin service: 2 workers → runs migrations once before workers fork
   - Detection service: 32 workers → skips migrations (SERVICE_NAME != admin)
   - Proxy service: 24 workers → skips migrations (SERVICE_NAME != admin)
   - **Total: 58 workers, but migrations execute only once!**

   **See**: [docs/MIGRATION_FAQ.md](docs/MIGRATION_FAQ.md) for detailed explanation

6. **Monitoring Migrations**:
   ```bash
   # Watch migration execution
   docker logs -f openguardrails-admin | grep -i migration

   # Check migration history
   docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
     -c "SELECT version, description, executed_at, success FROM schema_migrations ORDER BY version;"
   ```

7. **Related Documentation**:
   - [backend/migrations/README.md](backend/migrations/README.md) - Migration system documentation
   - [docs/AUTO_MIGRATION_TEST.md](docs/AUTO_MIGRATION_TEST.md) - Testing guide
   - [docs/MIGRATION_FAQ.md](docs/MIGRATION_FAQ.md) - Frequently asked questions
   - [docs/MIGRATION_FLOW.md](docs/MIGRATION_FLOW.md) - Detailed flow visualization

### Production Considerations
- Update all default passwords and secrets
- Configure SMTP for email verification
- Set up proper CORS origins
- Configure rate limits
- Enable HTTPS/TLS
- Set up monitoring and logging
- Scale services with more workers as needed
- Use production-grade PostgreSQL (not Alpine)

## Key Dependencies

### Backend (Python)
- **FastAPI**: Web framework
- **SQLAlchemy**: ORM for database
- **Pydantic**: Data validation
- **Uvicorn**: ASGI server
- **PostgreSQL**: Primary database
- **OpenAI SDK**: For upstream model calls
- **Pillow**: Image processing
- **PyJWT**: JWT token handling

### Frontend (TypeScript/React)
- **React 18**: UI framework
- **Ant Design**: UI component library
- **React Router**: Routing
- **i18next**: Internationalization
- **Axios**: HTTP client
- **Vite**: Build tool

## Testing

### Dify Integration
See [tests/DIFY_INTEGRATION.md](tests/DIFY_INTEGRATION.md) for detailed Dify moderation API integration tests.

### Online Testing
The platform provides an online testing interface at `/platform/online-test` for manual content safety checks.

## Internationalization

The platform supports multiple languages with i18n:
- **Backend**: `backend/i18n/` (JSON translation files)
- **Frontend**: `frontend/src/locales/` (JSON translation files)
- Supported languages: English (en), Chinese (zh)

## Caching Strategy

To optimize performance, the platform uses multiple caching layers:
- **Auth Cache**: Cache authentication results (1 hour TTL)
- **Keyword Cache**: Cache blacklist/whitelist keywords (5 min TTL)
- **Risk Config Cache**: Cache risk type configurations (5 min TTL)
- **Template Cache**: Cache response templates (5 min TTL)

## Rate Limiting

Rate limiting is enforced at multiple levels:
- Per-tenant rate limits (configurable via admin panel)
- Global concurrent request limits per service
- Middleware-based enforcement

## Common Workflows

### Adding a New Risk Category
1. Update `backend/database/models.py` - Add to RiskTypeConfig JSON schema
2. Update frontend `frontend/src/pages/Config/RiskTypeManagement.tsx`
3. Update model prompt or fine-tune OpenGuardrails-Text model
4. Update response templates for new category

### Adding a New API Endpoint
1. Create route handler in `backend/routers/`
2. Add service logic in `backend/services/`
3. Update Pydantic models in `backend/models/`
4. Update API documentation in `docs/API_REFERENCE.md`
5. Add frontend service call in `frontend/src/services/`
6. Create or update frontend page component
7. ⚠️ **TEST**: Verify `docker compose up -d` still works from clean state

### Adding a New Database Migration
**⚠️ CRITICAL: All database changes MUST use migrations to maintain one-command deployment!**

1. **Create migration file**:
   ```bash
   cd backend/migrations
   ./create_migration.sh description_of_change
   ```
   This creates `versions/XXX_description_of_change.sql`

2. **Write SQL migration**:
   ```sql
   -- Use idempotent operations
   ALTER TABLE IF EXISTS my_table ADD COLUMN IF NOT EXISTS new_col VARCHAR(100);
   CREATE INDEX IF NOT EXISTS idx_new_col ON my_table(new_col);
   ```

3. **Test automatic migration**:
   ```bash
   # Clean state test
   docker compose down -v
   docker compose up -d

   # Verify migration ran
   docker logs openguardrails-admin | grep -i migration

   # Verify schema changes
   docker exec openguardrails-postgres psql -U openguardrails -d openguardrails -c "\d+ my_table"
   ```

4. **Commit the migration file**:
   ```bash
   git add backend/migrations/versions/XXX_description_of_change.sql
   git commit -m "Add migration: description of change"
   ```

**NEVER:**
- ❌ Manually modify database schema without a migration
- ❌ Require users to run manual SQL commands
- ❌ Use `RESET_DATABASE_ON_STARTUP=true` in production (migrations handle schema)
- ❌ Edit existing migration files (create new ones instead)

**ALWAYS:**
- ✅ Use migrations for ALL schema changes
- ✅ Test from clean state (`docker compose down -v && docker compose up -d`)
- ✅ Use idempotent SQL (IF EXISTS, IF NOT EXISTS)
- ✅ Document breaking changes in migration comments
- ✅ Remember: Migrations run at **container level** (once), not worker level (see "Container-Level vs Worker-Level Execution" above)

### Troubleshooting Tips

#### First Deployment Issues
**If `docker compose up -d` fails for a new developer:**

1. **Check PostgreSQL startup**:
   ```bash
   docker logs openguardrails-postgres
   docker exec openguardrails-postgres pg_isready -U openguardrails
   ```

2. **Check migration logs**:
   ```bash
   docker logs openguardrails-admin | grep -i migration
   # Look for "Successfully executed" or error messages
   ```

3. **Check service health**:
   ```bash
   docker ps  # All services should show "healthy" status
   docker compose ps  # Shows service states
   ```

4. **Common issues**:
   - ❌ PostgreSQL not ready → Check healthcheck in docker-compose.yml
   - ❌ Migration failed → Check SQL syntax in migration file
   - ❌ Service won't start → Check environment variables
   - ❌ Port conflicts → Check if ports 3000, 5000, 5001, 5002, 54321 are available

5. **Reset to clean state**:
   ```bash
   docker compose down -v  # Remove all containers and volumes
   docker system prune -f  # Clean up
   docker compose up -d    # Start fresh
   ```

#### Database Issues
- Check `DATABASE_URL` in docker-compose.yml
- Verify PostgreSQL is healthy: `docker ps`
- Check migration status:
  ```bash
  docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
    -c "SELECT * FROM schema_migrations ORDER BY version;"
  ```
- ⚠️ **NEVER use** `RESET_DATABASE_ON_STARTUP=true` (deprecated - use migrations instead)

#### Model Connection Issues
- Verify model services are running on ports 58002 (text), 58003 (VL), 58004 (embedding)
- Check `GUARDRAILS_MODEL_API_URL` and `EMBEDDING_API_BASE_URL`
- Test model endpoint: `curl http://localhost:58002/v1/models`

#### Authentication Issues
- Verify JWT_SECRET_KEY is consistent across services
- Check API key format: `sk-xxai-{32-char-hex}`
- Ensure tenant is active and verified

#### Performance Issues
- Increase UVICORN_WORKERS for bottleneck service
- Check PostgreSQL connection pool settings
- Monitor concurrent request limits
- Enable caching for frequently accessed data

## Development Tips

### Running Services Locally (Non-Docker)
```bash
# Backend (Admin)
cd backend
python start_admin_service.py

# Backend (Detection)
python start_detection_service.py

# Backend (Proxy)
python start_proxy_service.py

# Frontend
cd frontend
npm install
npm run dev
```

### Database Migrations
```bash
cd backend
python migrations/run_migrations.py
```

### Useful Docker Commands
```bash
# View logs
docker logs openguardrails-admin
docker logs openguardrails-detection
docker logs openguardrails-proxy
docker logs openguardrails-frontend

# Restart services
docker compose restart

# Stop all
docker compose down

# Rebuild and start
docker compose up -d --build
```

## Common Misconceptions & FAQs

### ❓ "We have multiple uvicorn workers. Won't migrations run multiple times?"

**Answer: NO. Migrations run at container level, not worker level.**

- ✅ Admin service has 2 workers → migrations run **once** (before workers fork)
- ✅ Detection service has 32 workers → migrations **skipped** (SERVICE_NAME != admin)
- ✅ Proxy service has 24 workers → migrations **skipped** (SERVICE_NAME != admin)
- ✅ Total: 58 workers, but migrations execute **only once**!

**Why it's safe**:
1. `entrypoint.sh` runs at **container startup** (once per container)
2. Migrations run **before** uvicorn starts
3. Workers are forked **after** migrations complete
4. PostgreSQL advisory locks prevent concurrent execution

**See**: [docs/MIGRATION_FAQ.md](docs/MIGRATION_FAQ.md) for detailed explanation

### ❓ "Can I still use RESET_DATABASE_ON_STARTUP?"

**Answer: NO. This is deprecated. Use migrations instead.**

- ❌ `RESET_DATABASE_ON_STARTUP=true` deletes ALL data on every restart
- ✅ Migrations handle schema evolution without data loss
- ✅ Set `RESET_DATABASE_ON_STARTUP=false` in production (already the default)

### ❓ "Do I need to run migrations manually?"

**Answer: NO. Migrations run automatically on `docker compose up -d`.**

- ✅ First deployment: migrations run automatically
- ✅ Updates: new migrations run automatically on restart
- ✅ No manual commands required
- ⚠️ Manual execution is available for debugging only

### ❓ "What if I need to change worker count?"

**Answer: It's safe to change. Migrations are unaffected.**

```yaml
# docker-compose.yml
- ADMIN_UVICORN_WORKERS=4      # Change from 2 to 4
- DETECTION_UVICORN_WORKERS=64 # Change from 32 to 64
- PROXY_UVICORN_WORKERS=48     # Change from 24 to 48
```

Migrations will still run **only once** regardless of worker count.

### ❓ "Can multiple services start simultaneously?"

**Answer: YES. It's safe. Only admin runs migrations.**

Even if all three services start at the same time:
- Admin service: runs migrations (with lock)
- Detection service: skips migrations
- Proxy service: skips migrations

PostgreSQL advisory locks ensure no conflicts.

## Security Considerations

- All passwords are hashed with bcrypt
- JWT tokens expire after configured duration
- API keys use secure random generation
- SQL injection protection via SQLAlchemy ORM
- CORS properly configured
- Rate limiting prevents abuse
- Ban policy auto-blocks malicious users
- Sensitive data (like API keys) not logged
- Multi-tenant isolation enforced at database level

## Commercial Services

OpenGuardrails offers commercial services:
- **Model Fine-tuning**: Industry/scenario-specific customization
- **Enterprise Support**: 24/7 support, 99.9% SLA
- **Custom Development**: API/UI customization, system integration

Contact: thomas@openguardrails.com

## Version Information

Current version: See [VERSION](VERSION) file
Recent changes: See [CHANGELOG.md](CHANGELOG.md)

---

**Last Updated**: 2025-10-29
**Generated for**: Claude Code and other AI assistants to quickly understand the OpenGuardrails project structure and architecture.

**Note**: This document includes critical deployment requirements and migration system details. Read the "⚠️ CRITICAL DEPLOYMENT REQUIREMENT" section at the top first!
