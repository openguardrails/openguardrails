# Changelog

This file documents all notable changes to the **OpenGuardrails Platform**.

All notable changes to OpenGuardrails platform are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [6.8.0] - 2026-03-07

### Unified Plugin Architecture — Embedded Gateway & Dashboard

OpenGuardrails 6.8.0 consolidates the architecture into a single MoltGuard plugin that runs everything locally. The standalone CLI has been removed — AI Security Gateway and Dashboard now run **embedded** in the plugin process.

---

### Architecture Changes

#### Removed

- **CLI Package** (`cli/`) — Removed entirely. Dashboard and Gateway are now embedded in MoltGuard.
- **Standalone `openguardrails` npm package** — No longer needed. Install MoltGuard directly via ClawHub.

#### Changed

- **AI Security Gateway** — Now runs embedded in the MoltGuard plugin process (port 53669). No separate process management needed.
- **Dashboard** — Now runs embedded in the MoltGuard plugin process (ports 53667/53668). Auto-starts when plugin loads.
- **Gateway Port** — Changed from 8900 to 53669 for consistency with other OpenGuardrails ports.
- **Gateway Config Location** — Moved from `~/.openguardrails/gateway.json` to `~/.openclaw/extensions/moltguard/data/gateway.json`.

---

### AI Security Gateway (`gateway/`)

#### Added

- **Activity Monitoring** — Real-time tracking of sanitization events with `addActivityListener()` API. Events include redaction counts, categories, and timing.
- **Per-Request Mapping Store** — `mapping-store.ts` for tracking placeholder-to-original mappings across streaming responses.
- **Embedded Mode** — `startGateway(configPath, embedded=true)` for in-process use without process exit on errors.
- **Backend URL Routing** — Support for `/backend/{name}/chat/completions` URL pattern to route to specific backends.
- **Path Prefix Routing** — Backend config supports `pathPrefix` for matching requests by URL path.

#### Changed

- **Placeholder Format** — Updated to `__PII_{TYPE}_{ID}__` format (e.g., `__PII_SECRET_00000001__`, `__PII_EMAIL_ADDRESS_00000002__`).
- **Config Structure** — Simplified backend configuration with auto-type inference from baseUrl.

---

### MoltGuard Plugin (`moltguard/`)

#### Added

- **`/og_sanitize` Command** — Enable/disable AI Security Gateway with `on`/`off` arguments.
- **`/og_scan` Command** — Scan workspace files for security risks (skills, plugins, memories, workspace md files). Results viewable in Dashboard.
- **`/og_autoscan` Command** — Enable/disable automatic file scanning on workspace changes. Results viewable in Dashboard.
- **Workspace Scanner** — `workspace-scanner.ts` for scanning all OpenClaw workspace files.
- **File Watcher** — `file-watcher.ts` for monitoring file changes and triggering auto-scans.
- **Gateway Activity Reporting** — Sanitization events are reported to the embedded Dashboard.

#### Changed

- **Gateway Management** — `gateway-manager.ts` rewritten to manage embedded gateway (no subprocess spawning).
- **Dashboard Auto-Start** — Dashboard starts automatically when plugin loads (no manual `/og_dashboard` needed for basic use).

---

### Dashboard (`dashboard/`)

#### Added

- **Gateway Activity Page** — New `/gateway` page showing sanitization activity, redaction counts by category, and real-time event log.
- **Gateway Activity API** — `POST /api/gateway/activity` endpoint for receiving activity events from embedded gateway.
- **Gateway Activity Schema** — New `gateway_activity` table for storing sanitization events.

---

### Documentation

- **Updated `gateway/CLAUDE.md`** — Comprehensive documentation of embedded gateway architecture, activity monitoring, and programmatic API.
- **Updated `docs/architecture.md`** — Reflects unified plugin architecture without CLI.
- **Updated `README.md`** — Simplified installation and usage instructions.

---

### Migration Guide

#### From 6.7.x to 6.8.0

1. **Uninstall CLI** (if installed):
   ```bash
   npm uninstall -g openguardrails
   ```

2. **Update MoltGuard plugin**:
   ```bash
   openclaw plugins update moltguard
   openclaw gateway restart
   ```

3. **Gateway config migration** (automatic):
   - Old config at `~/.openguardrails/gateway.json` is still read as fallback
   - New config location: `~/.openclaw/extensions/moltguard/data/gateway.json`

4. **Port change**:
   - If you have firewall rules for port 8900, update them to 53669

---

## [6.5.0] - 2026-02-21

### Rebuilt for OpenClaw — Guard Agent for AI Agents

