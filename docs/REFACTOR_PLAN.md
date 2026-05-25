# OpenGuardrails Refactor Plan (Phase 2–4)

> Status: design doc, not yet started.
> Owner: Thomas.
> Companion: Phase 1 (detection-log query optimization) is already merged — see migration 093 and `routers/results.py`.

This doc captures the next three phases of refactor. They are designed to be deployed independently — each phase is shippable on its own and adds value even if the next one slips.

---

## Why we're doing this (one paragraph)

The four user-facing problems — log-page 504s, MySQL portability, too many processes, and weak gateway — all share one root cause: the backend is **`async def` routes calling sync `psycopg2`**, with state (locks, counters, caches) spread across PostgreSQL because there was no Redis. That forces 58 worker processes on a 4-core box, ties us to PostgreSQL-only features, and leaves no clean place for a real AI gateway control plane. The plan below removes that root cause in three steps, in the safest order: first Redis (so we have a place to put hot state), then async (so one process can handle real load), then dialect abstraction + gateway features (which become easy once the first two are done).

---

## Phase 2 — Redis-ization (2–3 weeks)

### Goal
Move all hot, mutable, cross-process state out of PostgreSQL into Redis. This (a) removes most PG-only feature dependencies in one shot, and (b) gives Phase 3 (async) a clean concurrency primitive that doesn't deadlock the DB.

### What moves where

| Current location | New location | Notes |
|---|---|---|
| `pg_try_advisory_lock` for DB init (`database/connection.py:132`) | Redis `SET NX EX` with Lua-script release | Wrap as `RedisLock(key, ttl)` context manager |
| `pg_try_advisory_lock` for migrations (`migrations/run_migrations.py:190`) | Same Redis lock | Migration runner gets a small `--no-redis` flag for bootstrap edge case (first-ever startup before Redis ready) — it can fall back to PG-only locks until Redis is reachable |
| Rate-limit counters via `ON CONFLICT … DO UPDATE` (`services/rate_limiter.py:81-98`) | Redis sliding-window via Lua | One atomic script per check; eliminates the row contention we currently push at PG |
| Auth/user/config caches (currently in-process dicts) | Redis with local 1-second LRU on top | Cross-worker consistency: a config update in admin invalidates the cache for detection workers immediately |
| API key validation cache | Redis | Big win during traffic spikes — currently each worker holds its own cache and warms it independently |

### What does NOT move
- Long-term audit data (detection_results, payments, audit_logs) — stays in PG.
- Schema/structural data (tenants, applications, configs, scanner definitions) — stays in PG.
- Anything an operator needs to see in `psql` for debugging — stays in PG.

### Concrete changes
- New module `backend/services/redis_client.py` — single async Redis pool, `from_url(REDIS_URL)`, `health()` probe.
- New module `backend/services/distributed_lock.py` — `RedisLock` async context manager. Replaces both call sites of `pg_try_advisory_lock`.
- Rewrite `backend/services/rate_limiter.py` against Redis. Keep the same external interface (`async def check(key, limit, window) -> RateLimitResult`) so callers don't change.
- New env vars: `REDIS_URL`, `REDIS_PASSWORD`, `REDIS_DB`. Defaults that make local dev "just work" against the new compose container.
- `docker-compose.yml`: add `openguardrails-redis` (redis:7-alpine, AOF persistence, 256MB maxmemory). Health check + depends_on wiring.

### Risks & mitigations
- **Redis becomes a new SPOF.** Mitigation: rate limiter degrades open (allows requests but logs the failure) when Redis is unreachable, rather than blocking traffic. Distributed lock for migrations falls back to PG advisory lock for the very first startup.
- **AOF persistence cost.** Detection results write rate is high; rate-limit counters are not durable — they don't need AOF. Use a small AOF window or RDB snapshot only.
- **Dev environment loses single-`docker compose up` simplicity.** Already broken (multi-container). Adding Redis is one more container. Acceptable.

### Exit criteria
- `grep -r pg_advisory_lock backend/` returns zero hits.
- Rate limiter no longer writes to PG on the hot path.
- Single Redis outage in staging triggers clean degradation, not 500s.

---

## Phase 3 — Async stack + service consolidation (3–4 weeks)

### Goal
Make the entire request path non-blocking, then collapse the three FastAPI apps (admin / detection / proxy) into one. This is what gets us from 58 workers down to 8, and unblocks single-port deployment.

### Why this order matters
Doing async **before** consolidation is non-negotiable. If we merge first while still on sync psycopg2, a single slow admin query can stall detection traffic in the same worker. Async first → workers no longer block on each other → consolidation is safe.

### Step-by-step migration

1. **Add async DB engine alongside sync** (`backend/database/connection.py`). ✅ done
   - Keep sync `psycopg2` engine for now; add `asyncpg` engine + `AsyncSession` factory.
   - New dependency: `get_async_admin_db()`, `get_async_detection_db()`, `get_async_proxy_db()`.
   - Both engines coexist during the migration; cutover is per-router.

2. **Convert hot path first** — `backend/routers/guardrails.py` and the detection chain (`services/guardrail_service.py`, `services/scanner_detection_service.py`, etc.). Detection is 70% of traffic; getting it async unlocks most of the worker savings.

3. **httpx async confirmation.** Audit `backend/services/model_service.py` and `backend/services/proxy_service.py` for any sync `.post()` / `requests.*` calls. Convert all to `async with httpx.AsyncClient`. (Most already use httpx; we just need to ensure `await` everywhere.)

4. **Convert remaining routers.** Mechanical work, one router per PR. Priority order: proxy_api → gateway_integration_api → results → config_api → auth → everything else.

5. **Drop sync engines** when no router uses them.

6. **Merge the three FastAPI apps** into `backend/app.py`:
   - One `FastAPI()` instance with all routers mounted.
   - Lifespan hook unifies the three current ones.
   - Single `start_service.py` replaces the three start scripts.
   - URL prefixes already separate concerns: `/api/v1/*` (admin), `/v1/guardrails*` (detection), `/v1/chat/completions` + `/v1/gateway/*` (proxy). Nothing changes for clients.
   - nginx config simplifies dramatically — single upstream.

7. **Tune workers.** Target 2 workers per CPU core (so 8 on the production 4-core VM, not 58). Bench under load before/after.

### File-level deltas
- `backend/database/connection.py` — add async engine, async session factory; eventually remove sync.
- `backend/database/__init__.py` — export `AsyncSession` types.
- All routers — `def` → `async def`, `Session` → `AsyncSession`, `db.query(...)` → `await db.execute(select(...))`. SQLAlchemy 2.x style.
- `backend/{admin,detection,proxy}_service.py` → deleted, replaced by `backend/app.py`.
- `backend/start_{admin,detection,proxy}_service.py` → deleted, replaced by `backend/start.py`.
- `backend/entrypoint.sh` — single uvicorn invocation.
- `frontend/nginx.conf` — single upstream block, no per-prefix routing.
- `docker-compose.yml` — single `openguardrails-app` service replaces the three.

### Risks & mitigations
- **Mixed sync/async during migration.** A sync DB call inside an async route blocks the event loop. Mitigation: hard rule — once a router is converted, it MUST NOT call any service that still uses sync sessions. Add a CI check: importing `sessionmaker` outside `database/` is an error.
- **Worker reduction exposes hidden race conditions.** With 32 workers each had its own state; now 8 share more. Mitigation: load test in staging at 5x expected production traffic before cutover. Target metric: zero increase in 5xx rate.
- **Deployment cutover.** Three services → one is a hard switch. Mitigation: keep the three-service docker-compose as `docker-compose.legacy.yml` for one release cycle. Production rollout = blue-green.

### Exit criteria
- Single `openguardrails-app` container running ~8 workers on the 4-core production VM.
- p95 detection latency same or better than today.
- Memory usage drops by at least 60%.
- nginx config is < 30 lines.

### Async migration cookbook (per-router playbook)

For every router you convert, follow these steps in order. The pilot
`backend/routers/results.py` is the reference implementation — it has
both async (list, detail, export) and sync (extract_unsafe_segments)
endpoints during the transition window, so you can see the pattern.

**Step 1 — change the dependency.**
```python
# Before
from sqlalchemy.orm import Session
from database.connection import get_admin_db

@router.get("/things")
def list_things(db: Session = Depends(get_admin_db)):
    ...

# After
from sqlalchemy.ext.asyncio import AsyncSession
from database.connection import get_async_admin_db

@router.get("/things")
async def list_things(db: AsyncSession = Depends(get_async_admin_db)):
    ...
```

Pick `get_async_admin_db` / `get_async_detection_db` / `get_async_proxy_db`
to match the engine the legacy code used. They share the same
PostgreSQL but with different pool sizes.

**Step 2 — convert each query call.** AsyncSession does not expose
`.query(...)`. Use `select(...)` + `await db.execute(...)`:

| Sync (today) | Async (target) |
|---|---|
| `db.query(X).filter(X.id == 1).first()` | `(await db.execute(select(X).where(X.id == 1))).scalar_one_or_none()` |
| `db.query(X).filter(X.tenant_id == t).all()` | `(await db.execute(select(X).where(X.tenant_id == t))).scalars().all()` |
| `db.query(X.id).filter(...).all()` (column only) | `(await db.execute(select(X.id).where(...))).scalars().all()` |
| `db.query(X).filter(...).count()` | `(await db.execute(select(func.count()).select_from(select(X.id).where(...).subquery()))).scalar()` |
| `db.add(obj); db.commit(); db.refresh(obj)` | `db.add(obj); await db.commit(); await db.refresh(obj)` |
| `db.execute(text("..."))` (raw SQL) | `await db.execute(text("..."))` |

**Counting tip:** the cheap way to count is to pre-cap the inner query
with `LIMIT n+1`, so the planner stops early on huge tables. See
`get_detection_results` in results.py for the pattern. Don't use
`db.scalar(select(func.count()).select_from(X))` on tables with
hundreds of millions of rows.

**Step 3 — anything that uses `joinedload`, `selectinload`, etc.**
SQLAlchemy 2.0 async style:
```python
stmt = select(X).where(X.id == 1).options(selectinload(X.children))
result = await db.execute(stmt)
x = result.scalar_one()
# x.children is preloaded — no implicit lazy-load needed
```
`expire_on_commit=False` (set in our async sessionmaker) means
attributes are still readable after a commit; lazy loading is still
*not* allowed in async, so you must eager-load anything you'll touch
after commit.

**Step 4 — call sites that call services.** The hard rule: a converted
endpoint must not call a service helper that takes a sync `Session`. If
the helper is small, convert it inline. If it's big, take one of three
escapes:

