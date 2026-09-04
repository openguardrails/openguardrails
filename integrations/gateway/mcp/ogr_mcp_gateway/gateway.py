"""The gateway proper: identity -> mandate -> pretrade -> runtime -> upstream, with an audit line.

Transport-free core (`Gateway`) so tests can drive it with a fake upstream; the MCP server and
the stdio/streamable-http wiring live in `serve.py`."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from mcp_types import CallToolResult, TextContent, Tool

from . import INTEGRATION, pretrade, runtime
from .config import Config, Principal
from .mandate import Mandate, Verdict


class UpstreamLike(Protocol):
    name: str
    async def list_tools(self) -> list[Tool]: ...
    async def call_tool(self, name: str, args: dict) -> CallToolResult: ...


# ---------------------------------------------------------------- upstream result parsing

def _payload(result: CallToolResult) -> Any:
    """Alpaca's server wraps every result as {"_alpaca_mcp_security": {...}, "data": ...};
    other servers return bare JSON or text. Return the data part, or None."""
    for c in result.content or []:
        if isinstance(c, TextContent):
            try:
                obj = json.loads(c.text)
            except (ValueError, TypeError):
                continue
            return obj.get("data", obj) if isinstance(obj, dict) else obj
    return None


class UpstreamAccountReader:
    """AccountReader over the upstream's own read tools (Alpaca tool names)."""
    def __init__(self, upstream: UpstreamLike):
        self.up = upstream

    async def account(self) -> dict:
        d = _payload(await self.up.call_tool("get_account_info", {}))
        return d if isinstance(d, dict) else {}

    async def positions(self) -> dict[str, float]:
        d = _payload(await self.up.call_tool("get_all_positions", {}))
        rows = d if isinstance(d, list) else (d.get("positions") if isinstance(d, dict) else []) or []
        out = {}
        for r in rows:
            try:
                out[str(r["symbol"]).upper()] = float(r.get("market_value") or 0.0)
            except (KeyError, TypeError, ValueError):
                continue
        return out

    async def price(self, symbol: str) -> float | None:
        d = _payload(await self.up.call_tool("get_stock_latest_trade", {"symbols": symbol}))
        node = d.get(symbol) if isinstance(d, dict) and symbol in d else d
        if isinstance(node, dict):
            for k in ("price", "p", "trade_price"):
                if k in node:
                    try:
                        return float(node[k])
                    except (TypeError, ValueError):
                        pass
            if isinstance(node.get("trade"), dict):
                return await self._from(node["trade"])
        return None

    async def _from(self, node: dict) -> float | None:
        for k in ("price", "p"):
            if k in node:
                return float(node[k])
        return None


# ---------------------------------------------------------------- the gateway

@dataclass
class Decision:
    allowed: bool
    stage: str                       # mandate | pretrade | runtime | upstream | identity
    reason: str = ""
    verdict: Verdict | None = None
    pretrade: list[dict] = field(default_factory=list)
    runtime_verdict: dict | None = None


class Gateway:
    def __init__(self, cfg: Config, upstream: UpstreamLike, ledger, reader=None, audit_path: str | None = None):
        self.cfg, self.up, self.ledger = cfg, upstream, ledger
        self.reader = reader or UpstreamAccountReader(upstream)
        self.mandates = {ws: Mandate(doc, ledger) for ws, doc in cfg.mandates.items()}
        self.audit_path = Path(audit_path or cfg.audit_log)
        self._tools: list[Tool] | None = None

    async def tools(self) -> list[Tool]:
        if self._tools is None:
            self._tools = await self.up.list_tools()
        return self._tools

    async def tools_for(self, p: Principal | None) -> list[Tool]:
        all_tools = await self.tools()
        m = self.mandates.get(p.workspace) if p else None
        if m is None:
            return [] if self.cfg.mandates else all_tools     # no mandate for the workspace: nothing is granted
        if not self.cfg.hide_ungranted_tools:
            return all_tools
        return [t for t in all_tools if m.grants(t.name)]

    async def decide(self, p: Principal, tool: str, args: dict) -> Decision:
        m = self.mandates.get(p.workspace)
        if m is None:
            return Decision(False, "identity", f"workspace {p.workspace!r} has no mandate; nothing is granted")
        v = m.evaluate(p.workspace, tool, args)
        if v.blocked:
            return Decision(False, "mandate", "; ".join(f["subject"] for f in v.findings if f["action"] == "block"), v)
        pt: list[dict] = []
        if self.cfg.pretrade:
            pt = await pretrade.check(v.capability, tool, args, self.cfg.pretrade, self.reader, self.ledger, p.workspace)
            if pt:
                return Decision(False, "pretrade", "; ".join(f["subject"] for f in pt), v, pt)
        rv = None
        if self.cfg.runtime:
            rv = await runtime.evaluate(self.cfg.runtime, p, self.up.name, tool, args)
            if rv is None:
                if self.cfg.runtime.fail_mode == "closed":
                    return Decision(False, "runtime", "runtime unavailable; fail mode is closed", v, pt)
            elif rv.get("decision") == "block":
                return Decision(False, "runtime", runtime.reason_of(rv), v, pt, rv)
        return Decision(True, "upstream", "", v, pt, rv)

    async def call(self, p: Principal, tool: str, args: dict) -> CallToolResult:
        t0 = time.time()
        d = await self.decide(p, tool, args)
        result: CallToolResult
        if d.allowed:
            try:
                result = await self.up.call_tool(tool, args)
            except Exception as e:  # noqa: BLE001 - the upstream's failure is the caller's to see, not ours to hide
                result = CallToolResult(content=[TextContent(type="text", text=f"upstream error: {e}")], is_error=True)
        else:
            body = {"_ogr": {"decision": "block", "stage": d.stage, "reason": d.reason, "integration": INTEGRATION,
                             "findings": (d.verdict.findings if d.verdict else []) + d.pretrade,
                             "unjudged": d.verdict.unjudged if d.verdict else [],
                             "mandate": d.verdict.mandate if d.verdict else None,
                             "instructions": "This call was refused by policy. Do not retry with altered arguments to evade the rule; "
                                             "report the refusal to the human."}}
            result = CallToolResult(content=[TextContent(type="text", text=json.dumps(body, ensure_ascii=False))], is_error=True)
        self._audit(p, tool, args, d, result, time.time() - t0)
        return result

    def _audit(self, p: Principal, tool: str, args: dict, d: Decision, result: CallToolResult, secs: float) -> None:
        line = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "agent_id": p.agent_id, "agent_type": p.agent_type, "workspace": p.workspace, "user": p.user,
            "upstream": self.up.name, "tool": tool, "arguments": args,
            "decision": "allow" if d.allowed else "block", "stage": d.stage, "reason": d.reason,
            "capability": d.verdict.capability if d.verdict else None,
            "findings": (d.verdict.findings if d.verdict else []) + d.pretrade,
            "unjudged": d.verdict.unjudged if d.verdict else [],
            "runtime": (d.runtime_verdict or {}).get("decision") if d.runtime_verdict else None,
            "upstream_is_error": bool(result.is_error), "seconds": round(secs, 3),
        }
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        with self.audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