OpenGuardrails 6.5.0 is a ground-up rewrite. The platform shifts from an HTTP proxy-based guardrails service to a **Guard Agent** architecture purpose-built for [OpenClaw](https://openclaw.ai) AI agents. It now operates as three independent modules — **Dashboard**, **OpenClaw Plugin**, and **AI Security Gateway** — each deployable standalone or together.

---

### Dashboard (`dashboard/`)

Management dashboard for AI agent security monitoring. pnpm + Turborepo monorepo (Next.js 14 frontend + Express API).

#### Added

- **Agent Discovery** — Automatically scans the local OpenClaw workspace to find, catalog, and profile all running AI agents. Each agent profile includes personality (SOUL.md), skills, plugins, scheduled tasks, and model provider.
- **Identity Graph** — Network visualization mapping owner → agent → third-party system → tool connections. Shows which agents can access GitHub, Slack, AWS, Gmail, Docker, and 20+ other systems.
- **Permission Monitoring** — Tracks every tool invocation across all agents. Records tool name, category, access pattern (read/write/admin), call count, error rate, and first-seen timestamp. First-seen tools are flagged as potential anomalies.
- **Risk Assessment** — Highlights first-seen tools and unusual permission patterns. Risk levels (High/Medium/Low) based on access type (admin/write/read).
- **Tool Call Observations** — Bulk observation recording from plugins. Stores params, result, duration, blocked flag, and block reason for each tool call.
- **Detection Proxy** — `POST /api/detect` validates auth, loads scanner config (10 scanners: S01–S10), calls Core for detection, evaluates policies (block/alert/log), and records results.
- **Policy Engine** — Configurable policies mapping scanner results to actions (block/alert/log) with sensitivity thresholds.
- **Session Auth** — Email + API key login. Validates against Core, issues local sessions (30-day TTL). Supports auto-login via URL parameters from email verification flow.
- **CLI** (`@openguardrails/cli`) — `openguardrails init`, `start`, `stop`, `status`, `token` commands for one-command setup and management.
- **Multi-dialect Database** — Drizzle ORM with SQLite (default), PostgreSQL, and MySQL support.
- **Subscription Tiers** — 5-tier system (free/starter/pro/business/enterprise) with feature gating: Discovery + Detection (all tiers), Protection (business+), Governance (enterprise).

---

### MoltGuard OpenClaw Plugin (`moltguard/`)

Security guard plugin for OpenClaw agents. Hooks into the agent lifecycle to detect and block threats in real time.

#### Added

- **Behavioral Anomaly Detection** — Tracks tool chain history per session (up to 50 entries across 200 concurrent sessions). Routes high-risk tool calls to the Core API for classification. Detects data exfiltration (sensitive file read → network send), multi-credential access, shell execution after web fetch, and intent-action mismatch.
- **Content Injection Scanner** — Pure regex-based local scanner with 30+ patterns across 8 categories: instruction override, fake system messages, concealment directives, command execution, data exfiltration, mode switching, task hijacking, and role assumption. High-confidence matches trigger immediate redaction; medium-confidence requires 2+ distinct categories.
- **Automatic Redaction** — Injection patterns in tool results are replaced with `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_{RISK_TYPE}__` markers before the LLM sees the content. Risk types: PROMPT_INJECTION, DATA_EXFILTRATION, COMMAND_EXECUTION.
- **LLM Security Context Injection** — On `before_agent_start`, injects OpenGuardrails awareness context so the LLM knows about protection and can recognize redaction markers or raw injection attempts.
- **Shell Escape Detection** — Catches backtick substitution, `$()`, command chaining (`;`, `&&`, `||`), pipe injection, and newline injection in tool parameters. Blocked locally with zero cloud round-trip.
- **Sensitive File Tracking** — Recognizes reads of SSH keys, AWS credentials, GPG keys, .env files, crypto certificates, system auth files, browser cookies, and keychains. Flags subsequent network calls as potential exfiltration.
- **Zero-Config Registration** — `/og_activate` command triggers registration with Core. Returns claim URL and verification code. After email verification, behavioral detection activates automatically (polled every 60s). No restart required.
- **Fail-Open Design** — If the Core API is unreachable or times out (3s cap), tool calls are allowed. No false positives from network issues.
- **Dashboard Reporting** — Reports tool call observations to the Dashboard API. Supports heartbeat (60s interval), agent registration, and permission analytics.
- **Embedded Process Management** — `DashboardManager` and `GatewayManager` can spawn and manage embedded Dashboard API and AI Security Gateway processes as detached subprocesses with health checks, log files, and state persistence.
- **Test Email on Activation** — After email verification, sends a test email containing a realistic prompt injection sample so users can immediately test detection by asking their agent to read it.

---

### AI Security Gateway (`gateway/`)

Local HTTP proxy that sanitizes sensitive data before sending to LLM providers. Zero npm dependencies.

#### Added

- **Multi-Provider Support** — Transparent proxy for Anthropic Messages API, OpenAI Chat Completions API, Gemini generateContent API, and OpenAI-compatible providers (Kimi/Moonshot, DeepSeek).
- **Lossless Sanitization** — Detects and replaces sensitive data with numbered placeholders (`__email_1__`, `__credit_card_2__`, etc.). Mapping table tracks all substitutions. Responses are restored with original values before reaching the client.
- **Data Types** — URLs, email addresses, phone numbers (US/international/CN), IP addresses, credit cards, bank cards (16–19 digit), IBAN, SSN, API keys (sk-, pk-, ghp_, AKIA, xox, SG., hf_, etc.), Bearer tokens, and high-entropy tokens (Shannon entropy >= 4.0).
- **Streaming Support** — Handles SSE (Server-Sent Events) streaming responses. Processes line-by-line with incomplete buffer handling and restores placeholders in each chunk.
- **Recursive Sanitization** — Handles nested objects, arrays, and complex message structures (Anthropic content blocks, OpenAI multi-turn conversations, Gemini parts).
- **Zero Dependencies** — Built entirely on Node.js built-ins. No external npm packages in production.
- **Local-Only** — Binds to `127.0.0.1`. Sensitive data never leaves the machine unsanitized. Placeholder-to-original mappings are ephemeral and discarded after each request.
- **Configuration** — `~/.openguardrails/gateway.json` or environment variables (`GATEWAY_PORT`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`).

---

### Breaking Changes

- **Architecture**: Complete rewrite from HTTP proxy guardrails to OpenClaw plugin-based guard agent.
- **Domains**: Production URLs changed to `https://www.openguardrails.com/core` (Core API) and `https://www.openguardrails.com/dashboard` (Dashboard).
- **Scanners**: Moved from standalone API to Core + Dashboard architecture. Scanner config (S01–S10) now managed in Dashboard database.
- **Authentication**: API key format unchanged (`sk-og-<32 hex>`), but auth flow now requires email verification for activation.

---

## [5.1.2] - 2026-01-09

### 🛡️ Self-Service False Positive Appeal System

This release introduces a comprehensive **Self-Service False Positive Appeal System** that enables end users to appeal when they believe their requests have been incorrectly flagged as high-risk content. The system supports both AI-powered auto-review and manual human review workflows, significantly reducing false positive impact on legitimate user workflows.

#### 🎯 What's New

**Problem Solved**: Online guardrails systems inevitably produce false positives, which can disrupt legitimate user workflows. Traditional approaches require platform administrators to manually review these cases, creating bottlenecks and poor user experience.

**Solution**: A self-service appeal system that:
- ✅ **User-Friendly**: End users can easily submit appeals with a clicking an appeal link
- ✅ **AI-Powered Review**: Automatic AI review for quick resolution of genuine false positives
- ✅ **Human Fallback**: Manual review capabilities for complex or ambiguous cases
- ✅ **Flexible Configuration**: Per-application appeal settings with custom messages
- ✅ **Complete Audit Trail**: Full history of appeals, reviews, and decisions

#### Added

##### 🔔 **Appeal Configuration Management**

**Per-Application Configuration**:
- `enabled`: Enable/disable appeal feature per application
- `message_template`: Custom appeal message with `{appeal_url}` placeholder
- `appeal_base_url`: Base URL for appeal links (public-facing domain)
- `final_reviewer_email`: Email for human review notifications when AI rejects appeal

**Appeal Flow**:
```
1. User request blocked by guardrails
2. System returns response with appeal URL link
3. User clicks link → Opens self-service appeal page
4. User submits appeal with optional reason
5. AI auto-reviews appeal → Approve/Reject
6. If AI unsure → Escalate to human reviewer
7. Human approves/rejects → User notified
8. Auto-lift ban if appeal approved (for banned users)
```

##### 🤖 **AI-Powered Appeal Review**

The system uses AI to automatically evaluate appeal requests:

**AI Review Process**:
- Analyzes original content against risk categories
- Evaluates user-provided reason for appeal
- Makes approve/reject decision with confidence score
- Provides detailed explanation for decision

**Review Outcomes**:
- `approved`: Appeal accepted, ban lifted or content allowed
- `rejected`: Appeal denied, original decision upheld
- `pending_review`: AI uncertain, escalate to human reviewer

**Statistics Tracking**:
- AI approval rate: Track how often AI approves appeals
- Review accuracy: Validate AI decisions against human reviews
- Processing time: Measure AI review performance

##### 👤 **User-Friendly Appeal Interface**

**End-User Appeal Page** (`/appeal/{request_id}`):
- Display original blocked content and risk level
- Show matched risk categories
- Provide appeal reason input (optional)
- Submit appeal with one click
- View appeal status in real-time

**Appeal Status Flow**:
1. `pending` → Initial state, awaiting review
2. `reviewing` → AI is currently reviewing
3. `pending_review` → Escalated to human reviewer
4. `approved` → Appeal accepted
5. `rejected` → Appeal denied

##### 📊 **Admin Appeal Management**

**Appeal Management Dashboard** (`/platform/config/appeal`):
- View all appeals for current application
- Filter by status (pending, reviewing, pending_review, approved, rejected)
- Paginated list with detailed information
- Manual review capabilities for human reviewers
- Export appeals to Excel for compliance auditing

**Manual Review Actions**:
- **Approve Appeal**: Override AI decision, approve the appeal
- **Reject Appeal**: Confirm AI decision, reject the appeal
- **Add Reason**: Record rationale for manual review decisions

##### 🗂️ **Database Schema**

**New Table: `appeal_config`**
- Stores per-application appeal configuration
- `id`, `application_id`, `tenant_id`
- `enabled`, `message_template`, `appeal_base_url`, `final_reviewer_email`
- `created_at`, `updated_at`

**New Table: `appeal_records`**
- Stores all appeal submissions and reviews
- `id`, `request_id`, `application_id`, `tenant_id`, `user_id`
- `original_content`, `original_risk_level`, `original_categories`
- `status`, `ai_approved`, `ai_review_result`
- `ai_reviewed_at`, `processed_at`
- `processor_type`, `processor_id`, `processor_reason`
- `created_at`

##### 🌐 **New API Endpoints**

**Appeal Configuration** (Admin API - Port 5000):
```bash
GET  /api/v1/config/appeal              # Get appeal config
PUT  /api/v1/config/appeal              # Update appeal config
```

**Appeal Records** (Admin API - Port 5000):
```bash
GET  /api/v1/config/appeal/records      # List appeal records (paginated)
POST /api/v1/config/appeal/records/{id}/review  # Manual review
GET  /api/v1/config/appeal/records/export  # Export to Excel
```

**Appeal Submission** (Detection API - Port 5001):
```bash
GET  /v1/appeal/{request_id}            # Get appeal details (public link)
POST /v1/appeal/{request_id}            # Submit appeal
GET  /v1/appeal/{request_id}/status     # Check appeal status (polling)
```

##### 🔄 **Integration with Existing Systems**

**Detection Service Integration**:
- When request is blocked, check if appeal is enabled for application
- If enabled, generate appeal URL and include in response
- Store appeal request ID in detection results

**Ban Policy Integration**:
- If appeal is approved, auto-lift ban (if user was banned)
- Update banned users table with appeal resolution status
- Revoke pending ban timers for appealed users

**Proxy Service Integration**:
- Pass appeal URL through proxy responses
- Maintain consistent appeal experience across API and Gateway modes

##### 🌍 **Internationalization**

**Added Translations**:
- Complete English and Chinese translations for appeal system
- Appeal status messages (pending, reviewing, approved, rejected)
- UI labels and help text
- Error messages and notifications

#### Changed

##### 📝 **Detection Response Format**

**Enhanced Response with Appeal Link**:
```json
{
  "is_blocked": true,
  "risk_level": "high",
  "categories": ["S5", "S9"],
  "suggest_answer": "...",
  "appeal_url": "https://your-domain.com/appeal/{request_id}",
  "appeal_message": ""
}
```

**Backward Compatible**: Fields only added when appeal is enabled for application.

##### 🤖 **AI Model Integration**

Appeal review uses the existing OpenGuardrails-Text model for intelligent content analysis:
- Leverages same risk categories (S1-S21) as detection
- Consistent risk assessment across detection and appeal
- No additional infrastructure required

#### Documentation

**New UI Pages**:
- `/platform/config/appeal` - Admin appeal management dashboard
- `/appeal/{request_id}` - Public self-service appeal page

**Updated Backend Services**:
- `backend/services/appeal_service.py` - Appeal business logic
- `backend/routers/appeal_api.py` - Admin appeal configuration API
- `backend/routers/appeal_router.py` - Detection API appeal routes

**Frontend Components**:
- `frontend/src/pages/AccessControl/FalsePositiveAppeal.tsx` - Public appeal page
- `frontend/src/pages/AccessControl/AppealManagement.tsx` - Admin dashboard
- Updated API service with appeal endpoints
- Updated i18n files (en.json, zh.json)

#### Usage Example

**End-User Appeal Flow**:

1. User sends request that gets blocked:
```python
client.check_prompt("Normal business inquiry that was falsely flagged")
# Response: is_blocked=True with appeal_url
```

2. User receives response with appeal link:
```
您的请求被拦截，原因：高风险内容
申诉链接: https://your-domain.com/appeal/550e8400-e29b-41d4-a716-446655440000
```

3. User clicks link, sees appeal page, submits appeal
4. System auto-reviews using AI, approves appeal
5. User retry the original request - now allowed

**Admin Manual Review**:

```python
import requests

# View pending appeals
response = requests.get(
    "http://localhost:5000/api/v1/config/appeal/records?status=pending_review",
    headers={"Authorization": "Bearer your-jwt-token"}
)

# Manually approve appeal
requests.post(
    f"http://localhost:5000/api/v1/config/appeal/records/{appeal_id}/review",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "action": "approve",
        "reason": "Reviewed content manually - legitimate business use case"
    }
)
```

#### Configuration

**Enable Appeal for Application**:

```bash
# Update appeal config
curl -X PUT "http://localhost:5000/api/v1/config/appeal" \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "message_template": "If you think this is a false positive, please click the following link to appeal: {appeal_url}",
    "appeal_base_url": "https://your-public-domain.com",
    "final_reviewer_email": "reviewer@yourcompany.com"
  }'
```

**Environment Variables**:
No new environment variables required. Appeal configuration is per-application via Admin UI.

#### Security & Privacy

- **Public appeal pages require request ID**: Only users who received a blocked response can appeal
- **No user authentication required**: Encourages users to submit appeals without friction
- **Limited information exposure**: Appeal page shows only blocked content, not user-identifiable data
- **Permission controls**: Manual review APIs require Admin authentication
- **Audit trail**: All appeals and reviews permanently logged for compliance

#### Performance

- **Appeal submission**: < 100ms overhead on existing detection flow
- **AI review**: Typically < 500ms (uses existing OpenGuardrails-Text model)
- **Database queries**: Indexed on request_id for fast lookups
- **No impact on detection**: Appeal system only activated when request is blocked

#### Future Enhancements

Potential improvements in future releases:
- Email notifications for appeal status updates
- Appeal statistics and trends dashboard
- Bulk appeal approval/rejection tools
- Custom AI review prompts per application
- Appeal rate limiting (prevent abuse)
- Multi-tenant appeal review visibility

---

## [5.1.0] - 2026-01-06

### 🚀 Major Update: Automatic Private Model Switching for Enterprise Data Protection

This release introduces **Automatic Private Model Switching** — a major enhancement to the Data Leakage Prevention (DLP) system that enables enterprise AI agents to seamlessly protect sensitive data **without affecting user experience**.

#### 🎯 Key Value Proposition

**Problem Solved**: Enterprise AI applications often face a dilemma between data security and user experience. Blocking requests with sensitive data disrupts workflows, while allowing them risks data leakage to external AI providers.

**Solution**: Automatic Private Model Switching intelligently routes requests containing sensitive data to private/on-premise models, ensuring:
- ✅ **Zero User Disruption**: Users continue their workflow seamlessly
- ✅ **Complete Data Protection**: Sensitive data never leaves your infrastructure
- ✅ **Transparent Operation**: Switching happens automatically without user intervention
- ✅ **Flexible Policies**: Configure different actions for different risk levels

#### 🆕 What's New

##### 🔄 **Automatic Private Model Switching**

When sensitive data is detected, the system can automatically redirect requests to a designated private model instead of blocking or anonymizing:

**How It Works**:
```
1. User sends request to AI agent
2. DLP system detects sensitive entities (PII, financial data, etc.)
3. Based on configured risk level action:
   - High Risk → Block (default) or Switch to Private Model
   - Medium Risk → Switch to Private Model (default)
   - Low Risk → Anonymize (default) or Pass
4. If action is "switch_private_model":
   - Request is transparently routed to configured private model
   - User receives response normally, unaware of the switch
   - Sensitive data stays within your infrastructure
```

**Enterprise Benefits**:
- **For AI Agents**: Uninterrupted operation with automatic data protection
- **For Users**: Seamless experience without security interruptions
- **For Security Teams**: Complete audit trail and policy compliance
- **For Compliance**: Data residency requirements automatically enforced

##### 🏗️ **Private Model Configuration**

**Model Safety Attributes** (enhanced in `upstream_api_config`):
- `is_data_safe`: Mark model as safe for processing sensitive data
- `is_default_private_model`: Set as tenant-wide default private model
- `private_model_priority`: Priority ranking (0-100) for private model selection

**Selection Priority Logic**:
1. **Application-Specific**: `private_model_id` in application policy (highest priority)
2. **Tenant Default**: Model with `is_default_private_model = true`
3. **Priority-Based**: Model with highest `private_model_priority` value

##### 📊 **Enhanced Policy Configuration**

**Per-Application Data Leakage Policies**:
```python
# Example: Configure different actions for different risk levels
{
    "application_id": "your-app-id",
    "input_high_risk_action": "block",              # Block high-risk content
    "input_medium_risk_action": "switch_private_model",  # Auto-switch for medium risk
    "input_low_risk_action": "anonymize",           # Anonymize low-risk content
    "output_high_risk_action": "block",
    "output_medium_risk_action": "switch_private_model",
    "output_low_risk_action": "pass",
    "private_model_id": "uuid-of-preferred-private-model"  # Optional override
}
```

**Four Disposal Actions**:

| Action | Description | Use Case |
|--------|-------------|----------|
| `block` | Reject request completely | Critical security violations |
| `switch_private_model` | Route to private/on-prem model | **Enterprise data protection (NEW)** |
| `anonymize` | Replace entities with placeholders | Logging/analytics with masked data |
| `pass` | Allow request, log only | Audit mode, low-risk scenarios |

##### 🌐 **New API Endpoints**

```bash
# Private Model Management
GET  /api/v1/config/private-models              # List available private models
PUT  /api/v1/proxy/models/{id}/safety           # Update model safety attributes

# Application DLP Policy (enhanced)
GET  /api/v1/config/data-leakage-policy         # Get policy with new action fields
PUT  /api/v1/config/data-leakage-policy         # Update policy with private model config
```

#### 🔧 Technical Implementation

**Backend Services Updated**:
- `backend/services/data_leakage_disposal_service.py` - Enhanced with private model switching logic
- `backend/services/proxy_service.py` - Integrated automatic model switching in proxy flow
- `backend/services/data_security_service.py` - Improved entity detection and risk aggregation

**Database Changes**:
- Migration `045_remove_deprecated_block_on_risk_columns.sql` - Schema cleanup for new action system

**Detection Flow Enhancement**:
```
Request → Format Detection → Segmentation → Entity Detection → Risk Aggregation
                                                                      ↓
                                                              Policy Lookup
                                                                      ↓
                                            ┌─────────────────────────┴─────────────────────────┐
                                            ↓                         ↓                         ↓
                                         Block                 Switch Model               Anonymize/Pass
                                            ↓                         ↓                         ↓
                                      Return Error           Route to Private         Process & Continue
                                                                  Model
```

#### 📈 Performance Characteristics

- **Model Switch Latency**: < 5ms overhead for routing decision
- **Transparent Switching**: No additional latency visible to end users
- **Parallel Processing**: Entity detection continues to benefit from smart segmentation

#### 🔒 Security & Compliance

- **Data Residency**: Sensitive data automatically stays within designated infrastructure
- **Audit Trail**: All model switches logged for compliance review
- **Policy Enforcement**: Configurable per-application, per-risk-level granularity
- **Zero Trust**: Private models can be air-gapped or on-premise deployments

#### 📚 Documentation

- Updated `docs/DATA_LEAKAGE_GUIDE.md` with private model switching guide
- Enhanced `CLAUDE.md` with v5.1.0 architecture details
- Added private model configuration examples

#### ⬆️ Migration Guide

```bash
# Automatic migration on startup
docker compose down && docker compose up -d

# Verify private model configuration
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT name, is_data_safe, is_default_private_model, private_model_priority FROM upstream_api_config;"

# Check application policies
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT application_id, input_medium_risk_action, private_model_id FROM application_data_leakage_policy;"
```

**For Existing Users**:
- Existing policies are preserved with default action mappings
- Configure private models via Admin UI → Proxy Model Management → Safety Settings
- Set `is_data_safe = true` for your on-premise/private models

---

## [5.0.8] - 2026-01-05

### 🛡️ Enterprise Data Leakage Prevention System

This release introduces a comprehensive **Data Leakage Prevention (DLP) System** with intelligent content processing, multi-layer protection, and flexible disposal strategies for enterprise data security.

#### 🎯 What's New

**Core DLP Architecture:**
- **Format Detection**: Automatic content format recognition (JSON, YAML, CSV, Markdown, Plain Text)
- **Smart Segmentation**: Context-aware splitting for structured content with entity preservation
- **Multi-Layer Detection**: Parallel regex and GenAI entity recognition across segments
- **Intelligent Disposal**: Four disposal strategies with application-level policies

#### Added

##### 📋 **Application-Level DLP Policies**

**Per-Application Configuration:**
- `high_risk_action`: block | switch_private_model | anonymize | pass
- `medium_risk_action`: block | switch_private_model | anonymize | pass
- `low_risk_action`: block | switch_private_model | anonymize | pass
- `private_model_id`: Override private model for this application
- `enable_format_detection`: Enable/disable format detection
- `enable_smart_segmentation`: Enable/disable smart segmentation

**Default Strategy:**
- High Risk → `block` (reject request completely)
- Medium Risk → `switch_private_model` (redirect to private model)
- Low Risk → `anonymize` (replace sensitive entities with placeholders)

##### 🔒 **Private Model System**

**Model Safety Attributes** (in `upstream_api_config` table):
- `is_data_safe`: Marks model as safe for sensitive data (on-premise, private cloud, air-gapped)
- `is_default_private_model`: Tenant-wide default private model
- `private_model_priority`: Priority ranking (0-100, higher = preferred)

**Selection Priority:**
1. Application policy `private_model_id` (explicit configuration)
2. Tenant default private model (`is_default_private_model = true`)
3. Highest priority private model (`private_model_priority DESC`)

##### 🔍 **Format Detection Service**

**Auto-Detected Formats:**
- **JSON**: Structured object arrays, max 50 segments
- **YAML**: Top-level key separation, max 50 segments
- **CSV**: Row-based splitting with header retention, max 100 rows
- **Markdown**: Section-based (`##`) splitting, max 30 sections
- **Plain Text**: Single segment (no segmentation)

**Performance:** ~5-10ms overhead with format-aware processing

##### ✂️ **Smart Segmentation Service**

**Format-Aware Splitting:**
- **JSON**: Splits by top-level objects, preserves array structure
- **YAML**: Splits by top-level keys, maintains document structure
- **CSV**: Splits by rows with header retention for each segment
- **Markdown**: Splits by `##` section headers

**Benefits:** 20-60% faster processing for large content (> 1KB)

##### 🎯 **Data Security Service**

**Dual Detection Engine:**
- **Regex Entities**: Applied to full text (ID cards, credit cards, phone numbers, etc.)
- **GenAI Entities**: Applied per-segment with parallel processing

**Risk Aggregation:** Highest risk from all segments wins

##### 📊 **Data Leakage Disposal Service**

**Four Disposal Actions:**

| Action | Description | Default For |
|--------|-------------|-------------|
| `block` | Reject request completely | High Risk |
| `switch_private_model` | Redirect to data-private model | Medium Risk |
| `anonymize` | Replace entities with placeholders | Low Risk |
| `pass` | Allow request, log only | Audit Mode |

##### 🌐 **New API Endpoints**

```bash
# Application DLP Policy Management
GET    /api/v1/config/data-leakage-policy          # Get policy
POST   /api/v1/config/data-leakage-policy          # Create policy
PUT    /api/v1/config/data-leakage-policy          # Update policy
DELETE /api/v1/config/data-leakage-policy          # Delete policy

# Private Model Management
GET    /api/v1/config/private-models                  # List private models
```

#### Changed

##### 🔄 **Detection Flow Enhancement**

**Before (v5.0.7):**
- Single-pass regex detection on full text
- No format awareness
- Single disposal action

**After (v5.0.8):**
```
1. Format Detection (~5-10ms)
2. Smart Segmentation (format-aware)
3. Parallel Entity Detection (regex + GenAI)
4. Risk Aggregation (highest wins)
5. Policy-Based Disposal (application-scoped)
```

##### 🗄️ **Database Schema Updates**

**New Tables:**
- `application_data_leakage_policy` - Per-application DLP configuration

**Updated Tables:**
- `upstream_api_config` - Added safety attributes (`is_data_safe`, `is_default_private_model`, `private_model_priority`)

**Migration:** `038_data_leakage_refactor.sql`

##### ⚡ **Performance Optimizations**

| Scenario | Improvement |
|----------|-------------|
| Small content (< 1KB) | ~5-10ms overhead (format detection) |
| Large content (> 1KB) | 20-60% faster (parallel segment processing) |
| Structured data (JSON/YAML) | Better accuracy (segment-aware detection) |

#### Documentation

- Added `docs/DATA_LEAKAGE_GUIDE.md` - Comprehensive DLP user guide
- Updated `docs/API_REFERENCE.md` with new endpoints
- Added inline documentation for all DLP services

#### Technical Implementation

**Backend Services:**
- `backend/services/format_detection_service.py` - Format recognition
- `backend/services/segmentation_service.py` - Content splitting
- `backend/services/data_security_service.py` - Entity detection
- `backend/services/data_leakage_disposal_service.py` - Disposal actions

**API Routes:**
- `backend/routers/config_api.py` - Policy management endpoints

**Database:**
- Migration script: `backend/migrations/versions/038_data_leakage_refactor.sql`

#### Migration Guide

```bash
# Automatic migration runs on startup
docker compose down && docker compose up -d

# Verify migration
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT * FROM application_data_leakage_policy LIMIT 5;"
```

**Default Policies:** Automatically created for all existing applications with default disposal strategies (High→block, Medium→switch_private_model, Low→anonymize).

---

## [5.0.7] - 2025-12-31

### 🎨 Major UI Overhaul - Enterprise SaaS Design System

This release introduces a comprehensive enterprise-level UI design upgrade, transforming the platform from a consumer product visual style to a professional enterprise SaaS experience (Stripe/Linear/AWS style).

#### 🎯 What's New

**Enterprise Design Transformation:**
- Complete visual redesign aligned with enterprise SaaS standards
- Increased information density (+50%) for better data visibility
- Professional color system matching Stripe Dashboard quality
- Improved accessibility with WCAG AAA compliant contrast ratios

### Changed

#### 🎨 **Color System Overhaul**

**Primary Color:**
- Before: `#5788ff` (high-saturation blue, consumer style)
- After: `#0070f3` (professional blue, Stripe style)

**Text Colors:**
- Primary text: `#030333` → `#0f172a` (pure dark gray, higher contrast)
- Secondary text: `#64748b` → `#475569` (deeper, clearer)
- Links: unified with primary color `#0070f3`

**Border Colors:**
- Light border: `#e2e8f0` → `#cbd5e1` (better separation)

#### 🌈 **Gradient to Solid Color Migration**

**Removed All Gradients:**
- Primary buttons: `linear-gradient` → solid `#0070f3`
- Card backgrounds: Gradient → pure white
- Hover states: Gradient → solid dark shades

**Visual Impact:**
- Before: Colorful glowing shadows (iOS App style)
- After: Subtle gray shadows (Stripe Dashboard style)

#### 🔵 **Border Radius System**

**Standardized to Enterprise Standards:**
- Default: `8px` → `6px` (-25%)
- Cards: `12px` → `8px` (-25%)
- Large: `24px` → `8px` (-67%)
- Maximum: All elements limited to 8px enterprise standard

**Removal:**
- ❌ Completely removed `rounded-2xl` (24px) - too mobile-app-like
- ✅ Maximum 8px for professional enterprise feel

#### 🌫️ **Shadow System Refinement**

**Removed Colorful Shadows:**
- ❌ Removed `shadow-gradient` and colored glow effects
- ❌ Removed `0 10px 40px rgba(87,136,255,0.3)` blue glow

**Updated to Pure Gray:**
- Small: `0 1px 2px rgba(0,0,0,0.05)` ✓
- Default: `0 1px 3px rgba(0,0,0,0.1)` ✓
- Large: `0 25px 50px rgba(0,0,0,0.25)` ✓

#### 📏 **Typography & Font Size System**

**Reduced Font Sizes for Higher Density:**
- H1: `36px` → `30px` (-17%)
- H2: `30px` → `24px` (-20%)
- H3: `24px` → `20px` (-17%)
- Card titles: `18px` → `16px` (-11%)
- Body text: `16px` → `14px` (-13%, enterprise standard)
- Small: `14px` → `12px` (-14%)

#### 📐 **Spacing System Optimization**

**Tighter Layout for More Information:**
- Card padding: `24px` → `20px` (-17%)
- Button height: `40px` → `36px` (-10%)
- Input height: `40px` → `36px` (-10%)
- Block spacing: `24px` → `16px` (-33%)

**Information Density:**
- Same screen space displays ~50% more content
- Better suited for professional workloads

#### 🧩 **Component Updates**

**Button Component:**
```tsx
// Before (consumer style)
className="bg-gradient-primary text-white hover:shadow-gradient"

// After (enterprise style)
className="bg-primary-500 text-white hover:bg-primary-600 shadow-sm"
```

**Card Component:**
```tsx
// Before
className="bg-white shadow-md rounded-lg p-6"

// After
className="bg-white border border-border-light shadow-sm rounded-md p-5"
```

**Variants Removed:**
- ❌ `gradient` variant (gradient background)
- ✅ `elevated` variant (elevated shadow for modals)

**Input Component:**
- New: hover state (border darkening)
- Improved: focus ring visibility
- Better: disabled state styling

### Design Philosophy

**Before (Consumer Product):**
- Inspired by: Figma, Notion, Canva
- Characteristics: Visual richness, gradients, large rounded corners, generous whitespace
- User perception: "This looks like a beautiful app"

**After (Enterprise SaaS):**
- Inspired by: Stripe Dashboard, Linear, AWS Console
- Characteristics: Professional, restrained, high information density, clear hierarchy
- User perception: "This looks like a professional enterprise tool" ✓

### Performance Improvements

**CSS Bundle Size:**
- Removed: Gradient-related CSS (~2KB)
- Added: Border styles (~0.5KB)
- Net reduction: ~1.5KB ✓

**Rendering Performance:**
- Removed: Complex gradient rendering (GPU-intensive)
- Using: Solid color fill (CPU-optimized)
- Result: Button hover performance improved ~20% ✓

### Technical Implementation

**Updated Files:**

1. **Design Tokens** (`frontend/src/design-system/tokens/index.ts`)
   - Primary color updated
   - Text contrast improved
   - Border visibility enhanced
   - Corner radius standardized

2. **Tailwind Config** (`frontend/tailwind.config.js`)
   - Removed gradient background configurations
   - Applied new design tokens

3. **Global Styles** (`frontend/src/styles/tailwind.css`)
   - Updated font size hierarchy
   - Updated base component styles (`.input-base`, `.card`)
   - Removed gradient-related classes
   - Added enterprise table styles

4. **Core Components**
   - **Button**: Removed gradients, solid colors
   - **Card**: Added borders, removed gradient variant
   - **Input**: More compact, professional styling
   - **All components**: Unified 6-8px corner radius

### Migration Notes

**Breaking Changes:**
- `bg-gradient-primary` class no longer exists
- `shadow-gradient` class no longer exists
- `variant="gradient"` on Card component removed
- `rounded-2xl` usage discouraged (use `rounded-md`)

**Recommended Updates:**

For custom components using old styles:
```tsx
// ❌ Replace this
<button className="bg-gradient-primary">Save</button>
<Card variant="gradient">Content</Card>
<div className="rounded-2xl">...</div>

// ✅ With these
<Button variant="primary">Save</Button>
<Card variant="default">Content</Card>
<div className="rounded-md">...</div>
```

### Accessibility

**WCAG Compliance:**
- Text contrast ratios increased to AAA standards
- Focus indicators improved for keyboard navigation
- Color usage reduced (relying more on borders/shadows)
- Better low-vision support with sizing improvements

### Documentation

- Added `ENTERPRISE_DESIGN_GUIDE.md` - Comprehensive design system documentation
- Updated component examples in all page documentation
- Added migration checklist for custom components

---

## [4.5.0] - 2025-12-17

### 🔑 Major Feature: Direct Model Access

This release introduces **Direct Model Access**, a privacy-first feature that allows users to directly access backend models (OpenGuardrails-Text, bge-m3, etc.) without guardrails detection, ideal for private deployments and scenarios requiring maximum privacy.

#### 🎯 What's New

**Direct Model Access Benefits:**
- ✅ **Privacy Guarantee**: Message content is NEVER stored in database
- ✅ **Usage-Only Tracking**: Only request count and token usage are recorded for billing
- ✅ **Independent Authentication**: Uses dedicated Model API Key (separate from application keys)
- ✅ **OpenAI-Compatible**: Full OpenAI SDK compatibility for seamless integration
- ✅ **Streaming Support**: Both streaming and non-streaming responses
- ✅ **Usage Analytics**: Query detailed usage statistics by date range

### Added

#### 🔐 **Model API Key Management**

**New Database Schema:**
- `tenants.model_api_key` - Dedicated API key for direct model access (format: `sk-xxai-model-{49 chars}`)
- `model_usage` table - Privacy-preserving usage tracking (no content storage)

**New API Endpoints:**
- `GET /api/v1/users/me` - Now returns `model_api_key` field
- `POST /api/v1/users/regenerate-model-api-key` - Regenerate Model API Key

**Frontend Features:**
- Account page now displays Model API Key with copy and regenerate functionality
- Complete usage example code with auto-filled base_url and api_key
- Privacy protection notice explaining data handling
- One-click key regeneration with instant invalidation of old keys

#### 🚀 **Direct Model Access Endpoints**

**New Endpoints:**
- `POST /v1/model/chat/completions` - OpenAI-compatible chat completions (streaming & non-streaming)
- `GET /v1/model/usage` - Query usage statistics with date filters

**Supported Models:**
- `OpenGuardrails-Text` - Safety detection model
- `bge-m3` - Text embedding model

**Usage Example:**
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:5001/v1/model/",
    api_key="sk-xxai-model-YOUR_KEY"
)

response = client.chat.completions.create(
    model="OpenGuardrails-Text",
    messages=[{"role": "user", "content": "Hello"}]
)
```

#### 📊 **Privacy-Preserving Usage Tracking**

**What's Tracked:**
- Request count per model per day
- Input/output token counts
- Usage date (daily aggregation)

**What's NOT Tracked:**
- ❌ Message content (prompts and responses)
- ❌ IP addresses
- ❌ User-Agent strings
- ❌ Any personally identifiable information

### Fixed

- **Model API Key Length**: Fixed key generation to respect 64-character database limit
- **Streaming Response**: Fixed httpx AsyncClient lifecycle in streaming responses
- **Upstream Authentication**: Added missing Authorization header for backend model API calls
- **ORM Model**: Added `model_api_key` field to Tenant model
- **Super Admin Login Issue**: Fixed missing `Tenant` import in `scanner_config_service.py`

### Changed

- **Database Migration**: Auto-generates Model API Keys for all existing tenants
- **Frontend UI**: Enhanced Account page with Model API Key management section
- **Base URL**: Corrected Direct Model Access base_url from `/v1/` to `/v1/model/`

### Documentation

- Added comprehensive `docs/MODEL_API_KEY_MANAGEMENT.md` guide
- Updated `tests/DIRECT_MODEL_ACCESS_GUIDE.md` with complete examples
- Added usage examples for Python, cURL, and streaming scenarios

### Security

- **Key Format**: Model API Keys use cryptographically secure random generation (`secrets` module)
- **Unique Constraint**: Database-level uniqueness for all Model API Keys
- **Immediate Invalidation**: Old keys become invalid instantly upon regeneration
- **Isolated Permissions**: Model API Keys cannot access other platform APIs

---

## [4.3.5] - 2025-12-03

### 🚀 Deployment Mode Enhancement - Enterprise vs SaaS

This release introduces a comprehensive deployment mode system that clearly separates **Enterprise (Private Deployment)** and **SaaS (Cloud Service)** modes, ensuring local deployments have no subscription limitations while enabling full commercial features for SaaS providers.

#### 🎯 What's New

**Two Distinct Deployment Modes:**

**🏢 Enterprise Mode (Default for Local Deployment)**
- **No Subscription System**: All features available without limits
- **No Package Marketplace**: Built-in scanners only (no third-party purchases)
- **Full Functionality**: Complete access to all safety features and configurations
- **Privacy First**: No external dependencies or commercial restrictions
- **Ideal for**: Private deployments, on-premise installations, government/enterprise use

**☁️ SaaS Mode (For Commercial Providers)**
- **Subscription System**: Tiered pricing with quotas and limits
- **Package Marketplace**: Third-party scanner package sales and purchases
- **Payment Integration**: Full billing and payment processing
- **Multi-tenant Commercial**: Designed for commercial SaaS platforms

### Added

#### 🔧 **Deployment Mode Configuration**

**Environment Variable**:
```bash
# Enterprise mode (default) - Private deployment with no limits
DEPLOYMENT_MODE=enterprise

# SaaS mode - Commercial deployment with subscriptions
DEPLOYMENT_MODE=saas
```

**Updated Configuration Files**:
- `.env.example` and `backend/.env.example` now default to `enterprise` mode
- Docker Compose files use `enterprise` as default deployment mode
- All code documentation updated to clarify deployment modes

#### 🖥️ **Frontend Feature Gating**

**Conditional Feature Display**:
- **Subscription/Billing Pages**: Only visible in SaaS mode
- **Package Marketplace**: Only shown in SaaS deployments
- **Payment Interface**: Hidden in enterprise mode
- **Usage Limits UI**: Not displayed in enterprise deployments

**New Frontend Configuration** (`frontend/src/config/index.ts`):
```typescript
// Feature flags based on deployment mode
export const features = {
  showSubscription: () => isSaasMode(),
  showMarketplace: () => isSaasMode(),
  showPayment: () => isSaasMode(),
  showThirdPartyPackages: () => isSaasMode()
};
```

#### 🌐 **Public API for System Information**

**New Unauthenticated Endpoint**:
```bash
GET /api/v1/config/system-info
```

**Response**:
```json
{
  "deployment_mode": "enterprise",
  "is_saas_mode": false,
  "is_enterprise_mode": true,
  "version": "4.3.5",
  "app_name": "OpenGuardrails"
}
```

This allows frontend and client applications to detect deployment mode without authentication.

#### 🛡️ **Backend Service Adaptations**

**Conditional Route Registration**:
- Billing routes only registered in SaaS mode
- Package purchase workflows disabled in enterprise mode
- Marketplace management hidden in private deployments

**Middleware Updates**:
- `billing_middleware` now checks deployment mode
- Quota and limits enforcement only in SaaS mode
- Usage tracking optional in enterprise mode

### Changed

#### 🔄 **Enterprise Mode Benefits**

**For Local/Private Deployments**:
- ✅ **No Subscription Required**: All 21 built-in risk types available
- ✅ **No Usage Limits**: Unlimited API calls and detections
- ✅ **No Feature Restrictions**: Full access to ban policies, DLP, knowledge bases
- ✅ **No Payment Processing**: Clean deployment without payment dependencies
- ✅ **Complete Privacy**: All data stays within your infrastructure
- ✅ **Full Customization**: Unlimited custom scanners (S100+)

#### 🔄 **SaaS Mode Features**

**For Commercial Providers**:
- 💰 **Subscription Management**: Tier-based pricing with overage protection
- 🏪 **Package Marketplace**: Sell third-party scanner packages
- 💳 **Payment Processing**: Integrated billing and payment workflows
- 📊 **Usage Analytics**: Detailed quota tracking for customer billing
- 🔒 **Multi-tenant Security**: Customer isolation and billing separation

#### 🐳 **Docker Configuration Updates**

**Default to Enterprise Mode**:
- Both `docker-compose.yml` and `docker-compose.prod.yml` now default to `DEPLOYMENT_MODE=enterprise`
- Enterprise deployments require no additional configuration
- SaaS providers must explicitly set `DEPLOYMENT_MODE=saas`

**Streamlined Deployment**:
```bash
# Enterprise (default) - Full features, no limits
docker compose up -d

# SaaS mode - Must be explicitly enabled
DEPLOYMENT_MODE=saas docker compose up -d
```

### Enterprise Mode Configuration Guide

#### Quick Start (Enterprise Mode)
```bash
# 1. Clone repository
git clone https://github.com/openguardrails/openguardrails
cd openguardrails

# 2. Default configuration is enterprise mode
# Edit .env if needed, but DEPLOYMENT_MODE defaults to 'enterprise'

# 3. Deploy
docker compose up -d

# 4. Access full features without limitations
# URL: http://localhost:3000/platform/
# Admin: admin@yourdomain.com / CHANGE-THIS-PASSWORD-IN-PRODUCTION
```

#### Enterprise Mode Guarantees
- **No Subscription System**: Completely removed from UI and backend
- **No Usage Limits**: Unlimited API calls, custom scanners, applications
- **No Package Marketplace**: Streamlined interface without commercial features
- **No Payment Processing**: No billing, invoices, or payment gateways
- **Full Feature Access**: All safety features, configurations, and integrations

### SaaS Mode Configuration

#### For SaaS Providers
```bash
# 1. Enable SaaS mode
export DEPLOYMENT_MODE=saas

# 2. Configure additional SaaS settings
# (Payment gateways, subscription tiers, etc.)

# 3. Deploy with SaaS features
docker compose up -d

# 4. Configure subscription plans and marketplace
# via admin interface at /platform/admin/billing
```

### Impact on Existing Deployments

#### Existing Users (v4.3.4 and earlier)
- **Automatic Enterprise Mode**: Existing deployments default to enterprise mode
- **No Breaking Changes**: All existing functionality preserved
- **No New Limitations**: Existing access to all features maintained
- **Optional SaaS Migration**: Can switch to SaaS mode by changing `DEPLOYMENT_MODE`

#### Migration Path
```bash
# Update to v4.3.5 (automatically enterprise mode)
git pull
docker compose down && docker compose up -d

# Continue using all features without any new limitations
```

### Technical Implementation

#### Backend Changes
- **Settings Class**: New `deployment_mode` property with `is_saas_mode` and `is_enterprise_mode` helpers
- **Conditional Routing**: Admin service conditionally registers billing/marketplace routes
- **Feature Flags**: Middleware checks deployment mode before enforcing quotas/limits

#### Frontend Changes
- **Dynamic Configuration**: Fetches deployment mode from `/api/v1/config/system-info`
- **Feature Gating**: Components conditionally render based on deployment mode
- **User Experience**: Enterprise mode shows streamlined interface without commercial features

#### Database Changes
- **No Schema Changes**: Existing database schema compatible
- **Backward Compatibility**: All existing configurations preserved
- **Optional Features**: Billing tables unused in enterprise mode (no impact)

### Benefits by Stakeholder

#### 🏢 Enterprise Users
- **Simplified Deployment**: No need to configure payment systems
- **Unlimited Usage**: No quota management or limits
- **Full Control**: Complete feature access without commercial restrictions
- **Privacy Assurance**: No external dependencies for billing/subscriptions

#### ☁️ SaaS Providers
- **Commercial Platform**: Full subscription and marketplace capabilities
- **Flexible Pricing**: Tier-based pricing with custom tiers
- **Revenue Streams**: Package marketplace for third-party scanners
- **Customer Management**: Billing, usage tracking, and customer lifecycle

#### 🔧 Developers
- **Clear Separation**: Obvious distinction between deployment types
- **Clean Codebase**: Feature flags make mode-specific code obvious
- **Easy Testing**: Can test both modes with simple environment variable change
- **Documentation**: Clear guidance on deployment mode selection

### Breaking Changes

None. Existing deployments automatically get enterprise mode with full feature access.

### Security Considerations

#### Enterprise Mode
- ✅ **Reduced Attack Surface**: No payment processing or billing endpoints
- ✅ **Simplified Security**: No third-party payment integrations
- ✅ **Complete Isolation**: No external service dependencies for billing

#### SaaS Mode
- ⚠️ **Payment Security**: Must secure payment processing endpoints
- ⚠️ **Customer Data**: Proper isolation of customer billing information
- ⚠️ **Marketplace Security**: Validation of third-party package content

### Documentation Updates

- Updated deployment documentation with enterprise vs SaaS guidance
- Added feature matrix for each deployment mode
- Updated README with deployment mode selection guide
- Enhanced developer documentation for feature gating

### Future Roadmap

**Enterprise Mode Enhancements**:
- Advanced air-gapped deployment support
- Enhanced offline capabilities
- Extended enterprise security features

**SaaS Mode Enhancements**:
- Advanced analytics and reporting
- Customer self-service portal
- Extended marketplace with revenue sharing

---

## [4.1.0] - 2025-11-10

### 🚀 Major Architecture Update - Scanner Package System

**Breaking Changes**: This release completely replaces the hardcoded 21 risk types (S1-S21) with a flexible scanner package system. While existing configurations are automatically migrated, this represents a fundamental shift in how content safety detection works.

#### 🎯 What's New

OpenGuardrails v4.1.0 introduces the **Scanner Package System** - a revolutionary flexible detection architecture that supports official packages, purchasable scanners, and custom user-defined detection rules.

**Key Innovations:**
- 🏗️ **Dynamic Detection**: No more hardcoded risk types - add new scanners without code changes
- 📦 **Package Management**: Official, purchasable, and custom scanner packages
- 🔧 **Three Scanner Types**: GenAI (AI-powered), Regex (pattern), Keyword (matching)
- 🏪 **Marketplace**: Admin-controlled package marketplace with purchase approval workflow
- 🔒 **Application-Scoped**: Custom scanners work within the multi-application architecture

### Added

#### 📦 **Flexible Scanner Package System**
- **Built-in Official Packages**: System-provided packages migrated from S1-S21 risk types
- **Purchasable Official Packages**: Admin-published packages with commercial licensing
- **Custom Scanners**: User-defined scanners (S100+) with per-application scope
- **Three Scanner Types**:
  - **GenAI Scanner**: Uses OpenGuardrails-Text model for intelligent detection
  - **Regex Scanner**: Python regex pattern matching for structured data
  - **Keyword Scanner**: Comma-separated keyword matching

#### 🏪 **Package Marketplace & Management**
- **Scanner Package Marketplace**: Browse and request purchasable packages
- **Purchase Approval Workflow**: Admin approval for package purchases
- **Version Management**: Package versioning and update support
- **Archive System**: Package archiving for deprecated content
- **Price Management**: Commercial package pricing and display

#### 🔧 **Custom Scanner Creation**
- **Auto-Tag Assignment**: S100+ automatically assigned to custom scanners
- **Per-Application Scope**: Custom scanners belong to specific applications
- **Flexible Configuration**: Enable/disable, risk level overrides, scan targets
- **Three Input Methods**: Form-based UI, bulk upload, API creation
- **Usage Limits**: Tier-based limits (10 free, 50 subscribed)

#### 🗄️ **Database Architecture Updates**
- **Five New Tables**:
  - `scanner_packages` - Package metadata and management
  - `scanners` - Individual scanner definitions
  - `application_scanner_configs` - Per-application scanner settings
  - `package_purchases` - Purchase tracking and approval
  - `custom_scanners` - User-defined custom scanners

- **Migration System**:
  - Automatic migration from hardcoded S1-S21 to package system
  - Preservation of all existing user configurations
  - Backward compatibility during transition period

#### 🎨 **User Interface Overhaul**

**New Scanner Management Pages**:
- **Official Scanners** (`/platform/config/official-scanners`)
  - View built-in packages
  - Browse marketplace for purchasable packages
  - Configure individual scanners (enable/disable, risk levels)
  - Scanner type indicators (GenAI/Regex/Keyword)

- **Custom Scanners** (`/platform/config/custom-scanners`)
  - Create custom scanners with intuitive forms
  - Auto-assigned S100+ tags
  - Edit/delete custom scanners
  - Usage tracking and limits display

- **Admin Package Marketplace** (`/platform/admin/package-marketplace`)
  - Upload purchasable packages
  - Review purchase requests
  - Approve/reject purchases
  - Package management (archive, pricing)

#### 🔌 **Enhanced Detection Flow**
- **Parallel Processing**: GenAI, regex, and keyword scanners run simultaneously
- **Single Model Call**: All GenAI scanners combined for optimal performance
- **Intelligent Routing**: Scanner type determines processing method
- **Result Aggregation**: Combined results with highest risk level priority

#### 🌐 **New API Endpoints**

**Package Management**:
```
GET  /api/v1/scanner-packages              # List user's packages
GET  /api/v1/scanner-packages/marketplace   # Browse marketplace
POST /api/v1/scanner-packages/admin/upload  # Upload package (admin)
```

**Scanner Configuration**:
```
GET  /api/v1/scanner-configs                # Get app scanner configs
PUT  /api/v1/scanner-configs/{id}          # Update scanner config
POST /api/v1/scanner-configs/reset         # Reset to defaults
```

**Custom Scanners**:
```
GET  /api/v1/custom-scanners               # List custom scanners
POST /api/v1/custom-scanners               # Create custom scanner
PUT  /api/v1/custom-scanners/{id}         # Update custom scanner
DELETE /api/v1/custom-scanners/{id}       # Delete custom scanner
```

**Purchase Management**:
```
POST /api/v1/scanner-purchases/request     # Request purchase
POST /api/v1/scanner-purchases/{id}/approve # Approve purchase (admin)
```

#### 🌍 **Enhanced Internationalization**
- Added comprehensive translations for scanner system
- English and Chinese support for all new UI components
- Contextual help and documentation localization

#### 📚 **Documentation & Integration**
- **n8n Integration**: Complete workflow automation platform integration
  - Dedicated OpenGuardrails community node
  - HTTP Request node examples
  - Pre-built workflow templates
  - Content safety for automated workflows

- **Enhanced Quick Test**: Terminal commands for easy API testing
  - Mac/Linux and Windows PowerShell examples
  - One-command testing setup

### Changed

#### 🔄 **Complete Risk Type System Replacement**

**Before (v4.0):**
- 21 hardcoded risk types (S1-S21)
- Boolean configuration fields
- Schema changes required for new types
- Limited to predefined categories

**After (v4.1):**
- Flexible scanner package system
- Dynamic scanner creation
- No schema changes for new scanners
- Unlimited custom scanner types

#### 🛠️ **Detection Service Refactor**
- **New Detection Flow**: Parallel processing of multiple scanner types
- **Performance Optimization**: <10% latency increase despite added functionality
- **Migration Compatibility**: Existing S1-S21 configurations preserved
- **Enhanced Logging**: Matched scanner tags in detection results

#### 📁 **Frontend Architecture Updates**
- **Component Refactoring**: Risk type management replaced with scanner management
- **Dynamic Rendering**: UI adapts to available scanners dynamically
- **Enhanced State Management**: Application-scoped scanner configurations
- **Improved User Experience**: Intuitive scanner creation and management

### Migration Guide

#### Automatic Migration

The migration from S1-S21 risk types to scanner packages happens **automatically**:

```bash
# Migration runs automatically on service startup
docker compose up -d

# Or restart existing deployment
docker compose restart
```

**What Gets Migrated**:
1. ✅ All existing enable/disable configurations
2. ✅ Custom risk level settings
3. ✅ Application-specific configurations
4. ✅ Response template associations
5. ✅ Detection history (with backward compatibility)

**Built-in Package Mapping**:
Built-in packages are now managed through the scanner package system.

#### For Developers

**Creating Custom Scanners**:

```python
# Create custom scanner via API
import requests

response = requests.post(
    "http://localhost:5000/api/v1/custom-scanners",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "scanner_type": "genai",
        "name": "Bank Fraud Detection",
        "definition": "Detect banking fraud attempts and financial scams",
        "risk_level": "high_risk",
        "scan_prompt": True,
        "scan_response": True,
        "notes": "Custom scanner for financial applications"
    }
)

