"""ogr-guard — Hermes plugin speaking the OGR v1.x Runtime API directly.

register(ctx) binds four Hermes hooks to the bridge, three middlewares
(2.0: local secrets redaction — mask the outbound request, restore into a
tool's arguments after judgement), and installs the optional exec-chokepoint
wrapper. There is no SDK and no local policy engine: the runtime is the
decision point, this plugin is the enforcement point, and the whole wire is
two POSTs per model call plus a GET for the org's ruleset (wire.py,
local_redaction.py).
"""
from __future__ import annotations

import threading
import time

from . import bridge
from .sandbox_guard import install_sandbox_guard

#: The heartbeat period. One interval is the bound on how long a running
#: plugin masks with a ruleset the org has since changed: the response
#: carries `rules.id`, and a mismatch refetches in the background.
HEARTBEAT_INTERVAL_S = 30


def register(ctx) -> None:
    # The step's two halves (recipe steps 2 and 4). Hermes discards what
    # these return, so they evaluate and PARK; enforcement is below.
    ctx.register_hook("pre_api_request", bridge.on_pre_api_request)
    ctx.register_hook("post_api_request", bridge.on_post_api_request)

    # Enforce on the answer — the only hook Hermes lets a plugin substitute
    # what the user sees. Withholds a blocked answer, applies redaction spans;
    # with OGR_RESTORE_OUTPUT restores this session's tokens in the final text.
    ctx.register_hook("transform_llm_output", bridge.on_transform_llm_output)

    # Enforce on tool calls — "block on response -> do not execute tool
    # calls". Denies the round's dispatches when its step/response blocked,
    # and (2.0) a call carrying a token this session never issued.
    ctx.register_hook("pre_tool_call", bridge.on_pre_tool_call)

    client = bridge.get_client()
    redaction = client.redactor.enabled

    # Middleware — the behaviour-changing seams. Older Hermes builds have no
    # register_middleware: degrade to hooks-only rather than fail the load
    # (local redaction then cannot run at all — the request is never mutable).
    middleware: list[str] = []
    if hasattr(ctx, "register_middleware"):
        # MASK the outbound provider request + the session tag. Runs BEFORE
        # pre_api_request, so the event above sees the masked request.
        ctx.register_middleware("llm_request", bridge.on_llm_request_middleware)
        middleware.append("llm_request")
        if redaction:
            # RESTORE into the tool's arguments — after pre_tool_call, the
            # guardrails and the approval gate; the last mutable point.
            ctx.register_middleware("tool_execution", bridge.on_tool_execution_middleware)
            # Fail-closed with NO ruleset refuses the model call (llm_request
            # can only rewrite; this is the seam that can decline).
            ctx.register_middleware("llm_execution", bridge.on_llm_execution_middleware)
            middleware += ["tool_execution", "llm_execution"]
    elif redaction:
        bridge.logger.warning("ogr-guard: this Hermes has no register_middleware — "
                              "local redaction cannot run (the request is not mutable)")

    # Exec vantage — wrap the real exec chokepoint (optional, fails open).
    sandbox_ok = install_sandbox_guard()

    # Liveness heartbeat (recipe step 5): periodic, off-thread, best-effort —
    # a dark runtime must cost the agent nothing. Since 2.0 it also carries the
    # ruleset id and reads the runtime's back, which is how a running plugin
    # learns the org changed its rules.
    if client.enabled:
        threading.Thread(target=_heartbeat_loop, args=(client, HEARTBEAT_INTERVAL_S),
                         name="ogr-heartbeat", daemon=True).start()

    bridge.logger.info(
        "ogr-guard registered: hooks=[pre/post_api_request, transform_llm_output, "
        "pre_tool_call] middleware=%s exec_wrap=%s runtime=%s fail_mode=%s "
        "local_redaction=%s ruleset=%s",
        middleware, sandbox_ok, client.runtime_url or "(none)", client.fail_mode,
        redaction, client.redactor.ruleset_id or "(none yet)",
    )


def _heartbeat_loop(client, interval_s: float) -> None:
    while True:
        try:
            client.heartbeat()
        except Exception as exc:  # pragma: no cover - heartbeat() never raises
            bridge.logger.warning("ogr-guard: heartbeat loop error: %s", exc)
        time.sleep(interval_s)
