#!/usr/bin/env python3
"""
Unified OpenGuardrails backend (Phase 3 step 6).

Single FastAPI app combining the admin, detection, and proxy services.
After the wave 1-3 async migration, all three services share the same
async DB stack, so running them in one Python process is safe — a slow
admin query no longer stalls a detection request because there's no
sync DB blocking the event loop.

Goals:
- One worker pool (target ~8 workers on a 4-core box, vs the old 58
  across three services).
- One nginx upstream — the URL prefix already disambiguates routing
  (/api/v1, /v1/guardrails*, /v1/chat/completions, /v1/gateway/*).
- Single migration / async-logger startup.

The legacy `admin_service.py` / `detection_service.py` / `proxy_service.py`
entry points are kept for one release cycle. They still work as-is and
are useful for rollback during the cutover. Their FastAPI app instances
are constructed at import time of this module — wasted work, but
acceptable for the migration window. After the cutover those files
will be deleted.
"""

from contextlib import asynccontextmanager
import os
import uuid

from fastapi import FastAPI, HTTPException, Depends, Security, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pathlib import Path

# ---------------------------------------------------------------------------
# Reuse the existing middleware classes via the legacy service modules.
# This avoids duplicating ~600 lines of auth code and means future fixes
# to admin/detection/proxy auth flow stay single-sourced. Importing the
# module instantiates an unused FastAPI() inside it — that's wasted work
# but keeps the diff small. Once we delete the legacy modules, we'll
# move the middleware classes to a shared `middleware/` module.
# ---------------------------------------------------------------------------
import admin_service as _admin_mod
import detection_service as _detection_mod
import proxy_service as _proxy_mod

AdminAuthMiddleware = _admin_mod.AuthContextMiddleware
DetectionAuthMiddleware = _detection_mod.AuthContextMiddleware
ProxyAuthMiddleware = _proxy_mod.AuthContextMiddleware

# Imports that depend only on `routers/` and `services/` — safe to import
# directly (no per-service FastAPI side effect).
from config import settings
from database.connection import init_db
from middleware.concurrent_limit_middleware import ConcurrentLimitMiddleware
from middleware.billing_middleware import BillingMiddleware
from utils.permissions import RoleCheckMiddleware
from services.async_logger import async_detection_logger
from services.admin_service import admin_service as _admin_svc
from utils.logger import setup_logger

# Routers (all three services' worth, deduplicated below).
from routers import (
    # admin
    auth, user, dashboard, config_api, results, sync, admin,
    online_test, proxy_management, concurrent_stats, media,
    billing, applications, scanner_packages_api, scanner_configs_api,
    custom_scanners_api, purchase_api, risk_config_api, payment_api,
    model_routes_api, attack_campaigns_api, data_security,
    data_leakage_policy_api, gateway_policy_api, appeal_api,
    audit_log, gateway_connections, workspaces, system_config,
    # detection
    detection_guardrails, dify_moderation, content_scan,
    litellm_guardrail_api, model_direct_access, appeal_router,
    # proxy
    proxy_api, gateway_integration_api,
)
from routers import team as team_router

logger = setup_logger()
security = HTTPBearer(auto_error=False)