# Returns auto-assigned tag like "S100"
scanner = response.json()
print(f"Created scanner: {scanner['tag']}")
```

**Using Custom Scanners in Detection**:

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("sk-xxai-your-api-key")

# Detection automatically uses all enabled scanners
response = client.check_prompt(
    "How to commit bank fraud",
    application_id="your-app-id"  # Custom scanners are app-specific
)

# Response includes matched custom scanner tags
print(f"Matched scanners: {response.matched_scanner_tags}")
# Output: "S5,S100" (existing S5 + custom S100)
```

### Breaking Changes

#### Database Schema Changes
- ⚠️ `risk_type_config` table deprecated (kept for rollback safety)
- ⚠️ New `scanner_packages`, `scanners`, `application_scanner_configs` tables
- ✅ Migration handled automatically - no manual intervention required

#### API Changes
- ⚠️ Risk type configuration endpoints deprecated
- ✅ New scanner package endpoints available
- ✅ Backward compatibility maintained during transition

#### Frontend Changes
- ⚠️ Old risk type management pages removed
- ✅ New scanner management pages available
- ✅ All user preferences automatically migrated

### Technical Features

#### Performance Optimization
- **Parallel Processing**: Regex and keyword scanners run alongside GenAI model calls
- **Single Model Call**: All GenAI scanner definitions combined into one request
- **Latency Impact**: <10% increase despite massive functionality expansion
- **Scalability**: Supports unlimited custom scanners per application

