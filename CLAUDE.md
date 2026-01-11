# CLAUDE.md - OpenGuardrails Project Context

> AI assistant guide for OpenGuardrails architecture and development workflows.

## CRITICAL DEPLOYMENT REQUIREMENT

**ONE-COMMAND DEPLOYMENT MUST ALWAYS WORK: `docker compose up -d`**

**Development mode:**
```bash
cd frontend; npm run dev
cd backend; python start_admin_service.py
cd backend; python start_detection_service.py
cd backend; python start_proxy_service.py
```

**Production Environment Notes:**
- Current environment uses systemctl to start Python services (not Docker)
- Backend service ports:
  - Admin service: 53333
  - Detection service: 53334
  - Proxy service: 53335

**Before ANY changes affecting database/services/dependencies/config/Docker:**
1. ✅ Test: `docker compose down -v && docker compose up -d`
2. ✅ All services start without manual intervention
3. ✅ Database migrations run automatically
4. ✅ Services have proper health checks

**Testing checklist:**
```bash
docker compose down -v && docker compose up -d
docker logs -f openguardrails-platform
docker ps  # All services healthy
curl http://localhost:3000/platform/
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails -c "\dt"
```

---

## Project Overview

**OpenGuardrails**: Enterprise AI safety platform with prompt attack detection, content safety (19 risk categories), and data leak detection.

- **License**: Apache 2.0
- **Model**: OpenGuardrails-Text-2510 (3.3B, 119 languages)
- **Repo**: https://huggingface.co/openguardrails/OpenGuardrails-Text-2510
- **Contact**: thomas@openguardrails.com

### Core Features
- **API Call Mode** (5001): Active detection API
- **Security Gateway Mode** (5002): Transparent proxy (WAF-style)
- Multi-turn conversation, multimodal (text+image), knowledge base responses, ban policy

## Architecture

### Four Containers
1. **PostgreSQL** (54321): Database
2. **Text Model** (58002): OpenGuardrails-Text-2510 (vLLM, GPU)
3. **Embedding** (58004): BAAI/bge-m3 (vLLM, GPU)
4. **Platform** (unified): Nginx + 3 FastAPI services
   - Admin (5000, 2 workers): User/config management
   - Detection (5001, 32 workers): Safety detection
   - Proxy (5002, 24 workers): OpenAI-compatible gateway
   - Frontend (3000): React UI

**Start all**: `docker compose up -d` (models auto-download from HuggingFace)

## Project Structure

```
openguardrails/
├── backend/
│   ├── {admin,detection,proxy}_service.py  # FastAPI apps
│   ├── start_{admin,detection,proxy}_service.py  # Startup scripts
│   ├── database/{connection,models}.py  # SQLAlchemy ORM
│   ├── routers/  # API routes: auth, guardrails, proxy_api, config_api, etc.
│   ├── services/  # Business logic: guardrail_service, model_service, etc.
│   ├── models/{requests,responses}.py  # Pydantic models
│   ├── migrations/  # Auto-run migrations (entrypoint.sh)
│   └── entrypoint.sh  # Service startup + migrations
├── frontend/
│   ├── src/{pages,components,services,contexts}/
│   └── nginx.conf
└── docs/  # API_REFERENCE.md, DEPLOYMENT.md, MIGRATION_GUIDE.md, DATA_LEAKAGE_GUIDE.md
```

## Database Schema (Key Tables)

**Access DB**: `docker exec openguardrails-postgres psql -U openguardrails -d openguardrails`

1. **tenants**: Users (id, email, api_key, is_super_admin)
2. **detection_results**: Detection logs (risk levels, categories, actions)
3. **blacklist/whitelist**: Keywords (tenant_id, keywords JSON)
4. **response_templates**: Custom responses (risk_category, template_text)
5. **risk_type_config**: Risk type settings (compliance/security/data configs)
6. **ban_policy**: Auto-ban rules (thresholds, duration)
7. **knowledge_base**: Q&A pairs (embeddings for similarity search)
8. **proxy_keys**: Proxy API keys (upstream provider configs)
9. **upstream_api_config**: Model configs (provider, api_base_url, **safety attributes**)
10. **rate_limits**: Rate limit settings
11. **data_security_entity_types**: Data leak entity types (regex/GenAI recognition)
12. **application_data_leakage_policy**: Data leakage disposal policies per application

