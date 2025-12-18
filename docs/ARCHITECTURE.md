# System Architecture

> Deep dive into OpenGuardrails' technical architecture and design decisions

## Table of Contents

- [Overview](#overview)
- [Three-Service Architecture](#three-service-architecture)
- [Component Diagram](#component-diagram)
- [Data Flow](#data-flow)
- [Database Schema](#database-schema)
- [Performance Optimization](#performance-optimization)
- [Security Model](#security-model)
- [Scalability](#scalability)

---

## Overview

OpenGuardrails uses a **microservices architecture** with separation of concerns:

- **Admin Service**: User management and configuration (low concurrency)
- **Detection Service**: High-throughput safety detection (high concurrency)
- **Proxy Service**: Transparent security gateway (high concurrency)

This design provides:
- ✅ Independent scaling
- ✅ Optimized worker allocation
- ✅ Clear separation of concerns
- ✅ High availability

---

## Three-Service Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     External Clients                        │
│   Web UI │ Python SDK │ API Calls │ OpenAI-Compatible      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     Nginx / Load Balancer                   │
│              Port-based routing and SSL termination         │
└─────────────────────────────────────────────────────────────┘
         │                     │                    │
         │ :5000              │ :5001              │ :5002
         ▼                     ▼                    ▼
┌──────────────┐    ┌──────────────────┐   ┌─────────────────┐
│    Admin     │    │    Detection     │   │     Proxy       │
│   Service    │    │     Service      │   │    Service      │
├──────────────┤    ├──────────────────┤   ├─────────────────┤
│ 2 Workers    │    │  32 Workers      │   │   24 Workers    │
│ FastAPI      │    │  FastAPI         │   │   FastAPI       │
│ Sync I/O     │    │  Async I/O       │   │   Async I/O     │
└──────┬───────┘    └────────┬─────────┘   └────────┬────────┘
       │                     │                       │
       └─────────────────────┼───────────────────────┘
                             ▼
            ┌────────────────────────────────┐
            │      PostgreSQL Database       │
            │      Multi-tenant isolation    │
            │     Advisory locks for safety  │
            └────────────────────────────────┘
                             │
                             ▼
            ┌────────────────────────────────┐
            │      AI Model Services         │
            │  OpenGuardrails-Text (vLLM)   │
            │  BGE-M3 Embeddings (vLLM)     │
            └────────────────────────────────┘
```

---

## Three-Service Architecture

### 1. Admin Service (Port 5000)

**Purpose**: User management, configuration, analytics

**Characteristics**:
- **Worker Count**: 2 (low concurrency)
- **I/O Model**: Synchronous
- **Use Cases**:
  - User login/registration
  - Configuration updates
  - Dashboard analytics
  - Admin operations

**Key Routes**:
```python
/api/v1/auth/*           # Authentication
/api/v1/users/*          # User management
/api/v1/config/*         # Configuration
/api/v1/dashboard/*      # Analytics (NOTE: moved to detection in v4.5+)
/api/v1/proxy/*          # Proxy model management
/api/v1/custom-scanners/* # Custom scanner management
```

**Why 2 Workers?**
- Low request volume
- Resource optimization
- Most operations are CRUD

### 2. Detection Service (Port 5001)

**Purpose**: High-throughput safety detection

**Characteristics**:
- **Worker Count**: 32 (high concurrency)
- **I/O Model**: Async
- **Use Cases**:
  - Prompt safety detection
  - Response safety detection
  - Multi-turn conversation analysis
  - Real-time moderation

**Key Routes**:
```python
/v1/guardrails          # Main detection API
/v1/guardrails/input    # Input-only detection (Dify)
/v1/guardrails/output   # Output-only detection (Dify)
/api/v1/dashboard/*     # Analytics queries
/api/v1/results/*       # Detection history
```

**Why 32 Workers?**
- Handle thousands of concurrent detections
- Model API calls are I/O-bound
- Async workers maximize throughput

### 3. Proxy Service (Port 5002)

**Purpose**: Transparent security gateway (OpenAI-compatible)

**Characteristics**:
- **Worker Count**: 24 (high concurrency)
- **I/O Model**: Async
- **Use Cases**:
  - Zero-code integration
  - Streaming responses
  - Automatic input/output protection
  - Multi-provider support

**Key Routes**:
```python
/v1/chat/completions    # OpenAI-compatible chat
/v1/completions         # OpenAI-compatible completion
/v1/models              # List available models
```

**Why 24 Workers?**
- Streaming responses require persistent connections
- Proxy to upstream models (I/O-bound)
- Moderate concurrency needs

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                  OpenGuardrails Platform                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │              Frontend (React + Ant Design)         │   │
│  │              Served by Nginx on :3000              │   │
│  └────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌────────────────────────────────────────────────────┐   │
│  │                Backend Services Layer               │   │
│  ├────────────────────────────────────────────────────┤   │
│  │                                                     │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │   │
│  │  │   Routers    │  │  Services    │  │  Models  │ │   │
│  │  │  (FastAPI)   │  │  (Business)  │  │(Pydantic)│ │   │
│  │  └──────────────┘  └──────────────┘  └──────────┘ │   │
│  │                                                     │   │
│  │  ┌──────────────────────────────────────────────┐ │   │
│  │  │           Database Layer (SQLAlchemy)        │ │   │
│  │  └──────────────────────────────────────────────┘ │   │
│  └────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌────────────────────────────────────────────────────┐   │
│  │           PostgreSQL Database (Port 54321)         │   │
│  │     - Multi-tenant data isolation                  │   │
│  │     - Advisory locks for migrations                │   │
│  │     - Connection pooling                           │   │
│  └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼ API Calls
┌─────────────────────────────────────────────────────────────┐
│                   External AI Services                      │
│  ┌──────────────────┐          ┌──────────────────┐        │
│  │ Text Model API   │          │ Embedding API    │        │
│  │ (vLLM / OpenAI)  │          │ (vLLM / OpenAI)  │        │
│  └──────────────────┘          └──────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Detection Request Flow

```
1. Client Request
   ↓
2. Detection Service (:5001)
   ├─ Authentication (API Key / JWT)
   ├─ Rate Limiting
   └─ Ban Check
   ↓
3. Guardrail Pipeline
   ├─ Whitelist Check (early exit if matched)
   ├─ Blacklist Check (early exit if matched)
   ├─ Model Detection (parallel)
   │  ├─ Security Scan (prompt injection, jailbreak)
   │  ├─ Compliance Scan (violence, hate, NSFW)
   │  ├─ Data Security Scan (PII, credentials)
   │  └─ Custom Scanners (business policies)
   └─ Risk Aggregation
   ↓
4. Action Determination
   ├─ Risk Level → Action (pass/reject/replace)
   └─ Knowledge Base Matching (if replace)
   ↓
5. Response
   ├─ Async Logging (PostgreSQL)
   └─ Return to Client
```

### Proxy Request Flow

```
1. Client Request (OpenAI-compatible)
   ↓
2. Proxy Service (:5002)
   ├─ Authentication (Proxy API Key)
   └─ Model Lookup (proxy_keys table)
   ↓
3. Input Guardrail Check
   ├─ Call Detection Service (/v1/guardrails)
   └─ If blocked: return safe response
   ↓
4. Forward to Upstream Model
   ├─ OpenAI / Anthropic / Local Model
   └─ Stream or buffer response
   ↓
5. Output Guardrail Check
   ├─ Call Detection Service (/v1/guardrails)
   └─ If blocked: return safe response
   ↓
6. Return to Client
   └─ Stream or complete response
```

---

## Database Schema

### Core Tables

#### tenants
```sql
- id (PK)
- email
- username
- hashed_password
- api_key (unique, indexed)
- is_super_admin
- created_at
- updated_at
```

#### detection_results
```sql
- id (PK)
- tenant_id (FK)
- input_text
- output_text
- overall_risk_level
- compliance_result (JSONB)
- security_result (JSONB)
- data_result (JSONB)
- suggest_action
- created_at
- user_id (indexed)
- ip_address
```

#### blacklist / whitelist
```sql
- id (PK)
- tenant_id (FK)
- keywords (JSONB array)
- updated_at
```

#### response_templates
```sql
- id (PK)
- tenant_id (FK)
- risk_category
- template_text
- created_at
```

#### scanner_packages (v4.1+)
```sql
- id (PK)
- tag (unique: S1, S2, etc.)
- name
- description
- category (official/purchasable/custom)
- scanner_type (genai/regex/keyword)
- definition (for genai)
- pattern (for regex)
- keywords (for keyword)
- risk_level
- enabled (default)
```

#### custom_scanners (v4.1+)
```sql
- id (PK)
- tenant_id (FK)
- application_id (FK)
- tag (auto-assigned: S100+)
- scanner_type
- name
- definition / pattern / keywords
- risk_level
- scan_prompt
- scan_response
- enabled
- created_at
```

#### proxy_keys
```sql
- id (PK)
- tenant_id (FK)
- api_key (unique, indexed)
- proxy_model_id (FK)
- enabled
- created_at
```

#### upstream_models
```sql
- id (PK)
- tenant_id (FK)
- name
- provider (openai/anthropic/local)
- api_base_url
- api_key (encrypted)
- model_name
- enabled
```

### Indexing Strategy

**High-frequency queries**:
```sql
-- API key lookups
CREATE INDEX idx_tenants_api_key ON tenants(api_key);
CREATE INDEX idx_proxy_keys_api_key ON proxy_keys(api_key);

-- Detection history queries
CREATE INDEX idx_detection_results_tenant ON detection_results(tenant_id, created_at DESC);
CREATE INDEX idx_detection_results_user ON detection_results(user_id, created_at DESC);

-- Ban policy checks
CREATE INDEX idx_ban_records_user ON ban_records(user_id, expires_at);
```

---

## Performance Optimization

### 1. Caching Strategy

**In-Memory Caches (TTL)**:
```python
# Authentication cache (1 hour)
auth_cache[api_key] = {
    "tenant_id": "...",
    "permissions": [...],
    "expires": timestamp + 3600
}

# Keyword cache (5 minutes)
keyword_cache[tenant_id] = {
    "blacklist": [...],
    "whitelist": [...],
    "expires": timestamp + 300
}

# Risk config cache (5 minutes)
risk_config_cache[tenant_id] = {
    "thresholds": {...},
    "enabled_scanners": [...],
    "expires": timestamp + 300
}
```

### 2. Async I/O

**Model API Calls** (parallel):
```python
async def detect(text):
    results = await asyncio.gather(
        detect_security(text),      # Parallel
        detect_compliance(text),    # Parallel
        detect_data_leak(text),     # Parallel
        run_custom_scanners(text)   # Parallel
    )
    return aggregate_results(results)
```

### 3. Connection Pooling

**PostgreSQL Connection Pool**:
```python
# SQLAlchemy pool configuration
pool_size = 20                 # Base connections
max_overflow = 40              # Additional connections
pool_timeout = 30              # Connection timeout
pool_recycle = 3600            # Recycle connections
```

### 4. Database Query Optimization

**Efficient pagination**:
```sql
-- Use cursor-based pagination for large result sets
SELECT * FROM detection_results
WHERE tenant_id = ? AND id > last_id
ORDER BY id
LIMIT 100;
```

**Batch inserts**:
```python
# Async batch logging
async def log_detection(result):
    batch_queue.append(result)
    if len(batch_queue) >= 100:
        await db.bulk_insert(batch_queue)
        batch_queue.clear()
```

---

## Security Model

### 1. Multi-Tenant Isolation

**Database level**:
```sql
-- All queries automatically scoped by tenant_id
SELECT * FROM detection_results
WHERE tenant_id = ? AND ...;
```

**API level**:
```python
# Middleware enforces tenant isolation
@app.middleware("http")
async def tenant_isolation(request, call_next):
    tenant_id = get_tenant_from_auth(request)
    request.state.tenant_id = tenant_id
    return await call_next(request)
```

### 2. Authentication Methods

**API Key Authentication** (Detection/Proxy):
```python
Authorization: Bearer sk-xxai-{tenant_specific_key}
```

**JWT Authentication** (Admin):
```python
Authorization: Bearer {jwt_token}
# Token contains: tenant_id, user_id, role, expiration
```

**Admin User Switching**:
```python
# Super admin can switch tenant context
X-Switch-User: {user_id}
```

### 3. Rate Limiting

**Per-Tenant Limits**:
```python
# Redis-based rate limiting
rate_limits = {
    "detection_api": "100/minute",
    "admin_api": "120/minute",
    "auth_api": "30/minute"
}
```

### 4. Data Encryption

**At Rest**:
- PostgreSQL encryption (filesystem level)
- API keys hashed (bcrypt)
- Sensitive config encrypted (Fernet)

**In Transit**:
- TLS 1.3 for all API communication
- Certificate pinning for model APIs

---

## Scalability

### Horizontal Scaling

**Service-level scaling**:
```yaml
# Docker Compose scaling
docker compose up -d --scale detection-service=4
docker compose up -d --scale proxy-service=3
```

**Load balancer**:
```nginx
upstream detection_backend {
    server detection-1:5001;
    server detection-2:5001;
    server detection-3:5001;
    server detection-4:5001;
}
```

### Vertical Scaling

**Worker configuration**:
```bash
# Environment variables
DETECTION_UVICORN_WORKERS=64  # More workers
PROXY_UVICORN_WORKERS=48
ADMIN_UVICORN_WORKERS=4
```

### Database Scaling

**Read Replicas**:
```python
# Master-slave configuration
DATABASE_WRITE_URL=postgresql://master:5432/db
DATABASE_READ_URL=postgresql://replica:5432/db

# Read operations use replica
@app.get("/api/v1/results")
async def get_results():
    async with read_db_session() as session:
        return await session.execute(query)
```

**Partitioning**:
```sql
-- Partition detection_results by date
CREATE TABLE detection_results_2025_01 PARTITION OF detection_results
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

---

## Monitoring & Observability

### Health Checks

```bash
# Service health
GET /health

# Database health
GET /health/db

# Model API health
GET /health/models
```

### Metrics

**Prometheus Metrics**:
```python
- guardrails_requests_total
- guardrails_request_duration_seconds
- guardrails_risk_level_total{level="high_risk"}
- model_api_latency_seconds{model="OpenGuardrails-Text"}
- cache_hit_rate{cache="auth"}
```

### Logging

**Structured JSON Logs**:
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "level": "INFO",
  "service": "detection",
  "tenant_id": "tenant_xxx",
  "request_id": "req_xxx",
  "event": "detection_completed",
  "duration_ms": 156,
  "risk_level": "no_risk"
}
```

---

## Deployment Modes

### 1. Single Server (Development)
- All services on one host
- Single PostgreSQL instance
- Suitable for testing

### 2. Multi-Server (Production)
- Services distributed across servers
- Load balancer + multiple service instances
- Separate database server
- Redis for caching

### 3. Kubernetes (Enterprise)
- Container orchestration
- Auto-scaling
- High availability
- See [k8s-manifests/](../k8s-manifests/)

---

## Technology Stack

### Backend
- **Framework**: FastAPI 0.104+
- **ORM**: SQLAlchemy 2.0+
- **Database**: PostgreSQL 14+
- **Validation**: Pydantic 2.0+
- **Async**: HTTPX, aiohttp
- **Auth**: PyJWT, bcrypt

### Frontend
- **Framework**: React 18
- **UI Library**: Ant Design 5
- **State**: React Context
- **HTTP**: Axios
- **Build**: Vite
- **i18n**: react-i18next

### Infrastructure
- **Containers**: Docker
- **Orchestration**: Docker Compose / Kubernetes
- **Web Server**: Nginx
- **Process Manager**: Supervisor
- **Cache**: In-memory (optional Redis)

---

## Design Principles

1. **Separation of Concerns**
   - Independent services for different workloads
   - Clear boundaries and responsibilities

2. **Async by Default**
   - Non-blocking I/O for high throughput
   - Parallel model API calls

3. **Multi-Tenant First**
   - Tenant isolation at every layer
   - Scalable to thousands of tenants

4. **API-First Design**
   - RESTful APIs for all operations
   - OpenAI-compatible interfaces

5. **Observable**
   - Comprehensive logging
   - Metrics and health checks
   - Debugging tools

6. **Secure by Default**
   - Authentication required
   - Encryption in transit and at rest
   - Rate limiting and ban policies

---

## Next Steps

- 📘 [Deployment Guide](DEPLOYMENT.md)
- 📗 [Custom Scanners](CUSTOM_SCANNERS.md)
- 🏢 [Enterprise PoC Guide](ENTERPRISE_POC.md)

---

**Last Updated**: 2025-01-21
**Need Help?** Contact thomas@openguardrails.com