#### Security Enhancements
- **Commercial Content Protection**: Purchasable package definitions not exposed before purchase
- **Application Isolation**: Custom scanners strictly scoped to applications
- **Rate Limiting**: Custom scanner creation limits by subscription tier
- **Audit Trail**: Complete purchase and scanner creation history

#### Extensibility Features
- **Plug-in Architecture**: Easy addition of new scanner types
- **Version Management**: Package versioning and update support
- **Dynamic Loading**: Hot-reload of scanner definitions without restart
- **Custom Logic**: Support for complex scanner combination rules

### Migration Verification

#### Verify Migration Success

```bash
# Check scanner packages
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT package_code, scanner_count FROM scanner_packages;"

# Check migrated configurations
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT COUNT(*) FROM application_scanner_configs WHERE is_enabled = true;"

# Check custom scanners
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT tag, name FROM custom_scanners;"
```

#### Test New Functionality

```bash
# Test package marketplace
curl -H "Authorization: Bearer your-jwt-token" \
  "http://localhost:5000/api/v1/scanner-packages/marketplace"

# Test custom scanner creation
curl -X POST "http://localhost:5000/api/v1/custom-scanners" \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{
    "scanner_type": "keyword",
    "name": "Test Custom Scanner",
    "definition": "test, keyword, custom",
    "risk_level": "low_risk"
  }'
```