## Risk Categories (19 Types)

**High Risk (S2,S3,S5,S9,S15,S17)**: Sensitive politics, violent crime, prompt attacks, WMDs, sexual crimes
**Medium Risk (S4,S6,S7,S16)**: Harm to minors, non-violent crime, pornography, self-harm
**Low Risk (S1,S8,S10-S14,S18,S19)**: General politics, hate, profanity, privacy, commercial, IP, harassment, threats, professional advice

**Processing**: High→preset responses, Medium→knowledge base, Low→allow

---

## SCANNER PACKAGE SYSTEM (Planning Phase)

**Status**: Replacing hardcoded S1-S21 with flexible scanner packages

**New Features**:
- Built-in packages (S1-S21 migrated)
- Purchasable packages (admin-published)
- Custom scanners (S100+, user-defined)
- Three types: genai, regex, keyword

**Tag Allocation**: S1-S21 (built-in), S22-S99 (reserved), S100+ (custom)

**New Tables**: scanner_packages, scanners, application_scanner_configs, package_purchases, custom_scanners

**API Endpoints**: `/api/v1/scanners/{packages,configs,custom,purchases/*}`

**See**: docs/SCANNER_PACKAGE_IMPLEMENTATION_PLAN.md

---

## DATA LEAKAGE PREVENTION SYSTEM

**Status**: Production-ready (v5.1.0+)

**v5.1.0 Highlight**: **Automatic Private Model Switching** - Enterprise AI agents can now seamlessly protect sensitive data without affecting user experience. When sensitive data is detected, requests are automatically routed to private/on-premise models instead of blocking, ensuring data never leaves your infrastructure while maintaining uninterrupted user workflows.

**Architecture**: Multi-layer protection system with format-aware detection, intelligent disposal strategies, and automatic private model switching

### Key Components

**Format Detection Service** (`backend/services/format_detection_service.py`):
- Auto-detects content format (JSON, YAML, CSV, Markdown, Plain Text)
- Enables format-aware smart segmentation

**Segmentation Service** (`backend/services/segmentation_service.py`):
- JSON: Split by top-level objects (max 50 segments)
- YAML: Split by top-level keys (max 50 segments)
- CSV: Split by rows with header retention (max 100 rows)
- Markdown: Split by ## sections (max 30 sections)
- Plain Text: Single segment (no segmentation)

**Data Security Service** (`backend/services/data_security_service.py`):
- **Regex entities**: Applied to full text (ID cards, credit cards, etc.)
- **GenAI entities**: Applied per-segment with parallel processing
- Risk aggregation: Highest risk from all segments wins

**Data Leakage Disposal Service** (`backend/services/data_leakage_disposal_service.py`):
- **Block**: Reject request completely (default for high risk)
- **Anonymize**: Replace sensitive entities with placeholders (default for medium/low risk)
- **Switch Private Model**: Redirect to data-private model (optional)
- **Pass**: Allow request, log only (audit mode)

**Data Leakage Policy Flow**:
```
User Request → DLP Detection → Sensitive Data Found → Risk Level Determined
                                                              ↓
                           ┌──────────────────────────────────┼──────────────────────────────────┐
                           ↓                                  ↓                                  ↓
                    High Risk Action              Medium Risk Action                 Low Risk Action
                           ↓                                  ↓                                  ↓
                  Block (default)              Anonymize (default)               Anonymize (default)
                           ↓                                  ↓                                  ↓
                    Return Error           Replace with placeholders         Replace with placeholders
```

**Enterprise Value**: Users continue their workflow seamlessly while sensitive data automatically stays within your infrastructure.

### Private Model System (v5.1.0 Enhanced)