# ---------------------------------------------------------------------------
# Lifespan — does the union of admin/detection/proxy startup work.
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Make sure data dirs exist (admin's responsibility).
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.log_dir, exist_ok=True)
    os.makedirs(settings.detection_log_dir, exist_ok=True)

    # Full DB init — runs migrations, seeds defaults, ensures global
    # entity types and built-in scanner packages. Same as the legacy
    # admin service does.
    await init_db(minimal=False)

    # Start the async detection logger (used by detection + proxy paths).
    await async_detection_logger.start()

    # Start the cache cleaner + log-to-DB service (admin-side housekeeping).
    from services.cache_cleaner import cache_cleaner
    await cache_cleaner.start()

    if settings.store_detection_results:
        from services.log_to_db_service import log_to_db_service
        await log_to_db_service.start()
        logger.info("Log to DB service started (STORE_DETECTION_RESULTS=true)")
    else:
        logger.info("Log to DB service disabled (STORE_DETECTION_RESULTS=false)")

    # Step 7.3: daily retention purge. Bounded by the global config keys
    # `payload_retention_days` and `metadata_retention_days` (super-admin
    # only, system_config). No-op when both keys are at their defaults
    # (30 / 0) on a fresh deploy with no rows yet.
    from services.retention_purger import retention_purger
    await retention_purger.start()

    logger.info(f"{settings.app_name} unified service started")
    logger.info(f"Data directory: {settings.data_dir}")
    logger.info("All three surfaces (admin / detection / proxy) running in one process")

    try:
        yield
    finally:
        # Reverse-order shutdown.
        from services.cache_cleaner import cache_cleaner
        await cache_cleaner.stop()

        if settings.store_detection_results:
            from services.log_to_db_service import log_to_db_service
            await log_to_db_service.stop()

        from services.retention_purger import retention_purger
        await retention_purger.stop()

        await async_detection_logger.stop()

        from services.model_service import model_service
        await model_service.close()

        from services.proxy_service import proxy_service
        await proxy_service.close()

        logger.info("Unified service shutdown completed")


# ---------------------------------------------------------------------------
# App + middleware stack.
#
# Stacking order matters because two middlewares both write
# `request.state.auth_context`:
#
#   - DetectionAuthMiddleware path-gates on /v1/guardrails*, /v1/dify*,
#     /v1/scan/*, /beta/litellm_*
#   - ProxyAuthMiddleware path-gates on /v1/*
#   - AdminAuthMiddleware path-gates on /api/v1/*
#
# Detection's prefixes are a subset of Proxy's `/v1/*`. We want detection's
# auth_context to win for /v1/guardrails (more specific). Starlette
# executes middlewares in reverse-add order — latest added runs FIRST
# (outermost), earliest added runs LAST (innermost, just before the
# handler). The LAST-running middleware to write a state field wins.
# So we add Detection FIRST (innermost = wins), then Proxy, then Admin.
#
# The other middlewares (Billing, RoleCheck, ConcurrentLimit, CORS) are
# already path-gated internally and stack cleanly.
# ---------------------------------------------------------------------------

app = FastAPI(
    title=f"{settings.app_name} - Unified Service",
    version=settings.app_version,
    description="OpenGuardrails unified backend — admin + detection + proxy in one process",
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    lifespan=lifespan,
)

# Sum the three legacy concurrent-limit values. Operators can tune via
# UNIFIED_MAX_CONCURRENT_REQUESTS env if needed. The unified worker pool
# is smaller than the sum of legacy pools, so this cap is what protects
# the process from overload.
_unified_max_concurrent = int(
    os.getenv(
        "UNIFIED_MAX_CONCURRENT_REQUESTS",
        str(
            settings.admin_max_concurrent_requests
            + settings.detection_max_concurrent_requests
            + settings.proxy_max_concurrent_requests
        ),
    )
)
app.add_middleware(
    ConcurrentLimitMiddleware,
    service_type="unified",
    max_concurrent=_unified_max_concurrent,
)

# Billing only triggers on /v1/guardrails and /v1/chat/completions in
# SaaS mode (it path-gates internally + early-returns in enterprise
# mode). Safe to leave on the global stack.
app.add_middleware(BillingMiddleware)

# RoleCheck only acts on /api/v1/* admin write paths. Internal path
# gating keeps it out of detection / proxy traffic.
app.add_middleware(RoleCheckMiddleware)

# Auth middlewares — order documented above.
app.add_middleware(AdminAuthMiddleware)
app.add_middleware(ProxyAuthMiddleware)
app.add_middleware(DetectionAuthMiddleware)  # innermost — wins on /v1/guardrails

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth dependency. The legacy services each had their own `verify_user_auth`
# with slightly different fallback paths; in the unified app, the
# auth_context written by the middleware chain is the source of truth.
# If middleware didn't set it, we 401.
# ---------------------------------------------------------------------------