### Documentation Updates

- Updated README.md with scanner package system documentation
- Added comprehensive scanner package API documentation
- Created n8n integration guides with ready-to-use workflows
- Enhanced migration documentation with examples
- Added custom scanner creation tutorials

### Fixed

- 🐛 **Rigid Risk Type System**: Replaced with flexible scanner packages
- 🐛 **Database Schema Inflexibility**: Dynamic scanner addition without migrations
- 🐛 **Limited Customization**: Users can now create unlimited custom detection rules
- 🔧 **Performance Optimization**: Parallel processing maintains detection speed
- 🔧 **User Experience**: Intuitive scanner creation and management interface

---

## [4.0.0] - 2025-11-04

### 🚀 Major Architecture Update - Multi-Application Management

**Breaking Changes**: This release introduces a major architectural change to support multi-application management within a single tenant account. While existing API keys continue to work (automatically migrated to a default application), the data model has been restructured for better scalability.

#### 🎯 What's New

OpenGuardrails v4.0.0 introduces **Application Management** - a powerful new architecture that allows developers to manage multiple applications within one tenant account, each with completely isolated configurations.

**Use Cases:**
- 🏢 **Enterprise Teams**: Manage different products/services with separate guardrail policies
- 🧪 **Development Workflows**: Maintain separate configs for dev, staging, and production environments
- 👥 **Multi-Tenant SaaS**: Provide isolated guardrail configurations for each customer
- 🔄 **A/B Testing**: Test different safety policies side-by-side