**Model Safety Attributes** (`upstream_api_config` table):
- `is_data_safe`: Mark as safe for sensitive data (on-premise, private cloud, air-gapped)
- `is_default_private_model`: Tenant-wide default private model
- `private_model_priority`: Priority ranking (0-100, higher = preferred)

**Private Model Selection Priority**:
1. Application policy `private_model_id` (explicit configuration)
2. Tenant default private model (`is_default_private_model = true`)
3. Highest priority private model (`private_model_priority DESC`)

**Configuration via Admin UI**:
- Navigate to Proxy Model Management → Select model → Safety Settings
- Set `is_data_safe = true` for on-premise/private models
- Optionally set as default or configure priority

### Application-Level Policies

**Table**: `application_data_leakage_policy`

**Configuration per application**:
- `high_risk_action`: block | switch_private_model | anonymize | pass
- `medium_risk_action`: block | switch_private_model | anonymize | pass
- `low_risk_action`: block | switch_private_model | anonymize | pass
- `private_model_id`: Override private model for this app (nullable)
- `enable_format_detection`: Enable/disable format detection
- `enable_smart_segmentation`: Enable/disable smart segmentation

**Default Strategy**:
- High Risk → `block`
- Medium Risk → `anonymize`
- Low Risk → `anonymize`

### Performance Characteristics

- **Format Detection**: ~5-10ms overhead
- **Smart Segmentation**: ~10-20ms overhead
- **Parallel Processing Gain**: 20-60% faster for large content (> 1KB)
- **Net Impact**: Faster overall for medium/large content

**See**: docs/DATA_LEAKAGE_GUIDE.md (comprehensive user guide)

---

## Key Environment Variables

**Database**: `DATABASE_URL`, `RESET_DATABASE_ON_STARTUP` (dev only)
**Auth**: `JWT_SECRET_KEY`, `SUPER_ADMIN_USERNAME/PASSWORD`
**Models**: `GUARDRAILS_MODEL_API_URL`, `EMBEDDING_API_BASE_URL`
**Services**: `{ADMIN,DETECTION,PROXY}_{PORT,UVICORN_WORKERS}`
**Other**: `CORS_ORIGINS`, `DEBUG`, `LOG_LEVEL`, `DATA_DIR`

## API Authentication

1. **API Key**: `Authorization: Bearer sk-xxai-{key}` (Detection/Proxy)
2. **JWT Token**: `Authorization: Bearer {jwt}` (Admin)
3. **Admin Switch**: `X-Switch-User: {user_id}`

## Key API Endpoints

### Detection (5001)
- `POST /v1/guardrails` - Main detection API
  - **Note**: `extra_body` is SDK-only (OpenAI Python SDK unfolds it)
  - HTTP/curl: flatten params to top level (no `extra_body`)
- `POST /v1/guardrails/input` - Dify input moderation
- `POST /v1/guardrails/output` - Dify output moderation

### Proxy (5002)
- `POST /v1/chat/completions` - OpenAI-compatible endpoint

### Admin (5000)
- `/api/v1/auth/{login,register}` - Authentication
- `/api/v1/config/{blacklist,whitelist,templates,ban-policy}` - Config
- `/api/v1/config/data-leakage-policy` - Data leakage disposal policy (per-app)
- `/api/v1/config/private-models` - List available private models
- `/api/v1/risk-config` - Risk types
- `/api/v1/proxy/{keys,models}` - Proxy management (includes safety attributes)
- `/api/v1/dashboard/stats` - Statistics
- `/api/v1/results` - Detection results

## Detection Flow

1. Check ban status (IP/user_id)
2. Whitelist check (early pass)
3. Blacklist check (early reject)
4. Model detection (security/compliance/data risks)
5. Aggregate risks (highest wins)
6. Determine action (pass/reject/replace)
7. Get response (knowledge base or templates)
8. Log to DB (async)

**Proxy mode**: Run detection on input → forward if pass → run detection on output → return if pass

## Deployment

