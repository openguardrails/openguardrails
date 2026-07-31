"""ogr-guard — Hermes plugin securing the agent + its sandbox through OGR.

register(ctx) binds six Hermes hooks to the OGR bridge and installs the
optional sandbox-altitude wrapper. One Runtime + one policy.json enforce
across all altitudes, correlated by guard_id + provenance.
"""
from __future__ import annotations

from . import bridge
from .sandbox_guard import install_sandbox_guard


def register(ctx) -> None:
    # conversation altitude (LLM I/O). Hermes discards what these two return, so
    # they observe and DECIDE; the blocking half is transform_llm_output below.
    ctx.register_hook("pre_api_request", bridge.on_pre_api_request)
    ctx.register_hook("post_api_request", bridge.on_post_api_request)

    # conversation altitude — ENFORCE a blocking content verdict on the answer.
    # Hermes' only hook that can change what the user sees (agent/turn_finalizer.py
    # substitutes the first non-empty string a plugin returns). Without it a
    # moderation / off-topic block was recorded and then ignored.
    ctx.register_hook("transform_llm_output", bridge.on_transform_llm_output)

    # agent_hook altitude — DETECT + BLOCK before a tool runs
    ctx.register_hook("pre_tool_call", bridge.on_pre_tool_call)

    # provenance/taint tracking + the verdict on the tool's result
    ctx.register_hook("post_tool_call", bridge.on_post_tool_call)

    # invocation altitude — REDACT or withhold a tool result before it becomes
    # context. post_tool_call is observational in Hermes; this is the seam that can
    # replace the string (model_tools.py).
    ctx.register_hook("transform_tool_result", bridge.on_transform_tool_result)

    # sandbox altitude — wrap the real exec chokepoint (optional, fails open)
    sandbox_ok = install_sandbox_guard()
    bridge._audit("load", f"ogr-guard registered: hooks=[pre/post_tool_call, "
                          f"pre/post_api_request, transform_llm_output, "
                          f"transform_tool_result] "
                          f"sandbox_wrap={sandbox_ok} "
                          f"policy={bridge._policy_path()}")
