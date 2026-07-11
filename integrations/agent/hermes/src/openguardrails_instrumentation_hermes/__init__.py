"""ogr-guard — Hermes plugin securing the agent + its sandbox through OGR.

register(ctx) binds four Hermes hooks to the OGR bridge and installs the
optional sandbox-altitude wrapper. One Runtime + one policy.json enforce
across all altitudes, correlated by guard_id + provenance.
"""
from __future__ import annotations

from . import bridge
from .sandbox_guard import install_sandbox_guard


def register(ctx) -> None:
    # gateway altitude (LLM I/O) — observe-only in Hermes
    ctx.register_hook("pre_api_request", bridge.on_pre_api_request)
    ctx.register_hook("post_api_request", bridge.on_post_api_request)

    # agent_hook altitude — DETECT + BLOCK before a tool runs
    ctx.register_hook("pre_tool_call", bridge.on_pre_tool_call)

    # provenance/taint tracking from tool results
    ctx.register_hook("post_tool_call", bridge.on_post_tool_call)

    # sandbox altitude — wrap the real exec chokepoint (optional, fails open)
    sandbox_ok = install_sandbox_guard()
    bridge._audit("load", f"ogr-guard registered: hooks=[pre/post_tool_call, "
                          f"pre/post_api_request] sandbox_wrap={sandbox_ok} "
                          f"policy={bridge._policy_path()}")