async def verify_user_auth(
    credentials: HTTPAuthorizationCredentials = Security(security),
    request: Request = None,
):
    """Verify auth via the auth_context that middleware wrote. The 3
    legacy services each had a slightly different fallback when the
    middleware didn't run (e.g., admin re-decoded the JWT inline). In
    the unified app the middleware always runs, so we just read it."""
    if request is not None:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if auth_ctx:
            return auth_ctx
    raise HTTPException(status_code=401, detail="Not authenticated")


# ---------------------------------------------------------------------------
# Top-level routes.
# ---------------------------------------------------------------------------


@app.get("/")
async def root():
    return {
        "name": f"{settings.app_name} - Unified Service",
        "version": settings.app_version,
        "status": "running",
        "service_type": "unified",
        "endpoints": {
            "admin": "/api/v1/*",
            "detection": "/v1/guardrails*",
            "proxy": "/v1/chat/completions, /v1/completions, /v1/models",
            "gateway": "/v1/gateway/*",
        },
    }


@app.get("/health")
async def health():
    return {"status": "healthy", "version": settings.app_version, "service": "unified"}


# ---------------------------------------------------------------------------
# Routers — copied from each legacy service file, deduplicated where
# the same router was mounted in two places.
# ---------------------------------------------------------------------------

# ---- Admin surface (/api/v1/*) --------------------------------------------
app.include_router(auth.router, prefix="/api/v1/auth")
app.include_router(user.router, prefix="/api/v1/users")
app.include_router(dashboard.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(config_api.public_router, prefix="/api/v1")
app.include_router(config_api.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(results.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(sync.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(admin.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(online_test.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(proxy_management.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(concurrent_stats.router, dependencies=[Depends(verify_user_auth)])
app.include_router(data_security.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(data_leakage_policy_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(gateway_policy_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(model_routes_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(system_config.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])

if settings.is_saas_mode:
    # `billing.router` was registered by both admin and detection legacy
    # services; we register once here and detection traffic still hits
    # it through the unified app's URL routing.
    app.include_router(billing.router, dependencies=[Depends(verify_user_auth)])
    app.include_router(payment_api.router)  # Webhooks intentionally have no auth.
    app.include_router(purchase_api.router, dependencies=[Depends(verify_user_auth)])
    logger.info("SaaS-mode routes enabled (billing + payment + purchase)")
else:
    logger.info("SaaS-mode routes disabled (enterprise mode)")

app.include_router(applications.router, prefix="/api/v1/applications", dependencies=[Depends(verify_user_auth)])
app.include_router(workspaces.router, dependencies=[Depends(verify_user_auth)])
app.include_router(scanner_packages_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(scanner_configs_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(custom_scanners_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(appeal_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(audit_log.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(risk_config_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(gateway_connections.router, dependencies=[Depends(verify_user_auth)])
app.include_router(team_router.public_router)
app.include_router(team_router.router, dependencies=[Depends(verify_user_auth)])
app.include_router(attack_campaigns_api.router, dependencies=[Depends(verify_user_auth)])

# Public media access (no auth) + protected media management.
public_media_router = _admin_mod.public_media_router  # reuse the legacy module's router definition
app.include_router(public_media_router, prefix="/api/v1")
app.include_router(media.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])

# ---- Detection surface (/v1/guardrails*, /v1/dify*, /v1/scan/*, /beta/*) --
app.include_router(detection_guardrails.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(dify_moderation.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(content_scan.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(litellm_guardrail_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(appeal_router.router)  # public appeal page (request_id is the token)

# ---- Proxy surface (/v1/chat/completions, /v1/completions, /v1/models, /v1/gateway/*) --
app.include_router(proxy_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(gateway_integration_api.router, dependencies=[Depends(verify_user_auth)])

# ---- Shared: model_direct_access was registered by BOTH detection and
# proxy in the legacy split. Mount once. Internal auth still works.
app.include_router(model_direct_access.router, prefix="/v1")


# ---------------------------------------------------------------------------
# Global exception handler.
# ---------------------------------------------------------------------------


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    import traceback
    logger.error(f"Unified service exception on {request.url.path}: {exc}")
    logger.error(f"Traceback: {traceback.format_exc()}")
    return JSONResponse(
        status_code=500,
        content={"detail": f"Unified service internal error: {str(exc)}"},
    )
