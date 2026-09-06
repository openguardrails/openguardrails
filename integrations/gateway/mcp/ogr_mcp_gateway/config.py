"""Gateway configuration: one JSON file, `${VAR}` expanded from the gateway's environment.

Secrets (upstream API keys, principal tokens, the runtime API key) belong in that
environment, never in the file, so the file can be committed."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .pretrade import PretradeLimits

_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def expand(value):
    if isinstance(value, str):
        return _VAR.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, list):
        return [expand(v) for v in value]
    if isinstance(value, dict):
        return {k: expand(v) for k, v in value.items()}
    return value


@dataclass(frozen=True)
class Principal:
    token: str
    agent_id: str
    agent_type: str
    workspace: str
    user: str = ""


@dataclass(frozen=True)
class Upstream:
    name: str
    command: str
    args: tuple[str, ...]
    env: dict[str, str]


@dataclass(frozen=True)
class Runtime:
    url: str
    api_key: str
    fail_mode: str = "closed"        # closed | open
    timeout_ms: int = 5000


@dataclass
class Config:
    upstream: Upstream
    principals: list[Principal]
    mandates: dict[str, dict]         # workspace -> mandate document
    pretrade: PretradeLimits | None
    runtime: Runtime | None
    host: str = "127.0.0.1"
    port: int = 8790
    hide_ungranted_tools: bool = True
    audit_log: str = "ogr-mcp-audit.jsonl"
    ledger: str = "ogr-mcp-ledger.sqlite"
    base_dir: Path = field(default_factory=Path.cwd)

    def principal_for(self, token: str) -> Principal | None:
        return next((p for p in self.principals if p.token and p.token == token), None)


def load(path: str | Path) -> Config:
    path = Path(path)
    raw = expand(json.loads(path.read_text(encoding="utf-8")))
    base = path.parent
    up = raw["upstream"]
    upstream = Upstream(up["name"], up["command"], tuple(up.get("args", [])), dict(up.get("env", {})))
    principals = [Principal(p["token"], p["agent_id"], p.get("agent_type", ""), p["workspace"], p.get("user", ""))
                  for p in raw.get("principals", [])]
    mandates = {}
    for ws, ref in raw.get("mandates", {}).items():
        doc = json.loads((base / ref).read_text(encoding="utf-8")) if isinstance(ref, str) else ref
        mandates[ws] = doc
    pt = raw.get("pretrade")
    pretrade = None
    if pt and pt.get("enabled", True):
        hf = pt.get("halt_file")
        pretrade = PretradeLimits(
            max_position_pct=pt.get("max_position_pct", 0.15),
            max_gross_exposure=pt.get("max_gross_exposure", 1.0),
            max_daily_loss_pct=pt.get("max_daily_loss_pct", 0.02),
            max_drawdown_pct=pt.get("max_drawdown_pct", 0.10),
            allowed_order_types=tuple(pt.get("allowed_order_types", ["market", "limit"])),
            allowed_time_in_force=tuple(pt.get("allowed_time_in_force", ["day"])),
            allow_extended_hours=bool(pt.get("allow_extended_hours", False)),
            halt_file=str(base / hf) if hf else None,
        )
    rt = raw.get("runtime")
    runtime = Runtime(rt["url"].rstrip("/"), rt.get("api_key", ""), rt.get("fail_mode", "closed"),
                      int(rt.get("timeout_ms", 5000))) if rt and rt.get("url") and rt.get("api_key") else None
    listen = raw.get("listen", {})
    return Config(upstream=upstream, principals=principals, mandates=mandates, pretrade=pretrade, runtime=runtime,
                  host=listen.get("host", "127.0.0.1"), port=int(listen.get("port", 8790)),
                  hide_ungranted_tools=bool(raw.get("hide_ungranted_tools", True)),
                  audit_log=str(base / raw.get("audit_log", "ogr-mcp-audit.jsonl")),
                  ledger=str(base / raw.get("ledger", "ogr-mcp-ledger.sqlite")), base_dir=base)
