"""Report a held MCP tool call to an OGR runtime as one canonical `step/response` and take
its verdict — the same event the Claude Code hook sends (integrations/agent/claude-code),
because this vantage is the same fragment: one tool call, no model request or response.

No verdict (unreachable, non-2xx, malformed) is an outage, never an allow; the caller applies
the configured fail mode (specification/degraded-mode.md)."""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
import uuid

from . import INTEGRATION
from .config import Principal, Runtime


def build_event(p: Principal, upstream_name: str, tool: str, args: dict) -> dict:
    step_id = uuid.uuid4().hex
    return {
        "kind": "step/response",
        "step_id": step_id,
        "agent_id": p.agent_id, "agent_type": p.agent_type, "agent_workspace": p.workspace, "agent_user": p.user,
        "llm_protocol": "canonical",
        "payload": {"tool_calls": [{"id": f"mcp_{step_id}", "name": f"mcp__{upstream_name}__{tool}", "arguments": args or {}}]},
        "integration": INTEGRATION,
    }


def _post(url: str, api_key: str, data: bytes, timeout: float) -> dict | None:
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured URL
            body = json.loads(r.read() or b"null")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None
    return body if isinstance(body, dict) and "decision" in body else None


async def evaluate(rt: Runtime, p: Principal, upstream_name: str, tool: str, args: dict) -> dict | None:
    data = json.dumps(build_event(p, upstream_name, tool, args), ensure_ascii=False).encode("utf-8")
    return await asyncio.to_thread(_post, f"{rt.url}/v1/evaluate", rt.api_key, data, rt.timeout_ms / 1000)


def reason_of(verdict: dict) -> str:
    fs = verdict.get("findings") or []
    shown = [f for f in fs if f.get("action") == "block"] or fs
    return "; ".join(f"{f.get('category')}: {f['subject']}" if f.get("subject") else str(f.get("category"))
                     for f in shown) or "blocked by policy"