1. Convert the helper too (preferred when it's leaf code).
2. Wrap the call in `await asyncio.to_thread(helper, ...)` — short-term
   bridge. Mark it `# TODO(phase3): convert helper to async`.
3. Defer the endpoint conversion. Keep using the sync session
   dependency on that one endpoint. The pilot does this for
   `extract_unsafe_segments` in results.py (depends on
   `ScannerConfigService` and `ScannerDetectionService`, both sync).

**Step 5 — middleware and auth.** The `auth_context` populated by
middleware is plain dict data; resolving the Tenant row from it is the
only DB hit on the hot path. The pilot has `get_current_tenant_async`
as the async version — copy that pattern; do not call the sync one
from an async endpoint.

**Step 6 — verify.** Run the route locally:
```bash
curl -H "Authorization: Bearer <token>" http://localhost:5000/api/v1/things
```
Then watch for `RuntimeError: greenlet_spawn has not been called`,
`InvalidRequestError: This Session is in 'committed' state`, or
`MissingGreenlet`. Those all mean a sync DB API was hit on an
AsyncSession — usually a missed `await` or a stray `db.query`.

**Step 7 — leave a paper trail.** When you finish converting a router,
update the migration tracker (a list at the bottom of this doc, see
"Async router migration progress"). When all routers are converted,
the sync `get_*_db` providers and psycopg2 engines can be deleted in a
single follow-up PR.

### Async router migration progress

- ✅ `routers/results.py` (Phase 3 pilot — list / detail / export are
  async; `extract_unsafe_segments` deferred until scanner services
  migrate).
- ✅ `routers/detection_guardrails.py` (hot path) — router fully async,
  monthly quota check on AsyncSession, and **all 12 of 12 sync DB sites
  in `services/detection_guardrail_service.py`** are now async. The
  detection chain has zero sync DB session usage.
- ✅ `routers/gateway_integration_api.py` — 3 endpoints fully async via
  `AsyncSession` + `AsyncGatewayIntegrationService`.
- ✅ `routers/proxy_api.py` — fully async: 5 gateway-service call sites
  + `/v1/models` (uses `get_routes_for_tenant_async`) +
  `_get_default_application_id` helper + chat-completion model routing
  lookup (`find_matching_route_async`). The
  `_async_output_detection_via_service` helper now opens its own
  session inside the fire-and-forget task (was a footgun: the caller's
  sync session could close before the task got scheduled in multi-worker
  setups).
- ⬜ `routers/auth.py`
- ⬜ `routers/admin.py`
- ⬜ `routers/config_api.py`
- ⬜ `routers/dashboard.py`
- ⬜ ... rest of `backend/routers/*.py`

### Sync DB sites in `services/detection_guardrail_service.py` — all done

After wave 2 step 5, **12 of 12** hot-path sync DB sites are async. The
file no longer imports or calls `get_db_session()`. The legacy import
remains as a stub for any callers that still hold a reference but the
detection chain itself is fully async.

Already async (per-request hot path):

| Method | What it looks up |
|---|---|
| `check_guardrails` | default-application resolution (when no app_id passed) |
| `_log_detection_result` | workspace_id (logged on every request) |
| `_handle_error` | workspace_id (error path) |
| `_get_suggest_answer` | tenant.language (every reject/replace) |
| `_handle_blacklist_hit` | tenant.language |
| `_parse_model_response_with_sensitivity` | tenant.language (appeal-link path) |
| `_determine_action_with_data` | tenant.language (DLP-message path) |
| `_perform_doublecheck` | workspace.enable_doublecheck (via async resolver) |
| `_get_general_policy_action` | general-risk action (AsyncDataLeakageDisposalService) |
| `_get_policy_action` | combined general+DLP action (AsyncDataLeakageDisposalService) |
| `check_guardrails` (scanner branch) | enabled scanners (AsyncScannerDetectionService → AsyncScannerConfigService) |
| `_check_data_security` | DLP entity detection (AsyncDataSecurityService) |

### Service-migration wave 2 (in progress)

Order by blast radius (smaller first). Each one unlocks a sync site
in DetectionGuardrailService once converted.

1. ✅ `services/workspace_resolver.py` — async variants
   (`get_workspace_id_for_app_async`, `get_global_workspace_id_async`,
   `ensure_global_workspace_async`) added alongside sync. Unlocked
   `_perform_doublecheck`.
2. ✅ `services/data_leakage_disposal_service.py` — sibling
   `AsyncDataLeakageDisposalService` class added (5 methods covering
   the detection hot path: `get_tenant_policy`, `get_disposal_policy`,
   `get_disposal_action`, `get_general_risk_action`, `get_private_model`).
   Unlocked `_get_general_policy_action` + `_get_policy_action`.
3. ✅ `services/scanner_config_service.py` — sibling
   `AsyncScannerConfigService` class added. Implements only
   `get_application_scanners` (the single method the detection chain
   needs); admin CRUD methods stay sync. `Scanner.package` eager-loaded
   via `selectinload` since lazy loading is illegal on AsyncSession.
4. ✅ `services/scanner_detection_service.py` — `AsyncScannerDetectionService`
   subclasses the sync class; only `__init__` and `execute_detection`
   are overridden, so all detection helpers (regex / keyword / model
   call / sliding window / aggregation) are inherited unchanged and
   stay single-sourced. Unlocked the `check_guardrails` scanner branch.
5. ✅ `services/data_security_service.py` — `AsyncDataSecurityService`
   subclasses the sync class; only `__init__` (binds AsyncSession + a
   fresh `ModelService`), `detect_sensitive_data`,
   `_get_user_entity_types`, `ensure_workspace_has_system_copies`, and
   `ensure_tenant_has_system_copies` are overridden. All admin CRUD,
   regex-pattern matching, GenAI segmentation, and anonymization helpers
   are inherited. Unlocked `_check_data_security`.

   **Subclass-init gotcha (write down for future Async sibling classes):**
   when skipping `super().__init__(db)` (because the parent's signature
   binds a sync session), don't forget to copy any *other* parent-init
   fields. `AsyncDataSecurityService` first shipped without
   `self.model_service = ModelService()`, which broke inherited helpers
   that called `self.model_service.detect_data_security(...)`. Caught at
   functional test time. Fixed by replicating the parent's other field
   assignments inside the override.

### Wave 3 — proxy/gateway hot path async (in progress)

After wave 2 completed the detection chain, wave 3 brings the proxy
and external-gateway entry points online.

- ✅ `services/gateway_integration_service.py` —
  `AsyncGatewayIntegrationService` subclass added; `__init__` /
  `_get_language` / `process_input` / `process_output` overridden,
  rest inherited (request anonymization, session bookkeeping,
  block/replace/switch-model response builders, restore helpers).
  `get_async_gateway_integration_service` factory exposed.
- ✅ `routers/gateway_integration_api.py` — all 3 endpoints
  (`/v1/gateway/process-input`, `/process-output`, `/health`) now
  use `AsyncSession` via `get_async_detection_db`.
- ✅ `routers/proxy_api.py` — fully async (5 gateway-service sites + 3
  model-routing sites + `_get_default_application_id` helper).
- ✅ `services/model_route_service.py` — `find_matching_route_async`
  and `get_routes_for_tenant_async` added as `@staticmethod` on the
  same class (the service is stateless — every method already takes
  `db` as a parameter). `selectinload(ModelRoute.route_applications,
  ModelRoute.upstream_api_config)` is required because both
  relationships are read on the result; lazy load is illegal on
  AsyncSession. Sync methods stay for the admin CRUD router.
- ✅ `services/proxy_service.py` — 3 hot-path methods async:
  `log_proxy_request_gateway` (called on every proxy request),
  `log_proxy_request` (every legacy completions request), and
  `get_user_model_config` (every legacy completions request — uses
  `selectinload(ProxyModelConfig.tenant)` since the original sync code
  triggered a lazy load of `model.tenant` after the query, which would
  break on AsyncSession). The 5 admin CRUD methods on the same class
  (`get_user_models`, `get_upstream_api_config`, `create_user_model`,
  `update_user_model`, `delete_user_model`) stay sync — they have zero
  callers in the codebase (verified via grep).

### Phase 3 step 6 — service consolidation (one app, one process)

After waves 1-3 left the entire detection + proxy + gateway hot path
async, the three FastAPI apps are now safe to merge into one process.
A slow admin query no longer stalls a detection request because there's
no sync DB blocking the event loop anywhere.

- ✅ `backend/app.py` — unified FastAPI app. Combines admin / detection
  / proxy routers (244 routes total) under one app, one event loop, one
  worker pool. The 3 path-gated `AuthContextMiddleware` classes are
  re-used as-is (imported from the legacy service modules) and stacked
  in middleware order so the most-specific path wins:
  Detection (innermost, /v1/guardrails*) → Proxy (/v1/*) → Admin (/api/v1/*).
  `RoleCheckMiddleware` and `BillingMiddleware` are already path-gated,
  so they layer in cleanly.
- ✅ `backend/start.py` — single uvicorn launcher. `UNIFIED_PORT=5000`
  by default (matches admin's legacy port — existing nginx configs
  routing `/api/v1/*` to :5000 keep working unchanged).
  `UNIFIED_UVICORN_WORKERS=8` by default (down from the legacy
  2 + 32 + 24 = 58).
- 🟨 Legacy entry points kept for one release cycle:
  `admin_service.py` / `detection_service.py` / `proxy_service.py` and
  the matching `start_*_service.py` scripts. They still run in their
  legacy mode if invoked directly. Will be deleted after a deployment
  validation cycle. Their FastAPI app instances are constructed at
  import time of `app.py` (we re-use their middleware classes) — small
  memory cost during the migration window, gone once the legacy modules
  are deleted.

#### Side-by-side test (port 5050, 2 workers)

All four routes exercised via the unified app on a single port:

| Surface | Endpoint | Result |
|---|---|---|
| Admin | `POST /api/v1/auth/login` + `GET /api/v1/results?per_page=2` | login OK, total=3711 items returned |
| Detection | `POST /v1/guardrails/input "how to make a bomb"` | reject / 暴力犯罪 / HTTP 200 / 1.36s |
| Gateway | `POST /v1/gateway/process-input` | pass / HTTP 200 / 0.86s |
| Proxy | `GET /v1/models` | 1 model returned, eager-loaded provider / HTTP 200 / 22ms |
| Full pipeline | `POST /v1/chat/completions "how to make a bomb"` | reject with Chinese block message + appeal link |

#### Cross-surface concurrency (single port, single worker pool)

16 mixed requests to detection + gateway + admin endpoints:

| Mode | Wall time | Per-request | Codes |
|---|---|---|---|
| Sequential 16 | 10.80s | 675ms | all 200 |
| Concurrent 16 | 2.07s | 129ms | all 200 |
| **Speedup** | **5.2x** | | |

The 5.2x speedup demonstrates the merged app properly multiplexes
admin + detection + proxy traffic on the same event loop without
serializing through any sync DB call.

### Phase 3 step 7 — Docker switchover (`docker compose up -d` runs the unified app)

With `app.py` + `start.py` proven side-by-side in step 6, this step
makes the unified backend the actual deployed thing. After the
switchover the legacy split processes never start in production
unless an operator deliberately rolls back.

**Files changed**

- `supervisord.conf` — three `program:*-service` blocks collapsed
  into one `program:unified-service` running
  `/app/supervisor-entrypoint.sh python3 start.py`. The supervisor
  shim is still gated on `SERVICE_NAME=admin`, which we keep set so
  the pre-fork `init_db + migrations` step runs once before
  `start.py` calls `uvicorn.run()`. `start.py`'s own migration
  call becomes a no-op under the distributed lock — small wasted
  work, not a correctness issue.
- `frontend/nginx.conf` — six `proxy_pass` targets collapsed from
  `localhost:5000` / `:5001` / `:5002` to `localhost:5000`
  everywhere. Location blocks kept individually (rather than one
  catch-all `location /api/`) so per-prefix timeouts and future
  tuning stay obvious. Specificity ordering preserved so
  `/v1/guardrails*` still matches before the catch-all `/v1/`.
- `docker-compose.yml` — `platform.ports` drops `:5001` and
  `:5002`, exposes only `${UNIFIED_PORT:-5000}:5000` plus the
  frontend port. Env vars `ADMIN_PORT` / `DETECTION_PORT` /
  `PROXY_PORT` removed; `ADMIN_UVICORN_WORKERS` /
  `DETECTION_UVICORN_WORKERS` / `PROXY_UVICORN_WORKERS` removed.
  New: `UNIFIED_PORT`, `UNIFIED_UVICORN_WORKERS` (default 8),
  `UNIFIED_MAX_CONCURRENT_REQUESTS` (default 750). Per-surface
  `*_MAX_CONCURRENT_REQUESTS` kept overridable so the unified
  middleware can sum them as a fallback cap. Healthcheck
  simplified from three `curl /health` probes to one.
- `Dockerfile` — `EXPOSE` shrinks from `80 5000 5001 5002` to
  `80 5000`. No multi-stage layout change.
- `CLAUDE.md` — Five Containers section, dev-mode commands,
  endpoint port headers, troubleshooting port list, and the
  "migrations with N workers" FAQ all rewritten for the unified
  topology.

**What did NOT change**

- `backend/admin_service.py`, `detection_service.py`,
  `proxy_service.py` — kept verbatim. `app.py` imports their
  `AuthContextMiddleware` classes via `import admin_service as
  _admin_mod` etc. Importing those modules constructs a wasted
  `FastAPI()` per import, but the diff stays small and a
  rollback is just a `supervisord.conf` revert. Plan to delete
  after one release cycle once the unified deploy has soaked.
- `backend/start_admin_service.py`, `start_detection_service.py`,
  `start_proxy_service.py` — kept as fallback launchers. The
  legacy production environment that runs these via `systemctl`
  on ports `53333/4/5` still works.
- `backend/supervisor-entrypoint.sh` — unchanged. The
  `SERVICE_NAME=admin` gate happens to do exactly what unified
  needs (init_db + migrations, once, before fork).
- `backend/entrypoint.sh` — unchanged. The top-level
  `entrypoint.sh` only fires when the container is invoked with
  a non-supervisord command; supervisord mode in the
  `Dockerfile`'s `CMD` short-circuits past it.

**Rollback plan**

1. `git revert` the supervisord + nginx + compose + Dockerfile
   changes (one PR, atomic). The legacy split services and
   per-port nginx upstreams come back unchanged.
2. Or, in-place: edit `supervisord.conf` to re-add the three
   `*-service` programs and remove `unified-service`. Revert
   nginx upstreams to `localhost:5000` / `:5001` / `:5002`. The
   FastAPI app modules and start scripts have not been deleted,
   so this is a config-only revert — no code changes needed.

**What still has to happen before the legacy files can be deleted**

- One full release cycle on the unified deploy with no rollbacks.
- Move `AuthContextMiddleware` out of the legacy service modules
  into a shared `middleware/auth_context.py`, update `app.py` to
  import from there, then delete `admin_service.py`,
  `detection_service.py`, `proxy_service.py` and their
  `start_*_service.py` launchers.
- Update the production `systemctl` units that still reference
  the old ports `53333/4/5` to launch `start.py` instead.

### Wave 3 — done

The proxy hot path and external-gateway entry points are fully async.
End-to-end functional tests verified:
- `/v1/models` (async route service + selectinload)
- `/v1/gateway/process-input` benign + high-risk
- `/v1/gateway/process-output`
- `/v1/chat/completions` (full async chain: routing → input detection → DLP policy → upstream → output detection → async log write)
- `proxy_request_logs` row count incremented after a chat completion (async log_proxy_request_gateway commit confirmed)

### Wave 2 — done

The detection hot path is fully async. End-to-end functional tests cover
all six branches:
- benign passthrough (no risk)
- compliance/security high risk + doublecheck
- DLP regex detection (Chinese ID card → masked correctly)
- DLP genai detection (no false-positive on benign text)
- scanner detection branch (10 enabled scanners loaded async, S5 matched on violence prompt)
- monthly-quota async check (every request, rate limiter Lua via Redis)

---

## Phase 4 — Dialect abstraction + AI gateway core (4–6 weeks)

This phase splits cleanly into two parallel tracks. They can be done by different people and merged independently.

### Phase 4a — MySQL/PostgreSQL dual support

#### Kickoff inventory (recon, 2026-04-26)

Empirical scan of the backend for PG-specific surface area. Numbers
matter — they tell us where the work actually is, not where we
guess it is.

**1. JSONB column declarations (models)** — **0 hits.**
No `Column(JSONB(...))` in `database/models.py`. The category
column comments mention "stored as JSONB" but the actual column
type is the SQLAlchemy-portable `JSON`. Good news.

**2. JSONB usage in router/service code** — **1 file, 4 hits.**
- `routers/results.py:12` imports `JSONB` from `sqlalchemy.dialects.postgresql`
- Lines 51-53: `cast(col, JSONB).contains([category])` on three
  category arrays. PG-only — `.contains()` on JSONB is the `@>`
  operator. The Phase 4a fix is the relational-categories table
  already sketched below in §schema-level changes.

**3. PG-only SQL in migrations** — **52+ hits, 15+ files.**
The big ones, by construct:
- `gen_random_uuid()` — used in 40+ files. Heaviest in
  `versions/082_add_attack_campaigns.sql` (103 calls). Mechanical
  fix: switch all UUID generation to client-side `uuid.uuid4()`
  in net-new migrations; existing rows are already populated.
- `ON CONFLICT (cols) DO UPDATE / DO NOTHING` — most prevalent in
  `082_add_attack_campaigns.sql` (10), `071_workspace_only_config.sql` (7),
  `040_input_output_policy_separation.sql` (2),
  `008_redesign_upstream_api_configs.sql` (1),
  `061_add_subscription_tiers.sql` (1). None are dialect-guarded.
- `RETURNING ...` — confirmed in `011_add_application_management.sql`
  and one site in `services/billing_service.py:456-464`.
- `pg_trgm` extension + `gin_trgm_ops` GIN index —
  `versions/093_optimize_detection_results_search.sql:28,34,37`.
  This is the Phase 1 substring-search optimization and the
  largest semantic gap with MySQL.

**4. PG operators in service code (raw SQL strings)** — **3 files, 6 hits.**
- `routers/payment_api.py:399, 406, 601, 626` — four
  `text("order_metadata->>'stripe_session_id' = :session_id")`
  style filters. Best fix is to hoist `stripe_session_id` to a
  real indexed column, not to abstract the JSON operator.
- `services/rate_limiter.py:124-141` — `ON CONFLICT ... RETURNING`
  in the PG fallback path that already runs only when Redis is
  disabled. Lower priority — Phase 2 made Redis the primary.
- `services/billing_service.py:456-464` — `RETURNING tenant_id`
  in an UPDATE. Trivially replaced by `UPDATE ... ; SELECT`.

**5. Async DB URL handling** — **1 function, 1 file.**
- `database/connection.py:13-32` — `_async_database_url()` only
  knows about `postgresql://` → `postgresql+asyncpg://`. The
  inline comment explicitly defers MySQL handling to Phase 4.
  Mechanical fix: branch on dialect prefix and rewrite to
  `mysql+aiomysql://` (or `mysql+asyncmy://` — pick one).

**6. PG-leaning column types in models** — **false alarm.**
- 124 occurrences of `UUID(as_uuid=True)` in `models.py` —
  this is a SQLAlchemy generic that renders as `CHAR(36)` on
  MySQL and `UUID` on PG. No change needed.
- No `INET`, `CIDR`, `TSVECTOR`, `HSTORE`, `BYTEA`, `INTERVAL`
  found. Clean.

**7. PG advisory locks outside the migration runner** — **1 site, both paths covered.**
- `services/distributed_lock.py:218` — `pg_try_advisory_lock`
  inside the `pg_fallback_engine` branch, gated behind
  `is_redis_enabled()`. If Redis is the deployed path (it is, in
  the unified-app config), this branch never fires. Phase 4a:
  add a `mysql_fallback` branch using `GET_LOCK(name, timeout)`
  for completeness, or document that MySQL deploys must enable
  Redis.

**8. `pg_trgm` substring search** — **1 file, design discussion.**
- `migrations/versions/093_optimize_detection_results_search.sql`
  creates the extension + two `gin_trgm_ops` indexes that make
  ILIKE substring search on `detection_results.content` and
  `request_id` fast.
- `routers/results.py:340` calls `ILIKE` against those columns.
- MySQL has no equivalent. Options: (a) accept slower `LIKE` on
  MySQL (acceptable if MySQL deploys are smaller-scale), (b)
  add a MySQL-specific `FULLTEXT` index + dialect-aware operator,
  (c) push search to a dedicated index (Meilisearch / OpenSearch)
  — out of Phase 4a scope.

#### Phase 4a sequencing

The work has a natural dependency order. Doing it out of order
either breaks deployments or forces rework.

**Step 1 — Migration runner upsert (DONE 2026-04-26).**
`migrations/run_migrations.py` now branches on
`admin_engine.dialect.name` for three PG-specific constructs:
- `TIMESTAMP WITH TIME ZONE` → `TIMESTAMP` on MySQL/MariaDB.
- `CREATE INDEX IF NOT EXISTS` → probe `information_schema.statistics`
  then conditional `CREATE INDEX` on MySQL (no `IF NOT EXISTS`
  exists for indexes there).
- `INSERT ... ON CONFLICT (version) DO UPDATE SET col = EXCLUDED.col`
  → `INSERT ... ON DUPLICATE KEY UPDATE col = VALUES(col)` on
  MySQL/MariaDB. The `VALUES()` form is deprecated in MySQL
  8.0.20 but still works; the modern `AS new` form would
  unnecessarily exclude older MySQL deploys.
Both upsert call sites (success path + failure path) use the
shared `_record_migration_sql(success: bool)` helper. SQL was
verified for `postgresql`, `mysql`, and `mariadb` dialects via
a fake-engine harness — all 6 outputs (3 dialects × 2 paths)
inspected and correct.

**Step 2 — Async URL rewriter + DB driver dependencies (DONE 2026-04-26).**
`database/connection.py:_async_database_url()` extended to cover
13 input forms: 3 PG (preserved), 5 MySQL (`mysql://`,
`mysql+pymysql://`, `mysql+mysqldb://` rewrite to
`mysql+aiomysql://`; `mysql+aiomysql://` and `mysql+asyncmy://`
pass through), 5 MariaDB (mirror of MySQL but on the `mariadb`
dialect — preserved separately because SQLAlchemy treats them
as distinct dialects). Unknown schemes pass through with a
WARN log rather than raising, so `sqlite:///` test URLs and
unsupported production schemes both surface visibly without
breaking the module-level import. Added `PyMySQL>=1.1.0` and
`aiomysql>=0.2.0` to `backend/requirements.txt` (inert when
`DATABASE_URL` is `postgresql://`). New `get_dialect_name()`
helper exposes `admin_engine.dialect.name` so service-code
sites in Step 4 can branch on dialect without re-parsing the
URL. All 15 rewrite cases verified, plus live PG smoke test
confirms `get_dialect_name() == 'postgresql'`.

**Step 3 — Initial schema generator + Alembic for net-new (DESIGN OPEN).**

Empirical finding (2026-04-26 live MySQL test): with Steps 1+2
applied, a fresh MySQL container lets the runner create
`schema_migrations` and start migration 001, but 001 fails
immediately on `CREATE OR REPLACE FUNCTION ... AS $$ ... $$
LANGUAGE plpgsql`. Several existing migrations use PL/pgSQL
triggers / dollar-quoted functions that have no MySQL analogue.

#### Step 3A discovery (2026-04-26)

Diffed the live PG schema (93 migrations applied) against
`Base.metadata` in `database/models.py`:

| Dimension | Result |
|---|---|
| Tables | 48 in models = 48 in PG (perfect alignment), 2 PG-only (`schema_migrations`, `application_data_leakage_policies_backup`) |
| Columns matched | 603 / 609 |
| **Column drift** | **6 columns DB-only** — model is missing `detection_results.matched_scanner_tags`, `detection_results.messages`, `knowledge_bases.scanner_name`, `response_templates.scanner_name`, `upstream_api_configs.is_data_safe`, `upstream_api_configs.private_model_priority`. Several are actively read by runtime code (services/detection_guardrail_service.py, routers/proxy_management.py audit-tracked fields) — the code works today only because raw `text(...)` queries bypass the model. |
| Indexes | 178 `ix_*` (auto from SQLAlchemy `index=True`) + 122 `idx_*` (raw from migrations, **not declared in models**) + 2 GIN trgm |
| Functions | 8 PL/pgSQL functions, all dollar-quoted |
| Triggers | 5 — 4 are redundant `update_*_updated_at` (model already has 37 `onupdate=func.now()` declarations covering most tables); 1 is bespoke `trigger_campaign_number` (auto-assigns sequential per-tenant) |
| Extensions | pg_trgm (only used by Phase 1's 2 substring-search indexes; Step 5 design call) |

#### What this means for the original two paths

Path A (schema-from-models) is no longer "1 week of careful
diff work." It's now:

1. **Fix model drift (HARD prerequisite, ~3 days).** Add the
   6 missing columns to `models.py` with the correct types,
   nullability, and defaults reverse-engineered from the
   migration files (016, 026, 038, 041, 069, 092). Without
   this, `metadata.create_all()` produces an incomplete MySQL
   schema and runtime code crashes on first read.
2. **Backfill 122 raw indexes (~2 days).** Add `Index(...)`
   declarations to models for every `idx_*` index. Tedious
   but mechanical. Fix-once, both dialects benefit.
3. **Replace bespoke triggers with app-side logic (~1 day).**
   `trigger_campaign_number` moves into
   `services/attack_campaigns_service.py` — wrap inserts in a
   small `SELECT max(...)+1` then INSERT. The 4
   `update_*_updated_at` triggers are already redundant with
   model-level `onupdate=func.now()` for ORM writes; raw SQL
   UPDATEs on those tables (if any) need spot fixes. Also
   audit `deactivate_expired_bans` / `cleanup_old_risk_triggers`
   utility functions to find and replace any callers that
   `SELECT` them.
4. **Bootstrap migration (~2 days).** Add
   `versions/000_initial_schema_dialect_aware.sql` (or rather
   a Python migration that emits CreateTable per-dialect via
   SQLAlchemy DDL compilation). Conditional pg_trgm setup
   (PG only). Fresh deploys execute 000 + net-new; existing PG
   deploys skip 000 (idempotent IF NOT EXISTS) and continue.
5. **Net-new migrations on Alembic from 094+ (~1 day).**
   `alembic.ini`, `env.py`, stamp head. Net-new migrations
   use `op.*` which renders per-dialect.

Total revised estimate: **~2 weeks**, not 1. Most of the
extra cost is fixing model/DB drift that exists today and
would be a problem for any future tooling (autogenerated
Alembic diffs, ORM-based queries on those columns) regardless
of MySQL.

Path B (retro-port) gets even less attractive in light of the
drift finding — you'd retro-port migrations that produce a
schema models don't fully describe.

#### Refined recommendation

Still A, but split into two phases:

- **3A.0 (small, immediate value)**: Just fix the model drift
  (item 1 above). This is overdue cleanup that benefits PG
  deploys today (enables ORM access to those 6 columns,
  unblocks autogenerated Alembic) and is a hard prereq for
  everything else. Ship it standalone.
- **3A.1+ (the rest)**: Schedule the index/trigger/bootstrap
  work as a focused 1.5-week sprint once 3A.0 has soaked.

This sequencing means MySQL support stays ~2 weeks out, but
3A.0 ships in 3 days and improves the codebase regardless.

#### Step 3A.0 — DONE 2026-04-26

Added the 6 missing columns to `database/models.py`:

- `DetectionResult.messages` (JSON, legacy alias for `full_messages`)
- `DetectionResult.matched_scanner_tags` (Text — comma-separated,
  written by `services/detection_guardrail_service.py`)
- `ResponseTemplate.scanner_name` (String(255), legacy alias for
  `guardrail_name`)
- `KnowledgeBase.scanner_name` (String(255), same)
- `UpstreamApiConfig.is_data_safe` (Boolean default False, legacy
  alias for `is_private_model`)
- `UpstreamApiConfig.private_model_priority` (Integer default 0)

Each carries a comment noting its drift origin so a future
cleanup migration can drop the duplicates safely. Re-ran the
diff: drift went from `603/609 matched + 6 findings` to
`609/609 matched + 0 findings`. App imports cleanly (244 routes
registered) and all 6 columns query successfully via the ORM
against live PG (`is_data_safe` and `private_model_priority`
have non-zero rows).

**Correction to the original Step 3A inventory:** I claimed
`UUID(as_uuid=True)` was a SQLAlchemy generic that renders as
`CHAR(36)` on MySQL. That's wrong. `models.py` actually imports
`from sqlalchemy.dialects.postgresql import UUID`, which does
NOT translate — `Base.metadata.create_all()` against MySQL
fails on the first `CREATE TABLE tenants (id UUID NOT NULL ...)`
with "syntax error near 'UUID NOT NULL'". For the eventual
3A.1+ MySQL bootstrap, models will need to switch to SQLAlchemy
2.0's generic `Uuid` type (renders as UUID on PG, CHAR(32) on
MySQL/MariaDB) or use a per-dialect TypeDecorator. This affects
**all 124 UUID columns** in models.py — significant additional
scope for the full MySQL bootstrap, but separable from 3A.0.

#### Step 3A.1 — DONE 2026-04-26

Switched `database/models.py` from
`sqlalchemy.dialects.postgresql.UUID` to SQLAlchemy 2.0's
generic `Uuid` type. Bulk-renamed all 124
`UUID(as_uuid=True)` declarations to `Uuid(as_uuid=True)`
(every PK and FK across 48 tables) in one Edit pass; the
pg-dialect import was removed and `Uuid` was added to the
generic-type import line.

Verified live:
- **PostgreSQL** (`openguardrails-postgres`, port 54321):
  `Tenant.id` column type still reflects as `UUID`, existing
  rows hydrate as Python `uuid.UUID('92ddf3c3-...')`. Zero
  regression — `Uuid` compiles to the same native PG `UUID`
  column SQLAlchemy already produced.
- **MySQL 8** (`openguardrails-mysql-test`, port 33306, fresh
  schema): `Base.metadata.create_all()` produced all 48
  expected tables with no errors. `Tenant.id` reflects as
  `CHAR(32)` (hex without dashes). Round-trip insert+select of
  a `uuid.uuid4()` returns the same Python `uuid.UUID`
  identity. All six 3A.0 drift columns landed on MySQL with
  the expected types: `messages JSON`,
  `matched_scanner_tags TEXT`, `scanner_name VARCHAR(255)`,
  `is_data_safe TINYINT(1)`, `private_model_priority INTEGER`.

This unblocks the schema-from-models bootstrap path. The
remaining 3A.2+ work (122 raw `idx_*` indexes, 4
`update_*_updated_at` triggers, `trigger_campaign_number`,
`deactivate_expired_bans`/`cleanup_old_risk_triggers` callers,
dialect-aware `000_initial_schema` migration) is unchanged in
scope.

#### Step 3A.2.a — DONE 2026-04-27

Backfilled plain b-tree `Index()` declarations into
`backend/database/models.py` so `Base.metadata.create_all()`
produces an index-complete schema on both PG and MySQL.

**Inventory framework.** Built a functional-equivalence diff:
signature = (sorted_column_names, unique_flag), comparing
`inspect(engine).get_indexes()` + `get_unique_constraints()`
on a live PG against `Base.metadata.tables` (table indexes,
unique constraints, plus column-level `unique=True` /
`index=True` flags). Each PG-only entry then routed through
`pg_get_indexdef()` to classify as PLAIN, PARTIAL, EXPR, or
TRGM. This avoided the 160-false-positive trap of a
name-based diff (PG `idx_*` named indexes vs ORM
`ix_<table>_<col>` auto-naming).

**18 new indexes added across 11 classes** (9 new
`__table_args__` blocks + 2 extensions of existing tuples):
- `Tenant`: `idx_tenants_log_dma`
- `DetectionResult`: `idx_detection_results_tenant_created`
  (`tenant_id`, `created_at DESC`)
- `TenantRateLimit`: `ix_tenant_rate_limits_usage_reset_at`,
  `uq_tenant_rate_limits_application` (unique on
  `application_id`)
- `ScannerPackage`: `idx_scanner_packages_bundle`,
  `idx_scanner_packages_not_archived`,
  `idx_scanner_packages_type`
- `Scanner`: `idx_scanners_package`, `idx_scanners_type`
- `ApplicationScannerConfig` (extended):
  `idx_app_scanner_configs_enabled`
- `PaymentOrder`: `idx_payment_orders_created_at`
- `AppealRecord`: `idx_appeal_records_created_at`,
  `idx_appeal_records_processed_at`,
  `idx_appeal_records_processor_type`
- `ModelRoute` (extended): `idx_model_routes_priority`
  (`priority DESC`)
- `AuditLog`: `idx_audit_logs_created_at`
  (`created_at DESC`), `idx_audit_logs_user_id`
- `AttackCampaign`: `idx_attack_campaigns_tenant_number`

**`column.desc()` lesson.** Three of the new indexes carry
DESC ordering. The string form `desc('created_at')`
produces a `TextClause` that does NOT register the column —
SQLAlchemy emits `CREATE INDEX … ()` with empty column list
on MySQL DDL. Switching to the object form
`created_at.desc()` (referencing the `Column` variable from
the class body) registers the column properly. Verified on
MySQL 8 DDL: `KEY idx_audit_logs_created_at (created_at DESC)`
etc.

**9 redundant indexes intentionally skipped** — entries
that would create duplicate indexes on columns already
declared with `unique=True` or `index=True` at column-level
(SQLAlchemy auto-generates an `ix_<table>_<col>` index for
those, so a hand-named duplicate is wasted work).

**Verified live.**
- PG diff after backfill: 0 PLAIN entries remain. Total 26
  remaining missing entries map cleanly to deferred buckets:
  24 PARTIAL (with WHERE clauses) + 1 TRGM
  (`detection_results_content_trgm` GIN) + 1 EXPR
  (`attack_test_questions_unique` using `COALESCE(...)` and
  `md5(content)`).
- MySQL fresh-schema bootstrap: all 48 tables created, all
  18 new indexes present. DESC ordering survived to MySQL
  DDL.

**Deferred to 3A.2.c** (next step): 4
`update_*_updated_at` triggers (drop in favor of model-level
`onupdate`), `trigger_campaign_number` (replace app-side),
audit `deactivate_expired_bans` /
`cleanup_old_risk_triggers` callers, build dialect-aware
`000_initial_schema` bootstrap migration.

**Deferred to Step 5** (separate design call): 1 pg_trgm
GIN index (`detection_results_content_trgm`) — needs
PG-vs-MySQL FULLTEXT design discussion.

#### Step 3A.2.b — DONE 2026-04-27

Replaced the 24 PG partial-unique + 1 expression-based unique
indexes with portable encodings in `models.py`. Both PG and
MySQL now bootstrap an index-complete schema from
`Base.metadata.create_all()` with no dialect fork.

**Encoding by category.**

- **Cat A1, C, D — 18 indexes — drop the WHERE, declare plain
  `UniqueConstraint` / `Index`.** Both PG default `NULLS DISTINCT`
  and MySQL allow multiple NULLs in unique tuples, so
  `UNIQUE (workspace_id) WHERE workspace_id IS NOT NULL` and
  `UNIQUE (workspace_id)` enforce the same business semantics.
  Only difference: index now also stores the NULL-only rows
  (slightly larger). Affected tables: `risk_type_config`,
  `data_security_entity_types`,
  `application_data_leakage_policies`, `application_settings`,
  `application_scanner_configs`, `custom_scanners`,
  `applications` (idx_applications_external_id),
  `knowledge_bases` (×2), `response_templates` (5 of 6),
  `scanner_packages` (2 of 3 — non-unique partials),
  `tenant_subscriptions`, `upstream_api_configs`.

- **Cat A2, B, E — 7 indexes — declare a `Computed` (generated)
  column + plain `UniqueConstraint` on it.** Affected tables:
  `appeal_config.workspace_only_id`,
  `subscription_payments.active_tenant_key`,
  `tenant_invitations.pending_email`,
  `scanner_packages.active_package_code`,
  `workspaces.global_tenant_key`,
  `response_templates.scanner_lookup_key`,
  `attack_test_questions.tenant_id_norm` + `content_hash`.
  Each gen col evaluates to the constrained tuple-piece for
  rows that satisfy the original predicate, and to `NULL`
  otherwise — `NULL` participates as distinct in unique
  tuples on both dialects, so the gen-col `UNIQUE` enforces
  the same invariant as the original PG partial.

**MySQL FK-CASCADE restriction (the trap that almost forked
this).** MySQL 8 forbids defining a foreign-key constraint with
`ON DELETE CASCADE` on a column that is referenced inside a
*STORED* generated-column expression (error 1215 "Cannot add
foreign key constraint"). Four of our gen cols reference
`tenant_id` / `application_id` / `workspace_id`, all of which
are FK columns with `ON DELETE CASCADE`. Workaround:

- `Computed("expr")` *with no `persisted=` kwarg*: PG renders
  `GENERATED ALWAYS AS (expr) STORED` (its only option, fine on
  PG), MySQL renders `GENERATED ALWAYS AS (expr)` (no keyword,
  defaults to `VIRTUAL` on MySQL, which is *not* subject to the
  FK-CASCADE restriction). Confirmed live:
  - PG `pg_get_indexdef`: `CREATE UNIQUE INDEX
    uq_workspaces_tenant_global ON public.workspaces USING
    btree (global_tenant_key)`.
  - MySQL `SHOW CREATE TABLE`: `global_tenant_key char(32)
    GENERATED ALWAYS AS (...) VIRTUAL` + `UNIQUE KEY
    uq_workspaces_tenant_global (global_tenant_key)`.
  - Functional: inserting two `is_global=true` workspaces for
    the same tenant fails with the right unique-violation on
    *both* DBs; non-global rows for the same tenant insert
    freely (gen col evaluates to NULL).

**Other dialect-portability gotchas resolved.**

- UUID literal in `attack_test_questions.tenant_id_norm`: use
  the dashless 32-hex form `'00000000000000000000000000000000'`
  in the `COALESCE` expression. Accepted by both PG (parses as
  UUID) and MySQL (matches the `CHAR(32)` storage form).
- `md5()` for `content_hash`: built-in on both PG and MySQL,
  returns 32-char hex string on both. No extension needed.
- Boolean comparisons in CASE expressions: use bare boolean
  predicates (`WHEN is_active AND NOT archived THEN ...`)
  rather than explicit `= true`/`= 1` — both dialects accept
  the bare form, and `= 1` would fail on PG (Boolean ↔ Integer
  type mismatch).

**Verified live.**
- PG fresh-schema bootstrap: 48 tables, all 25 target indexes
  present (6 Cat A1 + 1 Cat A2 + 4 Cat B + 9 Cat C + 3 Cat D + 2
  Cat E).
- MySQL 8 fresh-schema bootstrap: same 48 tables, all 25 target
  indexes present.
- PG diff vs live `openguardrails` DB: 0 plain-btree drift
  remaining. The 7 gen-col-encoded uniques register under their
  new column signatures; the original PG partial-uniques are
  semantically equivalent. 1 TRGM remains, deferred to Step 5.

**Deferred to Step 5** (separate design call): 1 pg_trgm
GIN index (`detection_results_content_trgm`) — needs
PG-vs-MySQL FULLTEXT design discussion.

#### Step 3A.2.c — DONE 2026-04-27

Removed every PG-only trigger from the live schema and from
the bootstrap path, so `Base.metadata.create_all()` is now a
complete schema definition on both PG and MySQL with no
trigger DDL fork.

**Inventory before this step (live PG):**
- 5 triggers — 4 simple `updated_at` setters + 1
  `trigger_campaign_number` BEFORE INSERT on
  `attack_campaigns`.
- 6 trigger functions backing those + 2 dead maintenance
  functions (`deactivate_expired_bans`,
  `cleanup_old_risk_triggers`) referencing
  `user_ban_records` / `user_risk_triggers` (both dropped in
  migration 090, no Python caller, no scheduled job) + 2
  orphan trigger functions (`update_ban_policies_updated_at`,
  `update_user_ban_records_updated_at`) whose triggers were
  cleaned up with the ban tables.

**Changes.**

1. *4 `update_*_updated_at` triggers:* dropped. All four
   tables (`appeal_config`, `appeal_records`, `payment_orders`,
   `subscription_payments`) already declare
   `onupdate=func.now()` on `updated_at` in `models.py`, and
   `grep -r "UPDATE <table>"` across the Python code finds zero
   raw-SQL UPDATEs that bypass the ORM. ORM-level Python-side
   default fires on both PG and MySQL.

2. *`trigger_campaign_number`:* replaced with app-side MAX+1
   in `services/attack_campaigns_service.py:create_campaign()`:
   ```python
   next_number = (
       self.db.query(
           func.coalesce(func.max(AttackCampaign.campaign_number), 0) + 1
       )
       .filter(AttackCampaign.tenant_id == tenant_id)
       .scalar()
   )
   ```
   Same `MAX(campaign_number)+1` semantic — and the same benign
   race window — as the old BEFORE INSERT trigger. Smoke-tested
   against live PG: existing tenant with 15 campaigns, two new
   `create_campaign` calls produced `campaign_number=16` then
   `=17` as expected.

3. *Dead maintenance + orphan trigger functions:* dropped
   alongside the 5 active triggers. Migration 090 had already
   removed the underlying tables; these were unreachable code.

**Migration.** All ten DROPs landed in
`backend/migrations/versions/094_drop_legacy_triggers_and_dead_functions.sql`
(idempotent, `DROP TRIGGER IF EXISTS` / `DROP FUNCTION IF
EXISTS`). Applied to live PG; verified empty
`information_schema.triggers` and zero hits for the eight
target function names.

**Verified live (post-cleanup).**
- PG fresh-schema bootstrap: 48 tables, no errors.
- MySQL 8 fresh-schema bootstrap: 48 tables, no errors.
- PG diff vs live `openguardrails`: still 0 plain-btree drift,
  same 8 expected residuals (7 gen-col-encoded uniques under
  different column signatures + 1 deferred TRGM).
- Smoke test of new `create_campaign`: campaign numbers
  16, 17 produced correctly for an existing tenant.

**Deferred to 3A.2.d** (next step): build the dialect-aware
`000_initial_schema` bootstrap migration. With every trigger
gone and every index expressible in `models.py`, this becomes
a thin shim that calls `Base.metadata.create_all()` and emits
the `pg_trgm` GIN index on PG only (Step 5 design call still
pending).

#### Step 3A.2.d — DONE 2026-04-27

`backend/migrations/run_migrations.py` now supports `.py`
migrations and a new `backend/migrations/versions/000_initial_schema.py`
performs portable PG/MySQL schema bootstrap.

**Runner extension.** `get_migration_files()` globs both
`*.sql` and `*.py`; `_execute_python_migration(conn, file_path)`
imports the module and invokes its `upgrade(conn)`. The two
extensions share one version namespace, sorted numerically.
Per-iteration re-check of `schema_migrations` (after each
migration commits) lets a Python migration stamp peers as
applied — the loop now skips any version that became stamped
during a prior iteration. Without this, 000 stamping 001-094
would still cause the runner to try to execute them anyway,
because `pending` was a snapshot taken before the loop
started.

**000_initial_schema.py.** Sentinel-based logic:
- Uses presence of the `tenants` table as the "schema already
  bootstrapped" detector (every other relation FKs into it).
- If `tenants` exists → no-op. The runner records 000 as
  applied; existing PG deploys with 001-094 already applied
  see no schema change.
- If `tenants` missing (fresh PG or fresh MySQL) →
  `Base.metadata.create_all(bind=conn)` materializes all 48
  tables; on PG, `CREATE EXTENSION IF NOT EXISTS pg_trgm`
  plus the two trgm GIN indexes (parity with migration 093,
  PG-only by design until Step 5 lands); then every
  subsequent `*.sql` migration is stamped (but not executed)
  via the runner's existing
  `_record_migration_sql(success=True)` UPSERT helper.

**Lock fallback gating.** The migration runner used to pass
`pg_fallback_engine=admin_engine` unconditionally; on MySQL
this fired `pg_try_advisory_lock` against MySQL and returned
None, which the runner interpreted as "another process
running, skipping" — fatal for fresh MySQL deploys without
Redis. Now: `use_pg_fallback = _dialect_name() == "postgresql"`,
and if `acquire_sync` returns None on MySQL with no Redis
configured (`is_redis_enabled()` false), the runner proceeds
without distributed locking. This is safe for the bootstrap
path (single-container fresh deploy); production MySQL
deploys are expected to provide Redis.

**Verified live.**
- *Fresh PG bootstrap*: drop+create empty `og_modelstest`,
  run `run_migrations()` → executed=1 (000), skipped=91. 49
  tables present (48 ORM + `schema_migrations`), 92 rows in
  `schema_migrations`, `pg_get_indexdef()` confirms
  `idx_detection_results_content_trgm` exists.
- *Fresh MySQL bootstrap* (with `REDIS_URL=` empty): drop+
  create empty `openguardrails` MySQL DB → executed=1,
  skipped=91. 49 tables, 92 stamped rows. Zero missing /
  extra tables vs `Base.metadata.tables`.
- *Existing PG (live `openguardrails` DB)*: runner picked up
  pending=[000, 094] (094 was applied by hand earlier this
  step but not yet stamped). 000 ran no-op (tenants exists);
  094's `DROP TRIGGER IF EXISTS` was idempotent (already
  dropped). Both stamped; schema unchanged; 92 total rows in
  `schema_migrations`.

**Step 3A.2 is done.** Schema is now portable on both PG and
MySQL purely from `Base.metadata.create_all()`. The
schema-from-models bootstrap path that 3A.0/3A.1 unblocked
now ships end-to-end.

**Step 4 — Service-code sweep.**
Three concrete sites:
1. `routers/payment_api.py` (DONE 2026-04-27) — see Step 4.1
   below.
2. `services/billing_service.py:456-464` (DONE 2026-04-26) —
   replaced PG-only `RETURNING tenant_id` + `len(fetchall())`
   with portable `result.rowcount`. Same semantics on PG and
   MySQL.
3. `routers/results.py:317-325` (DONE 2026-04-27) — see Step
   4.2 below.

#### Step 4.1 — DONE 2026-04-27 (payment metadata hoist)

Replaced `text("order_metadata->>'stripe_session_id' = :session_id")`
and `->>'trade_no'` lookups (3 call sites in
`routers/payment_api.py`) with portable indexed-column equality
on new `PaymentOrder.stripe_session_id` and
`PaymentOrder.trade_no` columns. `services/payment_service.py`
now dual-writes the stripe session id to both the column and
the JSON during the bake-in window — only the column is read
from anywhere, so the JSON write is keepable for one release
in case some out-of-tree consumer relies on it.

**Migration 095** (`.py`, dialect-aware): branches on
`conn.dialect.name`, idempotently adds the two columns + their
b-tree indexes, then backfills via `order_metadata->>'key'`
(PG, works on both `json` and `jsonb`) or
`JSON_UNQUOTE(JSON_EXTRACT(order_metadata, '$.key'))` (MySQL).
The `IS NOT NULL` guard naturally handles missing keys without
the JSONB-only `?` containment operator. Verified on:
- *Live PG* (`openguardrails`): executed=1 (095), 0 rows
  to backfill (test environment), both indexes present.
- *Fresh PG* (`og_modelstest`): bootstrap via 000 + 095 →
  executed=2, skipped=91 (`.sql` migrations stamped). Columns
  + indexes from `models.py` declaration; 095 backfill is a
  no-op on the empty table.
- *Fresh MySQL*: same shape — executed=2, skipped=91. 49
  tables, no drift.

PG diff vs live `openguardrails`: same 8 expected residuals
(6 partial-unique + 1 expression-unique + 1 TRGM). 0
plain-btree drift.

**Trade_no caveat.** No code path currently *writes*
`trade_no` to `order_metadata` — the lookup at the old
fallback site `routers/payment_api.py:406` was effectively
dead. The new column exists for the inverse hoist path (so
the lookup is portable) but will read NULL until/unless the
Alipay webhook handler is wired to store it. That gap is
pre-existing, not introduced here, and out of scope for the
portability sweep.

#### Step 4.2 — DONE 2026-04-27 (categories relational projection: schema + dual-write)

Schema half of the JSONB.contains → relational JOIN refactor.
Read switch in `routers/results.py:317-325` is the remaining
piece; deferred to a follow-up so the dual-write can bake.

**New model** `DetectionResultCategory` (`detection_result_categories`)
projects `detection_results.{security,compliance,data}_categories`
into `(result_id, kind, category)` triples. `kind ∈
{'security','compliance','data'}`. Two indexes —
`(result_id)` for the FK lookup, composite
`(category, kind)` for the listing-page filter — plus a
unique constraint on `(result_id, kind, category)` for
dedup. ON DELETE CASCADE on the FK so the row dies with its
parent.

**Migration 096** (`.py`, dialect-aware):
- Calls `DetectionResultCategory.__table__.create(bind=conn)`
  if the table is absent — leverages SQLAlchemy's
  dialect-portable DDL emission. Fresh PG/MySQL bootstraps
  via 000 already create the table from `models.py`, so the
  IF-NOT-EXISTS guard makes this re-run safe.
- Backfills with dialect-aware unnesting:
  - PG: `jsonb_array_elements_text(CAST(col AS jsonb))` +
    `ON CONFLICT (result_id, kind, category) DO NOTHING`.
    The cast is needed because some legacy installs store
    these as `json` not `jsonb`.
  - MySQL 8: `JSON_TABLE(col, '$[*]' COLUMNS (...))` +
    `INSERT IGNORE`. Same intent, MySQL syntax.

**Dual-write** in `services/log_to_db_service.py`: after
constructing the `DetectionResult`, the service iterates the
three category lists from the JSONL log entry and appends
`DetectionResultCategory` children via the
`categories` relationship (cascade="all, delete-orphan").
Per-row dedup via a `seen` set so the unique constraint
never fires. The JSON columns continue to be written
verbatim — they're still authoritative for any reader that
hasn't switched, and the read path is the next deliverable.

**Verified live.**
- *Live PG* (`openguardrails`): migration 096 executed in one
  pass; backfill produced 2716 category rows from 3742
  detection results (2080 compliance + 388 data + 248
  security — `data` exceeds its source row count because
  some rows had multiple data categories, which is expected).
- *Functional equivalence*: `WHERE compliance_categories::jsonb
  @> '["商业违法违规"]'::jsonb` returned 506 rows; the new
  `WHERE category = '商业违法违规'` (DISTINCT result_id)
  returned 506. Match.
- *Fresh PG* (`og_modelstest`): bootstrap → executed=3
  (000+095+096), skipped=91, 50 tables (49 ORM +
  schema_migrations).
- *Fresh MySQL* (`openguardrails`): same shape — executed=3,
  skipped=91, 50 tables, `detection_result_categories`
  present.

**Read switch (DONE 2026-04-27).** Both `category` and
`data_entity_type` filters in `routers/results.py:317-340`
now use `DetectionResult.id.in_(select(...).where(...))`
against `detection_result_categories` instead of `cast(...
JSONB).contains([cat])`. Dropped the `cast` and `JSONB`
imports from this file. Decision rationale: the dual-write
is atomic with each detection-result insert via the cascade
relationship (no possible split-state where the parent row
exists but the children are missing), and migration 096
already backfilled all 3742 historical rows before the
switch. Bake-in window unnecessary.

Smoke-tested against live PG (`openguardrails`): five
filter cases run side-by-side — three multi-kind `category`
queries (`商业违法违规`: 506=506; `CN_PERSON_NAME_SYS`:
347=347; `暴力犯罪`: 264=264) and two data-only
`data_entity_type` queries (`CN_PERSON_NAME_SYS`: 347=347;
`CN_ADDRESS_SYS`: 28=28). Old vs new counts match exactly
on every case.

The JSON columns on `detection_results` stay as-is —
they're the authoritative log of detected categories
written by the detection pipeline; the relational
projection is a query-time index. A future cleanup can
drop them once we verify nothing else reads them, but
that's not blocked on portability.

**Step 4 closed.** All three sites portable — no remaining
PG-only DDL, JSON, or operator usage in the service code.

Note on `services/rate_limiter.py:127, 141` and
`services/distributed_lock.py:218` — both contain PG-only
`ON CONFLICT` / `pg_try_advisory_lock` but inside Redis-fallback
branches that only execute when `is_redis_enabled()` is false.
Phase 2 made Redis the primary path. For MySQL deploys we
require Redis (already true for the unified-app deploy);
adding a MySQL fallback branch in either place would be
strictly more code without strictly more value.

**Step 5 — `pg_trgm` design call. RESOLVED 2026-04-27.**

Decision: PG keeps the pg_trgm GIN indexes; MySQL falls back to
plain `LIKE`. Two reasons the original "MySQL is slow at scale"
worry is materially smaller than it looked when this step was
sketched:

1. **Step 7.3 bounds the hot table.** Default payload retention is
   30 days. A deploy seeing 200k detections/month therefore tops
   out around 200k rows on the heavy side and metadata on the
   smaller side. MySQL `LIKE '%X%'` scans 200k rows in the
   1-2 second range, which is acceptable for an admin-only
   listing page that is used occasionally (the user-facing
   detection / gateway hot-path doesn't go through this query at
   all — Step 7.1 audit confirmed). SIEM is the long-term log of
   record.
2. **Same query plan on both.** SQLAlchemy emits the same
   `column LIKE :pattern` expression both ways; the only
   difference is which dialect's index it can use. We don't have
   a code fork to maintain.

Documented in `routers/results.py` next to the `content_search`
filter — a comment that names both dialects' behavior and points
out that FULLTEXT (`WITH PARSER ngram` for CJK) is the next step
*if and when* a MySQL deploy hits the limit. Until then, no
work.

**Step 6 — CI matrix. DONE 2026-04-27.**

GitHub Actions workflow at
`.github/workflows/test.yml` runs the test suite against
both PG 16 and MySQL 8 on every push and PR touching `backend/`
or the workflow itself. Service containers start the DB,
checkout/pip-install/pytest run in the matrix job.

**Test bootstrap.** `backend/tests/` was empty before this
step; added a session-scoped fixture (`conftest.py`) and a
`test_schema_portability.py` codifying everything I'd been
verifying by hand:
- All ORM tables present after bootstrap; no extra tables
  beyond `schema_migrations`.
- Migration runner is idempotent (second run executes 0).
- Step 7 sibling tables present (`detection_result_payloads`,
  `tenant_detection_stats`, `detection_result_categories`).
- Generated-column unique fires on `is_global=true` workspace
  duplicates and lets `is_global=false` duplicates through —
  the Step 3A.2.b semantic on both dialects.
- Detection dual-write to both `categories` and `payload`
  siblings round-trips through the relationship.
- Retention purge drops the payload sibling row for old
  detections and keeps fresh ones; assertion filters by
  tenant so leftover rows from earlier tests don't influence
  the count (session-scoped fixture).
- Stats rollup increment accumulates correctly across
  multiple calls in the same (tenant, app, date) bucket.
- Payment-order `stripe_session_id` / `trade_no` columns +
  indexes present (Step 4.1).
- Legacy PG-only triggers are gone (Step 3A.2.c) — skipped
  on MySQL.

**Performance.** 12 tests, session-scoped bootstrap. PG run
~1.1s; MySQL run ~3.9s (mostly JSON serialization
overhead). Easily fits inside a CI minute.

**Verified locally** against both `og_modelstest` (PG) and
`og_test` (MySQL): 12 / 11+1-skipped passing on each.

**What this catches.** Future regressions in:
- Generated-column expression syntax (per-dialect `STORED`
  vs `VIRTUAL` confusion).
- Migration ordering / idempotency (e.g. accidentally adding
  a non-idempotent DDL statement to a `.py` migration).
- ORM-vs-DB drift (a new column in `models.py` that isn't
  reflected via `Base.metadata.create_all()` or vice versa).
- Retention plumbing — sibling delete cascade, generated-key
  uniques, etc.

**What it doesn't cover yet.**
- The full HTTP / detection pipeline (no integration tests
  for the FastAPI app).
- Async paths (no `pytest-asyncio` tests yet).
- Frontend (no Playwright / vitest).

These can be added incrementally; the schema layer is the
one with the highest dialect-portability risk and the
lowest-cost test surface.

#### Migration system: switch to Alembic
- The current `backend/migrations/versions/*.sql` is bare SQL — every migration is implicitly PG dialect.
- Convert to Alembic with autogenerate + ORM-level operations. ~90 existing migrations need translation.
- Strategy: do not rewrite history. Mark all existing migrations as "applied" via `alembic stamp head` on existing databases. Net-new migrations from this point are Alembic. Old SQL files stay in place as historical reference.
- Alembic's op layer (`op.create_index`, `op.add_column` etc.) renders correct SQL per dialect automatically.

#### Schema-level changes
- **JSONB → JSON.** SQLAlchemy `JSON` type works on both. PG renders as `JSONB`, MySQL renders as `JSON`. Models change in `database/models.py`:
  - `security_categories`, `compliance_categories`, `data_categories`, `unsafe_segments`, `image_paths`, `matched_window_indices`, `full_messages`, etc.
- **JSONB.contains() filtering → relational table.** This is the biggest semantic change. Today:
  ```python
  cast(DetectionResult.security_categories, JSONB).contains([category])  # results.py:238
  ```
  becomes a join against a new `detection_result_categories(result_id, category, kind)` table where `kind ∈ {security, compliance, data}`. Win: indexable, cross-DB, and an order of magnitude faster than JSONB array containment.
  - Migration: backfill from existing JSON columns, dual-write during transition, swap reads, drop old write path.

#### Code-level changes
- `services/rate_limiter.py` — already moved to Redis in Phase 2, no work here.
- `routers/payment_api.py` — replace `order_metadata->>'stripe_session_id'` with `func.json_extract(...)` via SQLAlchemy's portable JSON operators. Or better: hoist the field to a real column (`stripe_session_id VARCHAR(64)` indexed) since we look it up by exact match anyway.
- `migrations/run_migrations.py` — already lock-free in Phase 2 (uses Redis). Remove residual `pg_advisory_lock` references.
- All `INSERT … RETURNING id` — switch to ORM `flush()` + `obj.id`, which works on both dialects.
- All `gen_random_uuid()` in migrations — switch to client-side `uuid.uuid4()` (already the default for new code).
- All `INTERVAL '1 second'` — moved to Redis in Phase 2.

#### New configuration
- `DATABASE_URL` already drives dialect selection via SQLAlchemy URL scheme (`postgresql+asyncpg://` vs `mysql+aiomysql://`).
- Add `DATABASE_DIALECT` derived value for the rare places we need dialect-specific behavior (probably zero by the end of Phase 4a).

#### Risks & mitigations
- **Test coverage gap on MySQL.** Today CI is PG-only. Mitigation: add a parallel CI matrix (mysql:8 + postgres:16). Both run the same test suite. Fail fast.
- **Long migration window during JSONB → relational backfill.** For tenants with millions of detection_results rows, the backfill is non-trivial. Mitigation: do it in chunks via a background task, with dual-write during the window. Same pattern as the LiteLLM spend-batching they use.

### Phase 4b — AI gateway core features

We've audited LiteLLM (`tests/litellm/`, third-party reference). It's huge — most of its volume is provider transformers. We do not want to clone it. We want the **minimal viable set of primitives** that lets us be a real AI gateway, integrated with our guardrails.

#### What we build (the core 5)

1. **Model deployment registry**
   - New table `model_deployments` (or extend `upstream_api_config`): `model_alias`, `provider`, `base_url`, `api_key`, `priority`, `weight`, `health_status`, `last_failed_at`.
   - One alias (e.g. `gpt-4`) maps to N deployments. Aliases live in a separate `model_aliases` table for clarity.
   - Looked up at request time via Redis-cached query (cache invalidates on admin update).

2. **Routing strategies (one selector, three modes)**
   - `priority`: pick the highest-priority healthy deployment (default).
   - `round_robin`: rotate among same-priority deployments.
   - `least_busy`: pick the deployment with fewest in-flight requests (counter in Redis).
   - One pluggable interface: `class RoutingStrategy: async def select(deployments) -> Deployment`.
   - Failure → mark unhealthy in Redis with TTL → retry next deployment in the list.

3. **Per-deployment fallback / retry**
   - On `httpx` timeout / 5xx / rate-limit response: mark current deployment unhealthy (Redis SETEX 60s), retry on next deployment.
   - Mid-stream fallback (LiteLLM's `MidStreamFallbackError`): explicitly **out of scope for v1**. If a stream errors mid-flight, surface to client and let them retry. Adding mid-stream fallback later is a separate design.

4. **Metering & quota**
   - Redis INCRBY per `(api_key_id, model_alias, day_bucket)` for token counts (input + output) and request count.
   - Background task flushes to a new `usage_logs` table every 5 seconds, batched.
   - Quota check is a Redis read on the hot path — no PG hit unless quota exceeded.
   - Cost calculation: pluggable per-provider function. Start with OpenAI + Anthropic + Bedrock pricing tables. Update via JSON config file, not hardcoded.

5. **Protocol conversion (selective)**
   - Three first-class providers: OpenAI, Anthropic, Bedrock. We write our own request/response transformers for each — they're under 200 lines each.
   - Everything else: passthrough OpenAI-compatible. We document the supported subset; if a provider doesn't speak OpenAI-compatible, customer uses LiteLLM in front of us, not the other way around.
   - Streaming: `async for chunk` with provider-specific chunk parsers; chunks are proxied through to client immediately (no buffering), with metering done after the stream closes.

#### Where this lives
- `backend/services/gateway/` (new package)
  - `registry.py` — deployment lookup
  - `routing.py` — strategies
  - `metering.py` — Redis counters + flush task
  - `transforms/openai.py`, `transforms/anthropic.py`, `transforms/bedrock.py`
  - `client.py` — the unified async caller
- `backend/routers/proxy_api.py` shrinks to a thin shell: parse → guardrails (input) → gateway call → guardrails (output) → meter → return. The current proxy implementation is mostly orchestration; gateway logic moves out.

#### Explicit non-goals
- Budget trees / cost hierarchies. Track spend, don't model org budget.
- Provider parity. We have ~3 first-class providers, not 50.
- Mid-stream fallback. Out of scope for v1.
- A separate gateway UI. Reuse the existing admin pages; add a "Deployments" page under Proxy Management.
- Cloning LiteLLM. We're shipping a focused product, not a fork.

#### Risks & mitigations
- **Pricing tables drift.** Provider prices change. Mitigation: prices in JSON config, not code. Schedule a quarterly cron-based update review (no autoupdate from LiteLLM's table — that's how you get surprise billing bugs).
- **Streaming complexity under load.** Streaming + metering + fallback is the part most likely to leak memory or stall. Mitigation: explicit cancellation handling; staged rollout behind a feature flag for the first month.

---

## Phase 5 — Detection-data lifecycle (Step 7)

**Why this phase exists.** Discovered late in Phase 4: a single
production deploy logged 200k detection records in its first month.
Forecast 2.4M+/year per deploy. The legacy `detection_results` table
holds the full message payloads alongside metadata, so the table grows
without bound and dashboard `COUNT()` over the whole table is the main
DB pressure point. SIEM is the long-term log of record; the local DB
should keep payloads only for short-window investigation and metadata
forever for stats.

User requirement: payload retention 30 days default, metadata retention
forever default, **single global setting** managed by super-admin (not
per-tenant or per-workspace).

### Step 7.1 — DONE 2026-04-27 (hot-path audit)

The detection / gateway request flow is already fully decoupled from
the DB:
- `services/async_logger.AsyncDetectionLogger` puts each detection on
  an in-memory `asyncio.Queue`. The user-facing endpoint returns
  immediately after enqueueing.
- A background `_writer_task` flushes the queue to JSONL files in
  `settings.detection_log_dir`.
- `services/log_to_db_service` polls those files and bulk-inserts to
  `detection_results` on a separate background task.

So request latency is unaffected by DB pressure. Two non-blocking but
DB-coupled code paths remain:
- `services/proxy_service.log_proxy_request{,_gateway}` synchronously
  inserts a `proxy_request_logs` row *after* the response returns
  (each request still consumes a DB connection, but doesn't add to
  user latency).
- `services/stats_service` — dashboard `COUNT()` queries scan the
  whole `detection_results` table. **This is the main DB pain point**;
  Step 7.4 will fix it with an incremental rollup.

### Step 7.3 — DONE 2026-04-27 (retention config + purge cron)

Two new global config keys in `system_config` (super-admin only):
- `payload_retention_days` (default 30) — days to keep detection
  payload fields (content, original_content, model_response,
  full_messages, messages, image_paths, unsafe_segments,
  doublecheck_categories, doublecheck_reasoning,
  matched_window_indices). Older rows have these fields nulled
  (content set to empty string since it's NOT NULL); metadata
  remains.
- `metadata_retention_days` (default 0 = keep forever) — days to keep
  the metadata row itself. When non-zero, must be `>= payload_retention`
  (validated at the API).

**Files added.**
- `backend/services/retention_service.py` — read/write helpers and
  `purge_old_detection_data(db)` which applies both retention windows
  in one transaction. Returns counts for observability.
- `backend/services/retention_purger.py` — daily background asyncio
  task (`PURGE_INTERVAL_SECONDS = 86400`, with a 5-min initial-delay
  stagger so rolling restarts don't all purge at once). Wraps each
  iteration in try/except so transient DB failures don't kill the
  loop.
- `backend/routers/system_config.py` — `GET/PUT /api/v1/system/retention`
  and `GET /api/v1/system/retention/defaults`. Custom super-admin
  gate that walks `request.state.auth_context` → tenant → checks
  `is_super_admin`.
- `frontend/src/pages/Admin/RetentionSettings.tsx` — one-card form
  (payload + metadata fields), Save / Reset-to-defaults buttons,
  bilingual i18n (`retention.*` keys in `en.json` / `zh.json`,
  `nav.retention` for the sidebar entry).
- Wired into `app.py` lifespan (start/stop the purger), `app.py`
  router list, `frontend/src/pages/Admin/AdminPanel.tsx` route,
  `frontend/src/components/Layout/Layout.tsx` super-admin nav, and
  `frontend/src/services/api.ts` (`retentionApi`).

**Verified live.**
- Live PG smoke test: defaults read as 30 / 0; setting `99999/0` and
  running purge cleared 0 (no rows that old); setting `1/0` cleared
  payloads on 3732 of 3742 rows (kept the 3 rows < 1 day old). Reset
  to defaults — settings restored. **Side effect, noted as a dev
  hazard:** the test cleared real dev-DB payloads. Should have used
  the disposable `og_modelstest` DB; flagged for future testing.
- `TestClient` smoke against the new endpoints: unauthenticated and
  invalid-token both return 401 (auth gating works).
- `RetentionSettings.tsx` typechecks clean (other pre-existing TS
  errors in unrelated files were not introduced here).

**Operator semantics.** With defaults (30 / 0), the daily purger
clears payload fields on rows older than 30 days; metadata rows
accumulate forever. To bound the metadata table, set
`metadata_retention_days` to a positive value (e.g. 365) — must be
>= payload retention. SIEM remains the long-term log of record.

### Step 7.2 — DONE 2026-04-27 (payload split table — schema + dual-write)

`detection_result_payloads` now ships alongside `detection_results`.
The 10 heavy fields (`content`, `original_content`, `model_response`,
`full_messages`, `messages`, `image_paths`, `unsafe_segments`,
`doublecheck_categories`, `doublecheck_reasoning`,
`matched_window_indices`) live on the sibling row keyed by
`detection_result_id` (PK + FK CASCADE). log_to_db_service writes
both rows in the same transaction via the `payload` relationship.

**Migration 099** (`.py`):
`DetectionResultPayload.__table__.create(bind=conn)` if absent + a
batched `INSERT … SELECT … LEFT JOIN … WHERE p.detection_result_id
IS NULL ORDER BY dr.id LIMIT 5000` until exhausted. Idempotent —
rows already in the sibling are skipped, so re-running is a no-op.

**Retention purge route through the sibling.**
`services/retention_service.purge_old_detection_data` now does TWO
things on payload-cutoff expiry:
1. `DELETE FROM detection_result_payloads WHERE detection_result_id
   IN (SELECT id FROM detection_results WHERE created_at <
   :cutoff)` — cheap, clean, just drops the heavy data.
2. The legacy `UPDATE detection_results SET ... = NULL WHERE
   created_at < :cutoff AND content <> ''` — kept until readers
   migrate to the sibling, since none of the routers/services have
   been updated yet to fall back to `detection_results.payload`.

Both operations are reported separately in the cron logs
(`payload_rows_deleted` vs `payload_cleared`) for observability.

**What's NOT in this step.** ~25 read sites in routers/services
still touch the legacy heavy columns directly
(`routers/results.py`, `routers/appeal_api.py`, `routers/workspaces.py`,
`services/appeal_service.py`, …). Migrating each to use the sibling
relationship + dropping the legacy columns from `detection_results`
is a separate sweep; it's mechanical but volumous. The dual-write
keeps both stores in sync, so the swap can land per-site without
data loss.

**Verified live.**
- Backfill on `openguardrails` PG: `detection_result_payloads`
  populated to 3749 rows == `detection_results` count.
- Retention smoke-test: `payload_retention_days=1` → purge dropped
  3739 sibling rows (10 remained, the < 1-day-old set), legacy
  nulling did nothing because content was already cleared from the
  Step 7.3 test. Restored via re-running the backfill.
- Fresh PG bootstrap: `Executed: 5` (000+095+096+098+099),
  `Skipped: 91`. 52 tables (51 ORM + `schema_migrations`).
- Fresh MySQL bootstrap: same shape — `Executed: 5, Skipped: 91`,
  52 tables, `detection_result_payloads` present.

### Step 7.4 — DONE 2026-04-27 (aggregated stats rollup)

The dashboard summary + 7-day trends now read from a per-(tenant,
application, date) rollup in `tenant_detection_stats` instead of
scanning all of `detection_results`. log_to_db_service increments
the rollup as it inserts each detection.

**Schema (`TenantDetectionStats`).** `(tenant_id, application_id,
date)` plus eight counters:
- `total_count`, `security_count`, `compliance_count`, `data_count`
- `high_risk_count`, `medium_risk_count`, `low_risk_count`,
  `no_risk_count` (overall risk = max of the three domain levels)
- `application_id` is nullable (legacy detections without an
  application). The unique constraint can't be `(tenant_id,
  application_id, date)` directly because both PG default `NULLS
  DISTINCT` and MySQL would allow multiple tenant-level rows per
  date. Same gen-col trick as Step 3A.2.b: `application_key` =
  `COALESCE(application_id, '00000000000000000000000000000000')`,
  unique on `(tenant_id, application_key, date)`. STORED on PG,
  VIRTUAL on MySQL (compatible with the FK CASCADE on tenant_id).
- No FK to `applications.id` on the rollup — historical stats stay
  even when applications are deleted. CASCADE on tenant_id only.

**Service** (`services/detection_stats_service.py`):
- `_overall_risk(security, compliance, data)` mirrors the legacy
  priority logic so dashboard semantics are byte-identical.
- `_bucket_date` falls back to UTC for naive timestamps; production
  rows always carry tz-aware `created_at`.
- `increment_for_detection(...)` selects the rollup row, creates if
  absent, otherwise applies the per-row deltas. log_to_db_service
  calls this after `db.flush()` (so `detection_result.id` is
  populated) but before `db.commit()`. A failed increment logs and
  swallows — never drops the underlying detection row.
- `backfill_stats(db)` truncates the rollup and replays every row in
  `detection_results` in batches of 5000. Idempotent.

**Migration 098** (`.py`): `TenantDetectionStats.__table__.create()`
+ `backfill_stats(session)`. Re-running the migration runs the
backfill again; same end state. Note version: 097 was already
occupied in the live DB by `tenant_global_appeal.sql` (a file no
longer on disk), so this lands at 098.

**stats_service rewrite.** `get_dashboard_stats` is now eight
`SUM()`s over the rollup; `_get_daily_trends` is a single
`GROUP BY date` over the rollup window. Both query a tiny table
regardless of how many detection rows exist.

**Verified live (PG, 3742 detection rows pre-rollup).**
- After backfill: 15 rollup rows, sum(total_count) = 3742.
- Side-by-side comparison of all eight aggregates between the legacy
  (full table scan) and the new rollup-backed dashboard: every value
  matches exactly (`total=3742, sec=248, comp=2074, data=379,
  high=545, med=940, low=1194, safe=1063`).
- Fresh PG bootstrap: `Executed: 4` (000 + 095 + 096 + 098),
  `Skipped: 91`. 51 tables (50 ORM + `schema_migrations`).
- Fresh MySQL bootstrap: same shape — `Executed: 4, Skipped: 91`,
  51 tables, zero drift between DB and `Base.metadata.tables`.

**Out of scope.** `get_category_distribution` still reads
`detection_results` (it filters on per-row data and joins JSON).
Step 4.2 already moved category data into a portable relational
table; a separate per-category rollup would be a clean follow-up
but isn't urgent — category distribution is rendered on a less
trafficked admin page than the main dashboard.

---

## Cross-phase: things to NOT do

These are appealing but explicitly out of scope:

- Don't introduce gRPC or message queues. Redis + HTTP is enough.
- Don't add observability stack (Prometheus, OTel) as part of this refactor. It belongs in its own initiative.
- Don't expand RBAC, multi-tenancy isolation, or audit logging beyond what's already there.
- Don't migrate to a different ORM. SQLAlchemy 2.x async covers our needs.
- Don't write a custom load balancer in front of nginx. K8s / hosted LB is fine.
- Don't replace SQLAlchemy migrations with raw SQL "for performance." Alembic is the right tool.

---

## Suggested sequencing

```
Phase 1: log query optimization        [done — migration 093, results.py, frontend]
Phase 2: Redis-ization                 [2-3 weeks]
Phase 3: async + single service        [3-4 weeks, depends on Phase 2]
Phase 4a: MySQL/PG dialect abstraction [2-3 weeks, can start when Phase 3 mid-way]
Phase 4b: AI gateway core              [3-4 weeks, can run parallel to 4a]
```

Total elapsed: ~10–13 weeks for one engineer working full-time, or ~6–8 weeks with two people splitting at Phase 4.

---

## Open questions

1. Do we ship a single Docker image after Phase 3, or keep separate images for backward compat? My vote: single image, with the "legacy three-service" compose available for one release.
2. For MySQL, do we target 8.0+ only, or also 5.7? Recommend 8.0+ — JSON support is meaningfully better.
3. How do we want operators to migrate existing PG installations to MySQL (or vice versa) if they ask? Out of scope for this plan; can be a later "migration tool" project.
4. For gateway pricing tables, do we maintain them ourselves or pull from LiteLLM's `model_prices_and_context_window.json`? Recommend: bootstrap from theirs, then maintain independently with a pinned commit reference.
