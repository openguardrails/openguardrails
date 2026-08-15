"""ogr-guard — Hermes plugin speaking the OGR v0.8 Runtime API directly.

register(ctx) binds four Hermes hooks to the bridge and installs the
optional exec-chokepoint wrapper. There is no SDK and no local policy
engine: the runtime is the decision point, this plugin is the enforcement
point, and the whole wire is two POSTs per model call (wire.py).
"""
from __future__ import annotations

import threading

from . import bridge
from .sandbox_guard import install_sandbox_guard


def register(ctx) -> None:
    # The step's two halves (recipe steps 2 and 4). Hermes discards what
    # these return, so they evaluate and PARK; enforcement is below.
    ctx.register_hook("pre_api_request", bridge.on_pre_api_request)
    ctx.register_hook("post_api_request", bridge.on_post_api_request)

    # Enforce on the answer — the only hook Hermes lets a plugin substitute
    # what the user sees. Withholds a blocked answer, applies redaction spans.
    ctx.register_hook("transform_llm_output", bridge.on_transform_llm_output)

    # Enforce on tool calls — "block on response -> do not execute tool
    # calls". Denies the round's dispatches when its step/response blocked.
    ctx.register_hook("pre_tool_call", bridge.on_pre_tool_call)

    # Exec vantage — wrap the real exec chokepoint (optional, fails open).
    sandbox_ok = install_sandbox_guard()

    # One liveness heartbeat at load (recipe step 5), off-thread because a
    # dark runtime must cost the startup path nothing. Best-effort by design:
    # the heartbeat is optional and evaluate never depends on it.
    client = bridge.get_client()
    if client.enabled:
        threading.Thread(target=client.heartbeat, daemon=True).start()

    bridge.logger.info(
        "ogr-guard registered: hooks=[pre/post_api_request, transform_llm_output, "
        "pre_tool_call] exec_wrap=%s runtime=%s fail_mode=%s",
        sandbox_ok, client.runtime_url or "(none)", client.fail_mode,
    )