### Added

#### 📱 **Application Management System**
- **New Application Entity**: Introduced `applications` table as the primary isolation boundary
- **Application CRUD**: Full create, read, update, delete operations for applications
- **Application Context Header**: New `X-Application-ID` header for API requests to specify which application to use
- **Default Application**: Automatic creation of "Default Application" for all tenants during migration
- **Application-Scoped API Keys**: Each API key now belongs to a specific application
- **Application Summary**: Real-time protection configuration summary for each application:
  - Risk types enabled count (e.g., 21/21)
  - Ban policy status (enabled/disabled)
  - Sensitivity level (low/medium/high)
  - Data security entities count
  - Blacklist/whitelist counts
  - Knowledge base entries count

#### 🔧 **Configuration Isolation**
All protection configurations are now scoped to the application level:
- ✅ **Risk Type Configuration**: Each application has independent risk category settings
- ✅ **Ban Policy**: Application-specific user banning rules
- ✅ **Data Security Entity Types**: Isolated data leak detection patterns
- ✅ **Blacklists/Whitelists**: Application-scoped keyword filtering
- ✅ **Response Templates**: Custom response templates per application
- ✅ **Knowledge Bases**: Application-specific Q&A knowledge bases
- ✅ **Proxy Configurations**: Proxy settings remain tenant-level (shared across apps)

#### 🗄️ **Database Changes**
- **New Table**: `applications` - Store application metadata
  - `id` (UUID, PK), `tenant_id`, `name`, `description`
  - `is_active`, `created_at`, `updated_at`

- **Schema Updates**: Added `application_id` column to:
  - `api_keys` - Link API keys to applications
  - `risk_type_configs` - Application-scoped risk settings
  - `ban_policies` - Application-scoped ban rules
  - `data_security_entity_types` - Application-scoped DLP patterns
  - `blacklists` - Application-scoped blacklists
  - `whitelists` - Application-scoped whitelists
  - `response_templates` - Application-scoped response templates
  - `knowledge_bases` - Application-scoped knowledge bases
  - `detection_results` - Track which application handled each request

- **Migration Scripts**:
  - `011_add_application_management.sql` - Add applications table and columns
  - `012_remove_old_tenant_id_unique_constraints.sql` - Update constraints to use (tenant_id, application_id) instead of just tenant_id

#### 🌐 **API Updates**

**New Application Management Endpoints** (Admin Service - Port 5000):
```
GET    /api/v1/applications                    # List all applications
POST   /api/v1/applications                    # Create new application
PUT    /api/v1/applications/{app_id}           # Update application
DELETE /api/v1/applications/{app_id}           # Delete application
GET    /api/v1/applications/{app_id}/keys      # List API keys for app
POST   /api/v1/applications/{app_id}/keys      # Create API key for app
DELETE /api/v1/applications/{app_id}/keys/{key_id}  # Delete API key
PUT    /api/v1/applications/{app_id}/keys/{key_id}/toggle  # Toggle key status
```

**Application Context Header**:
```http
# Specify which application to use for the request
X-Application-ID: 3b9d3c1d-4ecb-4013-9508-a7067c4abf8b
```

**Backward Compatibility**:
- ✅ Existing API keys continue to work (automatically linked to default application)
- ✅ Requests without `X-Application-ID` header use the application linked to the API key
- ✅ All existing APIs support application context

#### 🎨 **Frontend Updates**

**New Application Management Page** (`/platform/config/applications`):
- Create and manage multiple applications
- View protection configuration summary for each app
- Manage application-specific API keys
- Toggle application active status
- View API key usage statistics
- Copy/show/hide API keys with one click

**Updated Configuration Pages**:
All configuration pages now respect the selected application context:
- Risk Type Management
- Ban Policy
- Data Security (DLP)
- Blacklist/Whitelist Management
- Response Templates
- Knowledge Base Management

**New Application Selector Component**:
- Global application context switcher in the header
- Shows current application name
- Quick switch between applications
- Remembers last selected application in localStorage

#### 🔄 **Automatic Migration & Initialization**

**Zero-Downtime Migration**:
- ✅ Automatic creation of "Default Application" for all existing tenants
- ✅ All existing API keys automatically linked to default application
- ✅ All existing configurations copied to default application
- ✅ Unique constraints updated to support multi-application architecture
- ✅ No data loss - all existing data preserved

**New Application Auto-Setup**:
When creating a new application, the system automatically initializes:
1. **Risk Type Config**: All 21 risk types enabled by default
2. **Ban Policy**: Disabled by default (ready to configure)
3. **Data Security Entity Types**: System templates copied and activated
4. **No other configs**: Blacklists, whitelists, templates, knowledge bases start empty

#### 📊 **Application Metrics**

Each application tracks:
- Total API keys (active + inactive)
- Last detection request timestamp
- Total detection requests count
- Risk distribution statistics
- Configuration completeness

### Changed

#### 🔄 **Data Model Restructure**

**Before (v3.x):**
```
Tenant → API Keys
Tenant → Configurations (Risk, Ban, DLP, etc.)
Tenant → Detection Results
```

**After (v4.0):**
```
Tenant → Applications → API Keys
       → Applications → Configurations (Risk, Ban, DLP, etc.)
       → Applications → Detection Results
```

**Benefits:**
- 🎯 Better configuration isolation
- 📈 Easier scaling for enterprise customers
- 🔒 Improved security with application-level access control
- 🧪 Simplified testing and deployment workflows

#### 🔧 **Service Updates**

**Admin Service** (`backend/admin_service.py`):
- Added application management routes
- Updated all config APIs to support application context
- Added application context middleware

**Detection Service** (`backend/detection_service.py`):
- Reads application context from `X-Application-ID` header or API key
- Loads application-specific configurations
- Records application_id in detection results

**Proxy Service** (`backend/proxy_service.py`):
- Supports application context for detection
- Proxy configs remain tenant-level (shared)

#### 📁 **New Files**

**Backend**:
- `backend/routers/applications.py` - Application management routes
- `backend/contexts/ApplicationContext.tsx` - React context for app selection
- `backend/migrations/versions/011_add_application_management.sql` - Migration script
- `backend/migrations/versions/012_remove_old_tenant_id_unique_constraints.sql` - Constraint updates
- `backend/fix_existing_apps.py` - Migration helper script
- `backend/diagnose_app_config.py` - Diagnostic tool

**Frontend**:
- `frontend/src/pages/Config/ApplicationManagement.tsx` - App management UI
- `frontend/src/components/ApplicationSelector/` - App selector component
- `frontend/src/contexts/ApplicationContext.tsx` - Application context provider

### Migration Guide

#### For Existing Deployments

**Automatic Migration** (recommended):
```bash
# Simply restart services - migrations run automatically!
docker compose restart

# Or rebuild and restart
docker compose down
docker compose up -d
```

The migration will:
1. ✅ Create `applications` table
2. ✅ Add `application_id` columns to all config tables
3. ✅ Create "Default Application" for each tenant
4. ✅ Link all existing API keys to default application
5. ✅ Copy all existing configs to default application
6. ✅ Update unique constraints

**Verify Migration Success**:
```bash
# Check applications table
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT id, tenant_id, name FROM applications;"

# Check API keys are linked
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT id, application_id, key FROM api_keys LIMIT 5;"
```

#### For Developers

**Using Application Context in API Calls**:

```python
# Python SDK (will be updated in next SDK release)
from openguardrails import OpenGuardrails

client = OpenGuardrails(
    api_key="sk-xxai-your-key",
    application_id="3b9d3c1d-4ecb-4013-9508-a7067c4abf8b"  # Optional
)

# HTTP API
curl -X POST "http://localhost:5001/v1/guardrails" \
  -H "Authorization: Bearer sk-xxai-your-key" \
  -H "X-Application-ID: 3b9d3c1d-4ecb-4013-9508-a7067c4abf8b" \
  -H "Content-Type: application/json" \
  -d '{"model": "OpenGuardrails-Text", "messages": [...]}'
```

**Managing Applications via API**:

```python
import requests

# List applications
response = requests.get(
    "http://localhost:5000/api/v1/applications",
    headers={"Authorization": "Bearer your-jwt-token"}
)

# Create new application
response = requests.post(
    "http://localhost:5000/api/v1/applications",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "name": "Production App",
        "description": "Production environment guardrails"
    }
)

# Create API key for application
app_id = response.json()["id"]
response = requests.post(
    f"http://localhost:5000/api/v1/applications/{app_id}/keys",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={"name": "Production API Key"}
)
```

### Backward Compatibility