### Quick Start
```bash
# Production (pre-built images)
curl -O https://raw.githubusercontent.com/openguardrails/openguardrails/main/docker-compose.prod.yml
export HF_TOKEN=your-hf-token
docker compose -f docker-compose.prod.yml up -d

# Development (build from source)
git clone https://github.com/openguardrails/openguardrails
cd openguardrails
export HF_TOKEN=your-hf-token
docker compose up -d --build
```

**Access**: http://localhost:3000/platform/ (admin@yourdomain.com / CHANGE-THIS-PASSWORD-IN-PRODUCTION)

### Automatic Migrations

**All migrations run automatically on `docker compose up -d`**

**Flow**:
1. PostgreSQL starts (healthcheck)
2. Admin service → entrypoint.sh → wait for PG → run migrations (with lock) → start service
3. Detection/Proxy → entrypoint.sh → wait for PG → skip migrations → start service

**Key Points**:
- ✅ Migrations run at CONTAINER level (once), NOT worker level
- ✅ Admin runs migrations BEFORE uvicorn starts (before workers fork)
- ✅ Detection/Proxy skip migrations (SERVICE_NAME != admin)
- ✅ PostgreSQL advisory locks prevent concurrent execution
- ✅ 58 total workers, but migrations execute ONLY ONCE

**Monitor**: `docker logs -f openguardrails-admin | grep -i migration`

**Check history**:
```bash
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT version, description, executed_at, success FROM schema_migrations ORDER BY version;"
```

**See**: backend/migrations/README.md, docs/MIGRATION_FAQ.md

## Common Workflows

### Add New API Endpoint
1. Create route in `backend/routers/`
2. Add service logic in `backend/services/`
3. Update Pydantic models in `backend/models/`
4. Add frontend service in `frontend/src/services/`
5. Create/update page component
6. ⚠️ TEST: `docker compose down -v && docker compose up -d`

### Add Database Migration
```bash
cd backend/migrations
./create_migration.sh description_of_change
# Edit versions/XXX_description_of_change.sql (use idempotent SQL)
docker compose down -v && docker compose up -d
docker logs openguardrails-admin | grep -i migration
git add backend/migrations/versions/XXX_description_of_change.sql
git commit -m "Add migration: description of change"
```

**NEVER**: Manually modify schema, require manual SQL, edit existing migrations
**ALWAYS**: Use migrations, test from clean state, use idempotent SQL (IF EXISTS)

### Troubleshooting

**Deployment fails**:
1. Check PostgreSQL: `docker logs openguardrails-postgres`
2. Check migrations: `docker logs openguardrails-admin | grep -i migration`
3. Check health: `docker ps`
4. Reset: `docker compose down -v && docker system prune -f && docker compose up -d`

**Common issues**:
- PostgreSQL not ready → healthcheck in docker-compose.yml
- Migration failed → SQL syntax error
- Port conflicts → check 3000,5000,5001,5002,54321 available

## FAQs

**Q: Won't migrations run multiple times with 58 workers?**
A: NO. Migrations run at container level (once), before uvicorn forks workers. Only admin runs migrations; detection/proxy skip.

**Q: Can I use RESET_DATABASE_ON_STARTUP?**
A: NO. Deprecated. Use migrations (no data loss).

**Q: Do I need to run migrations manually?**
A: NO. Automatic on `docker compose up -d`.

**Q: Can I change worker count?**
A: YES. Safe. Migrations unaffected (run once per container, not per worker).

## Dependencies

**Backend**: FastAPI, SQLAlchemy, Pydantic, Uvicorn, PostgreSQL, OpenAI SDK, Pillow, PyJWT
**Frontend**: React 18, Ant Design, React Router, i18next, Axios, Vite

## Caching & Performance

- Auth cache (1h TTL)
- Keyword cache (5m TTL)
- Risk config cache (5m TTL)
- Template cache (5m TTL)
- Rate limiting (per-tenant, global concurrent limits)

## Security

- bcrypt password hashing
- JWT expiration
- Secure API key generation
- SQLAlchemy ORM (SQL injection protection)
- CORS configured
- Rate limiting
- Multi-tenant isolation

---

**Last Updated**: 2026-01-06
**Generated for**: AI assistants to quickly understand OpenGuardrails architecture.