✅ **Fully Backward Compatible**:
- All existing API keys continue to work
- No changes required to existing client code
- `X-Application-ID` header is optional (defaults to API key's application)
- All existing endpoints support application context

⚠️ **Recommended Updates**:
- Update SDKs to latest versions (when released)
- Use `X-Application-ID` header for explicit application selection
- Migrate to application management UI for better organization

### Fixed

- 🐛 Configuration isolation issues when managing multiple environments
- 🐛 API key management limitations for large teams
- 🐛 Difficulty testing different guardrail policies simultaneously
- 🔧 Improved unique constraint handling for multi-application scenarios

### Breaking Changes

**Database Schema**:
- ⚠️ All configuration tables now require `application_id`
- ⚠️ Unique constraints changed from `(tenant_id, name)` to `(tenant_id, application_id, name)`
- ✅ Migration handles these changes automatically

**API Keys**:
- ⚠️ API keys are now application-scoped (one key per application)
- ✅ Existing keys automatically linked to default application
- ✅ Old API keys continue to work without changes

### Technical Details

**Application Initialization**:
```python
# When creating a new application, automatically initialize:
def initialize_application_configs(application_id, tenant_id):
    # 1. Risk Type Config (all 21 types enabled)
    # 2. Ban Policy (disabled, ready to configure)
    # 3. Data Security Entity Types (system templates copied)
```

**Application Context Resolution**:
```
1. Check X-Application-ID header
2. If not present, get application_id from API key
3. Load application-specific configurations
4. Apply application context to all operations
```

**Protection Summary Calculation**:
```python
protection_summary = {
    "risk_types_enabled": 21,      # Count of enabled risk types
    "total_risk_types": 21,        # Total available risk types
    "ban_policy_enabled": False,   # Ban policy status
    "sensitivity_level": "medium", # Sensitivity threshold
    "data_security_entities": 6,   # Active DLP entities
    "blacklist_count": 2,          # Active blacklists
    "whitelist_count": 1,          # Active whitelists
    "knowledge_base_count": 5      # Active KB entries
}
```

### Documentation Updates

- Updated [README.md](README.md) with application management feature
- Updated [CLAUDE.md](CLAUDE.md) with new architecture details
- Updated [API_REFERENCE.md](docs/API_REFERENCE.md) with new endpoints
- Added application management examples

---

## [3.0.0] - 2025-01-20

### 🚀 Deployment & Developer Experience

#### Added
- ✨ **Automatic Database Migrations** - Database migrations now run automatically on first deployment
  - No manual migration commands needed - just run `docker compose up -d`
  - Entrypoint script ([backend/entrypoint.sh](backend/entrypoint.sh)) handles automatic migration execution
  - PostgreSQL advisory locks prevent concurrent migration conflicts
  - Admin service runs migrations before starting (detection and proxy services skip)
  - Migration tracking table (`schema_migrations`) records all executed migrations
  - Clear migration logs visible in admin service output
  - Safe failure mode - service won't start if migration fails
  - Improved first-time deployment experience for new developers

#### Changed
- 🐳 **Docker Configuration Updates**
  - Updated [backend/Dockerfile](backend/Dockerfile) to include `postgresql-client` for health checks
  - Added `ENTRYPOINT` script to handle pre-startup initialization
  - Added `SERVICE_NAME` environment variable to all services in [docker-compose.yml](docker-compose.yml)
  - Changed `RESET_DATABASE_ON_STARTUP` default to `false` (migrations handle schema)

#### Documentation
- 📚 **Migration Documentation**
  - Updated [backend/migrations/README.md](backend/migrations/README.md) with automatic migration details
  - Added [docs/AUTO_MIGRATION_TEST.md](docs/AUTO_MIGRATION_TEST.md) with comprehensive testing guide
  - Updated main [README.md](README.md) to explain automatic migration on deployment

## [2.6.1] - 2025-10-08

### 🌍 Internationalization (i18n)

#### Added
- 🌐 **Multi-language Support**
  - Complete internationalization framework implementation
  - Support for English (en) and Chinese (zh) languages
  - Dynamic language switching in the frontend interface
  - Persistent language preference storage in localStorage
  - Comprehensive translation coverage for all UI components

- 📝 **Translation Management**
  - Structured translation files: `frontend/src/locales/en.json` and `frontend/src/locales/zh.json`
  - Translation keys organized by feature modules (dashboard, detection, config, etc.)
  - Consistent naming convention for translation keys
  - Support for pluralization and parameter interpolation

- 🔧 **Technical Implementation**
  - React i18next integration for frontend internationalization
  - Language detection based on browser preferences
  - Fallback language mechanism (defaults to English)
  - Type-safe translation key validation
  - Hot-reload support for translation updates during development

#### Changed
- 🎨 **User Interface Updates**
  - All static text replaced with translatable keys
  - Language selector added to the main navigation
  - Consistent UI layout across different languages
  - Responsive design maintained for both language versions
  - Date and number formatting localized appropriately

- 📊 **Dashboard Localization**
  - Risk level indicators translated (Safe, Low, Medium, High)
  - Chart labels and tooltips localized
  - Statistical data descriptions in multiple languages
  - Time-based filters and date ranges localized

- ⚙️ **Configuration Pages**
  - All configuration forms and labels translated
  - Help text and tooltips localized
  - Error messages and validation feedback in user's language
  - Success notifications and status messages translated

#### Technical Features
- **Framework**: React i18next with namespace support
- **Storage**: Browser localStorage for language persistence
- **Detection**: Automatic browser language detection
- **Fallback**: Graceful fallback to English for missing translations
- **Performance**: Lazy loading of translation resources

#### Files Added
- `frontend/src/locales/en.json` - English translations
- `frontend/src/locales/zh.json` - Chinese translations
- `frontend/src/i18n/index.ts` - i18n configuration and setup
- `frontend/src/hooks/useTranslation.ts` - Custom translation hook

#### Files Modified
- Updated all React components to use translation keys
- Modified navigation components for language switching
- Enhanced configuration pages with localized content
- Updated dashboard components with translated labels

### Usage Examples

#### Language Switching
```typescript
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t, i18n } = useTranslation();
  
  const switchLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
  };
  
  return (
    <div>
      <h1>{t('dashboard.title')}</h1>
      <button onClick={() => switchLanguage('en')}>English</button>
      <button onClick={() => switchLanguage('zh')}>中文</button>
    </div>
  );
}
```

#### Translation Key Usage
```typescript
// Simple translation
{t('common.save')}

// Translation with parameters
{t('detection.results_count', { count: 42 })}

// Pluralization support
{t('user.ban_duration', { count: days, duration: days })}
```

### Documentation Updates
- Updated README.md with internationalization feature description
- Added i18n setup instructions for developers
- Updated contribution guidelines for translation contributions
- Added language support information to API documentation

---

## [2.5.0] - 2025-10-06

### 🚀 Major Updates
- 🚫 **Ban Policy**
  - Introduced an intelligent user behavior-based ban system
  - Automatically detects and defends against persistent prompt injection attempts
  - Especially effective against repeated prompt modification attacks
  - Supports flexible ban condition configuration and auto-unban mechanism

### Added
- 🚫 **Ban Policy Management**
  - New configuration management page for ban policies
  - Customizable ban conditions: risk level, trigger count, time window
  - Configurable ban duration (minutes, hours, days, permanent)
  - Enable/disable individual ban policies
  - View banned user list and manually unban users

- 🔍 **Intelligent Attack Detection**
  - Real-time monitoring of high-risk user behaviors
  - Sliding time window-based attack pattern recognition
  - Automatically logs reasons and timestamps for bans
  - Different ban strategies for different risk levels (high/medium)

- 🗄️ **Database Changes**
  - Added `ban_policies` table to store ban policy configurations
  - Added `banned_users` table to store banned user information
  - Added database migration script: `backend/database/migrations/add_ban_policy_tables.sql`

- 🔧 **New Files**
  - `backend/routers/ban_policy_api.py` - Ban policy routes
  - `backend/services/ban_policy_service.py` - Ban policy service
  - `frontend/src/pages/Config/BanPolicy.tsx` - Ban policy configuration page

- 🆔 **User ID Tracking**
  - Detection API now supports `xxai_app_user_id` parameter for tenant app user ID
  - For Python SDK: use `extra_body={"xxai_app_user_id": "user123"}`
  - For HTTP/curl: use top-level parameter `"xxai_app_user_id": "user123"`
  - Enables ban policy and behavior analysis based on user ID
  - All SDKs (Python, Java, Node.js, Go) now support an optional `user_id` parameter
  - Useful for implementing user-level risk control and audit tracking

### Changed
- 🔄 **Enhanced Detection Workflow**
  - Automatically checks if a user is banned before detection
  - Banned users’ requests return a ban message immediately
  - Updates user’s high-risk behavior count after each detection
  - Automatically triggers ban once conditions are met

- 📱 **Frontend Updates**
  - Added Ban Policy submenu in Protection Configurations
  - Added Ban Policy configuration interface
  - Added banned user list and management features
  - Supports manual unban and viewing ban details

### Fixed
- 🐛 **Ban Policy Edge Cases**
  - Fixed time window boundary calculation issues
  - Improved performance for ban status checks
  - Fixed accuracy issues in concurrent counting scenarios

### Usage Examples

#### Configure a Ban Policy
```python
# Configure ban policy via API
import requests

response = requests.post(
    "http://localhost:5000/api/v1/ban-policies",
    headers={"Authorization": "Bearer your-api-key"},
    json={
        "name": "High Risk Behavior Ban",
        "risk_level": "High",
        "trigger_count": 3,
        "time_window_minutes": 60,
        "ban_duration_minutes": 1440,  # 24 hours
        "enabled": True
    }
)
````

#### Pass User ID in API Call

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("your-api-key")

# Pass user ID during detection
response = client.check_prompt(
    "How to make a bomb",
    user_id="user123"
)

if response.is_blocked:
    print("User is banned or content blocked")
```

#### HTTP API Example

```bash
curl -X POST "http://localhost:5001/v1/guardrails" \
    -H "Authorization: Bearer your-api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "OpenGuardrails-Text",
      "messages": [
        {"role": "user", "content": "How to make a bomb"}
      ],
      "xxai_app_user_id": "user123"
    }'
```

### Technical Features

* **Intelligent Detection**: Sliding window-based attack pattern recognition
* **Flexible Configuration**: Multiple ban conditions and duration settings
* **Auto Unban**: Supports automatic unban after configured duration
* **Performance Optimized**: Efficient ban state checks and counter updates

### Documentation Updates

* Updated `README.md` with ban policy feature description
* Updated `README_ZH.md` with Chinese documentation for ban policy
* Updated API documentation to include user ID parameter

---

## [2.4.0] - 2025-10-04

### 🚀 Major Updates

* 🔐 **Data Leak Detection**

  * Added regex-based sensitive data detection and masking
  * Detects ID numbers, phone numbers, emails, bank cards, passports, IPs, etc.
  * Supports multiple masking methods: replace, mask, hash, encrypt, shuffle, randomize
  * Allows custom sensitive data patterns and regex rules
  * Separates input/output detection with flexible configuration
  * Supports both system-level and user-level configurations

### Added

* 🔐 **Data Security Management**

  * Added Data Leak Protection configuration page
  * Custom sensitive data definitions (name, regex, risk level)
  * Three risk levels: low, medium, high
  * Six masking methods: replace, mask, hash, encrypt, shuffle, random
  * Configurable input/output direction detection
  * Built-in types: ID_CARD_NUMBER_SYS, PHONE_NUMBER_SYS, EMAIL_SYS, BANK_CARD_NUMBER_SYS, PASSPORT_NUMBER_SYS, IP_ADDRESS_SYS

* 📊 **Enhanced Detection Results**

  * Added `data` field in detection results for data security findings
  * New response structure: `result.data.risk_level` and `result.data.categories`
  * Dashboard now includes “Data Leak Detected” stats
  * Online test page includes data leak examples
  * Detection results table includes “Data Leak” column
  * Risk reports include data leak metrics

* 🗄️ **Database Changes**

  * Added `data_security_patterns` table for sensitive data definitions
  * Added `data_security_config` table for DLP configurations
  * Added `data_risk_level` and `data_categories` fields to `detection_results`
  * Added migration scripts:

    * `backend/database/migrations/add_data_security_tables.sql`
    * `backend/database/migrations/add_data_security_fields.sql`

* 🔧 **New Files**

  * `backend/routers/data_security.py` - Data Security routes
  * `backend/services/data_security_service.py` - Data Security service
  * `frontend/src/pages/DataSecurity/` - Data Leak Protection UI
  * `DATA_SECURITY_README.md` - Documentation for DLP features

### Changed

* 🔄 **API Response Format**

  * Unified structure with three dimensions: `compliance`, `security`, `data`
  * Enhanced response example:

    ```json
    {
      "result": {
        "compliance": {"risk_level": "Safe", "categories": []},
        "security": {"risk_level": "Safe", "categories": []},
        "data": {"risk_level": "High", "categories": ["PHONE_NUMBER_SYS", "ID_CARD_NUMBER_SYS"]}
      },
      "suggest_answer": "My phone is <PHONE_NUMBER_SYS>, ID is <ID_CARD_NUMBER_SYS>"
    }
    ```

* 📱 **Frontend Updates**

  * Dashboard redesigned with data leak risk cards
  * Added data leak testing in online test page
  * Detection results support data leak filtering
  * Risk report includes DLP charts
  * Protection Configurations now include DLP submenu

* 🔧 **Backend Enhancements**

  * Integrated data security into detection workflow
  * Supports input/output direction detection
  * Combined risk decision based on highest risk level
  * Masked results returned via `suggest_answer`

### Fixed

* 🐛 **Database Pool Optimization**

  * Fixed connection pool leaks under high concurrency
  * Tuned pool configuration parameters

* 🔧 **Regex Boundary Issue**

  * Fixed boundary matching for Chinese text
  * Improved character boundary logic for non-Latin text

### SDK Updates

* 📦 **Updated All SDKs for New Response Format**

  * Python SDK (openguardrails)
  * Go SDK (openguardrails-go)
  * Node.js SDK (openguardrails)
  * Java SDK (openguardrails)

### Technical Features

* **Direction Control**: Input-only, output-only, or bidirectional detection
* **Custom Rules**: Full user-defined sensitive data patterns
* **Performance**: Optimized regex matching for high concurrency
* **Isolation**: User-level configuration isolation

### Documentation Updates

* Updated `README.md` with DLP feature description
* Updated `README_ZH.md` with Chinese DLP documentation
* Added detailed `DATA_SECURITY_README.md`
* Updated API documentation for new response schema

---

## [2.3.0] - 2025-09-30

### 🚀 Major Updates

* 🖼️ **Multimodal Detection**

  * Added image modality safety detection capability
  * Supports compliance and safety checks for image content
  * Consistent risk categories and detection standards with text detection
  * Fully supports both API and Gateway modes

### Added

* 🖼️ **Image Detection**

  * Supports two input types: base64-encoded images and image URLs
  * Utilizes the multimodal detection model `OpenGuardrails-VL`
  * Image files stored under user-specific directories (`/mnt/data/openguardrails-data/media/{user_uuid}/`)
  * Web UI now supports image upload for testing
  * Added new image upload and preview components

* 🔌 **Enhanced API**

  * Detection API now supports hybrid messages (text + image)
  * `messages.content` supports array format: `[{"type": "text"}, {"type": "image_url"}]`
  * Image URLs support both `data:image/jpeg;base64,...` and `file://...` formats
  * Security Gateway proxy fully supports multimodal request passthrough

* 📁 **New Files**

  * `backend/routers/media.py` – Media file management routes
  * `backend/utils/image_utils.py` – Image processing utilities
  * `backend/utils/url_signature.py` – URL signature verification utilities
  * `backend/scripts/migrate_add_image_fields.py` – Database migration script
  * `frontend/src/components/ImageUpload/` – Image upload component

### Changed

* 🔄 **Enhanced Detection Service**

  * Detection model logic now supports multimodal content
  * Database schema updated to include image-related fields
  * Online testing page supports image upload and preview

* 🌐 **API Response Format**

  * Unified response format consistent with text detection
  * Supports multiple risk tags (e.g., `unsafe\nS1,S2`)
  * Sensitivity scores and levels now apply to image detection

### Technical Features

* **Image Detection Model**: Vision-Language-based multimodal safety detection
* **Storage Management**: Isolated, user-level media file storage
* **URL Security**: Signed URLs prevent unauthorized access
* **Format Compatibility**: Compatible with OpenAI Vision API message format

### Usage Examples

#### Python API Example

```python
import base64
from openguardrails import OpenGuardrails

client = OpenGuardrails("your-api-key")

# Encode image to base64
with open("image.jpg", "rb") as f:
    image_base64 = base64.b64encode(f.read()).decode("utf-8")

# Send detection request
response = client.check_messages([
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "Is this image safe?"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}}
        ]
    }
])

print(f"Overall Risk Level: {response.overall_risk_level}")
print(f"Risk Categories: {response.all_categories}")
```

#### cURL Example

```bash
curl -X POST "http://localhost:5001/v1/guardrails" \
    -H "Authorization: Bearer your-api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "OpenGuardrails-VL",
      "messages": [{
        "role": "user",
        "content": [
          {"type": "text", "text": "Is this image safe?"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
        ]
      }],
      "logprobs": true
    }'
```

---

## [2.2.0] - 2025-01-15

### 🚀 Major Updates

* 🧠 **Knowledge-Based Auto-Response**

  * Brand-new intelligent answering system based on vector similarity search
  * Supports uploading Q&A files to automatically build knowledge base vector indexes
  * During risk detection, similar questions are matched first and the corresponding safe answers are returned
  * Supports both global and user-level knowledge bases; administrators can configure globally active ones

### Added

* 📚 **Knowledge Base Management**

  * Web UI for creating, editing, and deleting knowledge bases
  * Supports JSONL-format Q&A pair uploads with validation
  * Automatic generation and management of vector indexes
  * Built-in knowledge search testing interface
  * Supports file replacement and reindexing

* 🎯 **Smart Answer Strategy**

  * When risk detection is triggered, the system searches for similar Q&A pairs in the knowledge base
  * Uses cosine similarity for question matching
  * Configurable similarity threshold and result count
  * Falls back to default rejection templates if no match is found

### New Configuration

* `EMBEDDING_API_BASE_URL` – Embedding API base URL
* `EMBEDDING_API_KEY` – Embedding API key
* `EMBEDDING_MODEL_NAME` – Embedding model name
* `EMBEDDING_MODEL_DIMENSION` – Vector dimension
* `EMBEDDING_SIMILARITY_THRESHOLD` – Similarity threshold
* `EMBEDDING_MAX_RESULTS` – Max number of returned results

#### Knowledge Base File Format

```jsonl
{"questionid": "q1", "question": "What is Artificial Intelligence?", "answer": "AI is the technology that simulates human intelligence."}
{"questionid": "q2", "question": "How to use Machine Learning?", "answer": "Machine learning is an important branch of AI..."}
```

---

## [2.1.0] - 2025-09-29

Added **sensitivity threshold configuration** – allows customizing detection sensitivity, useful for special cases or fully automated pipelines.

---

## [2.0.0] - 2025-01-01

### 🚀 Major Updates

* 🛡️ **All-New Security Gateway Mode**

  * Added reverse proxy service (`proxy-service`) supporting OpenAI-compatible transparent proxy
  * Implements WAF-style AI protection for automatic input/output inspection
  * Supports upstream model management for one-click protection configuration
  * Zero-code integration—just update `base_url` and `api_key`

* 🏗️ **Three-Service Architecture**

  * **Management Service** (port 5000): Admin APIs (low concurrency)
  * **Detection Service** (port 5001): High-concurrency guardrails detection API
  * **Proxy Service** (port 5002): High-concurrency reverse proxy for security gateway
  * Architecture optimization reduced DB connections from 4,800 to 176 (↓96%)

### Added

* 🔌 **Dual Mode Support**

  * **API Mode**: Developers actively call detection APIs
  * **Gateway Mode**: Transparent reverse proxy with automatic request inspection

* 🎯 **Upstream Model Management**

  * Web UI for configuring upstream models (OpenAI, Claude, local models, etc.)
  * Secure API key management and storage
  * Request forwarding and response proxying
  * User-level model access control

* 🚦 **Smart Proxy Strategy**

  * Input detection: preprocess and filter user requests
  * Output detection: review AI-generated responses
  * Auto-blocking of high-risk content
  * Auto-response templates for safe replacement

* 🐳 **Optimized Docker Architecture**

  * Docker Compose now supports all three services
  * Independent containers for detection, management, and proxy
  * Unified data directory mount and log management
  * Automatic health checks and service discovery

* 📁 **New Files**

  * `backend/proxy_service.py` – Proxy service entry
  * `backend/start_proxy_service.py` – Proxy service startup script
  * `backend/start_all_services.sh` – Startup script for all three services
  * `backend/stop_all_services.sh` – Shutdown script for all three services
  * `backend/services/proxy_service.py` – Proxy core logic
  * `backend/routers/proxy_api.py` – Proxy API routes
  * `backend/routers/proxy_management.py` – Proxy management routes
  * `frontend/src/pages/Config/ProxyModelManagement.tsx` – Upstream model UI
  * `examples/proxy_usage_demo.py` – Proxy usage example

* 🔌 **Private Deployment Integration** 🆕

  * Supports deep integration with customer systems
  * New config `STORE_DETECTION_RESULTS` to control detection result storage
  * Customers can manage user-level allowlists, blocklists, and templates via API
  * JWT authentication ensures complete data isolation

### Changed

* 🔄 **Architecture Refactoring**

  * Split into three microservices for scalability
  * Detection Service: 32 processes for API detection
  * Management Service: 2 lightweight admin processes
  * Proxy Service: 24 processes for secure gateway
  * Unified log directory under `DATA_DIR`

* 🌐 **API Route Updates**

  * Detection API: `/v1/guardrails` (port 5001)
  * Management API: `/api/v1/*` (port 5000)
  * Proxy API: OpenAI-compatible format (port 5002)
  * New Proxy Management API: `/api/v1/proxy/*`
  * Separate health check endpoints for each service

* 📦 **Deployment Updates**

  * Docker Compose supports independent service containers
  * Added proxy-related environment variables
  * Unified data directory mounts
  * Automated start/stop scripts

* 🔧 **Configuration Enhancements**

  * New proxy configs: `PROXY_PORT`, `PROXY_UVICORN_WORKERS`
  * Improved DB connection pool separation
  * Added upstream model configuration management
  * Supports multiple AI provider integrations

* 📊 **Data Flow Redesign**

  ```
  # API Mode
  Client → Detection Service (5001) → Guardrails Detection → Response

  # Gateway Mode
  Client → Proxy Service (5002) → Input Check → Upstream Model → Output Check → Response

  # Management Mode
  Web Admin → Management Service (5000) → Config Management → Database
  ```

### Fixed

* 🐛 **Database Connection Pool**

  * Resolved DB connection exhaustion under high concurrency
  * Optimized connection pool allocation for three-service setup
  * Reduced redundant DB operations, improving response times

### Technical Debt

* Removed deprecated single-service mode
* Optimized Docker image build
* Unified configuration file management

---

## [1.0.0] - 2024-08-09

### Added

* 🛡️ **Core Safety Detection**

  * 12-dimension risk classification
  * Prompt injection detection (S9)
  * Content compliance detection (S1–S8, S10–S12)
  * Four risk levels: none, low, medium, high

* 🧠 **Context-Aware Detection**

  * Supports multi-turn dialogue understanding
  * Risk evaluation across full conversation context
  * Context-sensitive risk identification

* 🏗️ **Complete System Architecture**

  * FastAPI backend
  * React admin frontend
  * PostgreSQL database
  * Dockerized deployment

* 👥 **Tenant Management**

  * User registration, login, authentication
  * API key management
  * JWT-based identity verification
  * Role-based admin control

* ⚙️ **Flexible Configuration**

  * Blacklist/whitelist management
  * Safe response template management
  * User-level rate limit configuration

* 📊 **Visual Dashboard**

  * Real-time detection metrics
  * Historical detection queries
  * Risk distribution visualization
  * Config management interface

* 🚦 **Rate Limiting & Monitoring**

  * User-level request rate limits
  * Real-time performance monitoring
  * Detection result analytics
  * Abnormal access alerts

* 🔌 **API Interface**

  * OpenAI-compatible format
  * RESTful API design
  * Full documentation
  * Multi-language SDKs

* 🐳 **Deployment**

  * One-click Docker Compose deployment
  * PostgreSQL initialization scripts
  * Health checks
  * Production-ready configs

### Technical Features

* **High Performance**: Async processing, high concurrency
* **High Availability**: Containerized, scalable
* **High Security**: Encrypted, offline-ready
* **High Accuracy**: >97% accuracy, <0.5% false positives

### Documentation

* 📖 Full API docs
* 🚀 Quick start guide
* 🏗️ Product overview
* 🤝 Contribution guide
* 🔒 Security notes

### Open Source Model

* 🤗 HuggingFace model: `openguardrails/OpenGuardrails-Text`
* Apache 2.0 License
* Supports Chinese & English detection
* Includes full inference example

### Client Libraries

* 🐍 Python SDK: `openguardrails`
* 📱 JavaScript SDK: `openguardrails-js`
* 🌐 HTTP API: OpenAI-compatible

---

## Version Notes

### Semantic Versioning

* **MAJOR**: Incompatible API changes
* **MINOR**: Backward-compatible feature additions
* **PATCH**: Backward-compatible fixes

### Change Types

* **Added**: New features
* **Changed**: Modified existing features
* **Deprecated**: Soon-to-be removed
* **Removed**: Fully removed
* **Fixed**: Bug fixes
* **Security**: Security-related changes

---

## Upgrade Guide

### Upgrading from 0.x to 1.0.0

First official release, with major changes:

#### Database Changes

* Migration from SQLite → PostgreSQL
* New schema and table structure
* User data and config must be reimported

#### API Changes

* Unified OpenAI-compatible API format
* New authentication (Bearer Token)
* Standardized response format

#### Configuration Changes

* Updated environment variables
* Revised Docker Compose setup
* Removed deprecated configs

#### Migration Steps

1. Back up your data
2. Update to the new version
3. Run migration scripts
4. Update API call logic
5. Test and verify

---

## Contributors

Thanks to all contributors:

* **Core Team**

  * [@thomas](mailto:thomas@openguardrails.com) – Project Lead
  * OpenGuardrails Team

* **Community Contributors**

  * Be the first to contribute!

---

## Support & Contact

* 📧 **Technical Support**: [thomas@openguardrails.com](mailto:thomas@openguardrails.com)
* 🌐 **Website**: [https://openguardrails.com](https://openguardrails.com)
* 📱 **GitHub Issues**: [https://github.com/openguardrails/openguardrails/issues](https://github.com/openguardrails/openguardrails/issues)
* 💬 **Discussions**: [https://github.com/openguardrails/openguardrails/discussions](https://github.com/openguardrails/openguardrails/discussions)
