"""Mandate evaluator for tool calls held by the gateway (specification/mandate.md, schema/mandate.schema.json).

Same semantics as examples/mandate-agent/evaluate_mandate.py, made durable:
  * count windows are kept in a Ledger (sqlite) so per_minute / per_day survive restarts and
    are shared by every connection of the same workspace;
  * `notional` is judged per_call when the ticket carries it; a ticket carrying only a
    quantity leaves the notional limit UNJUDGED (the runtime must not invent a price) — the
    pretrade layer, which may look prices up, covers that gap;
  * every finding carries `action` (block | flag) from the rule's own `on_violation`, falling
    back to the mandate default.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from datetime import datetime, time, timezone
from typing import Callable, Protocol
from zoneinfo import ZoneInfo

WEEKDAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DIMENSIONS = ("scope", "capability", "limit", "window", "irreversible")


class Ledger(Protocol):
    def bump(self, workspace: str, limit_id: str, bucket: str) -> int: ...


@dataclass
class Verdict:
    decision: str                      # "allow" | "block"
    findings: list[dict] = field(default_factory=list)
    unjudged: list[str] = field(default_factory=list)
    capability: str | None = None
    fields: dict = field(default_factory=dict)
    mandate: str = ""

    @property
    def blocked(self) -> bool:
        return self.decision == "block"


def finding(category: str, subject: str, action: str, severity: str = "high", detector: str = "") -> dict:
    return {"category": category, "severity": severity, "score": 1.0, "subject": subject,
            "action": action, "detector": detector}


def selector_matches(patterns: list[str], value: str) -> str | None:
    for p in patterns:
        if fnmatch.fnmatchcase(value, p):
            return p
    return None


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class Mandate:
    def __init__(self, doc: dict, ledger: Ledger | None = None, clock: Callable[[], datetime] | None = None):
        self.doc = doc
        self.name = doc["mandate"]
        self.version = doc.get("version", "")
        self.default_action = doc.get("on_violation", "block")
        self.bind = {b["tool"]: b for b in doc.get("bindings", [])}
        self.ledger = ledger
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.detector = f"mandate:{self.name}"

    # ---- reading the call ----
    def read(self, tool: str, args: dict):
        b = self.bind.get(tool)
        if not b:
            return None, {}, None
        fields = {dim: args[key] for dim, key in b.get("fields", {}).items() if key in args and args[key] is not None}
        capability = b.get("capability")
        for key, mapping in b.get("capability_map", {}).items():
            raw = args.get(key)
            if raw is None:
                continue
            probe = str(raw).lower() if isinstance(raw, bool) else str(raw)
            if probe in mapping:
                capability = mapping[probe]
        return capability, fields, b

    def _f(self, category: str, subject: str, action: str | None = None, severity: str = "high") -> dict:
        return finding(category, subject, action or self.default_action, severity, self.detector)

    # ---- the five dimensions ----
    def check_scope(self, fields: dict, binding: dict, unjudged: list[str]) -> dict | None:
        scope = self.doc.get("scope")
        if not scope:
            return None
        bound = binding.get("fields", {})
        if "instrument" not in bound and "target" not in bound:
            return None
        target = fields.get("instrument", fields.get("target"))
        if target is None:
            unjudged.append("mandate_violation.scope")
            return None
        ac = fields.get("asset_class")
        key = f"{ac}:{target}" if ac else str(target)
        if selector_matches(scope.get("deny", []), key):
            return self._f("security.mandate_violation.scope", f"{key} is on the scope deny list")
        allow = scope.get("allow", [])
        if allow and not selector_matches(allow, key):
            return self._f("security.mandate_violation.scope", f"{key} is outside the declared scope")
        return None

    def check_capability(self, capability: str | None, unjudged: list[str]) -> dict | None:
        caps = self.doc.get("capabilities")
        if not caps:
            return None
        if capability is None:
            unjudged.append("mandate_violation.capability")
            return None
        if capability in caps.get("deny", []):
            return self._f("security.mandate_violation.capability", f"{capability} is withheld")
        allow = caps.get("allow", [])
        if allow and capability not in allow:
            return self._f("security.mandate_violation.capability", f"{capability} is not granted")
        return None

    def check_window(self, capability: str | None, unjudged: list[str]) -> dict | None:
        wins = self.doc.get("windows")
        if not wins:
            return None
        applicable = [w for w in wins if capability in w.get("applies_to", {}).get("capabilities", [capability])]
        if not applicable:
            return None
        now = self.clock()
        for w in applicable:
            if "from" not in w or "to" not in w:      # session-label windows: nothing on an MCP call to read
                unjudged.append("mandate_violation.window")
                return None
            local = now.astimezone(ZoneInfo(w["timezone"])) if w.get("timezone") else now
            if w.get("days") and WEEKDAY[local.weekday()] not in w["days"]:
                continue
            if time.fromisoformat(w["from"]) <= local.time() <= time.fromisoformat(w["to"]):
                return None
        return self._f("security.mandate_violation.window", f"{now.isoformat()} is outside every authorized window")

    def check_irreversible(self, capability: str | None, fields: dict) -> dict | None:
        for rule in self.doc.get("irreversible", []):
            if rule["capability"] != capability:
                continue
            when = rule.get("when")
            if when is None:
                return self._f("security.mandate_violation.irreversible", f"{rule['id']}: {capability} is reserved to a human",
                               rule.get("on_violation"), "critical")
            if all(fields.get(dim) in (exp if isinstance(exp, list) else [exp]) for dim, exp in when.items()):
                return self._f("security.mandate_violation.irreversible", f"{rule['id']}: {capability} matched a reserved action",
                               rule.get("on_violation"), "critical")
        return None

    def check_limits(self, workspace: str, capability: str | None, fields: dict, unjudged: list[str]) -> list[dict]:
        out = []
        for lim in self.doc.get("limits", []):
            applies = lim.get("applies_to", {}).get("capabilities")
            if applies and capability not in applies:
                continue
            action = lim.get("on_violation")
            metric, window = lim["metric"], lim["window"]
            if metric in ("quantity", "notional"):
                v = _num(fields.get(metric))
                if v is None:
                    if metric in fields or metric == "notional":
                        unjudged.append("mandate_violation.limit")
                    continue
                if v > lim["max"]:
                    out.append(self._f("security.mandate_violation.limit",
                                       f"{metric}={v:g} > {lim['id']} ({lim['max']}{' ' + lim['unit'] if lim.get('unit') else ''})", action))
            elif metric == "count":
                if self.ledger is None or window == "per_call":
                    n = 1
                else:
                    n = self.ledger.bump(workspace, f"{self.name}:{lim['id']}", self._bucket(window))
                if n > lim["max"]:
                    out.append(self._f("security.resource_exhaustion", f"{lim['id']}: {n} > {lim['max']} per {window}", action))
            # concurrency: not observable from a single held call
        return out

    def _bucket(self, window: str) -> str:
        now = self.clock().astimezone(timezone.utc)
        return {"per_day": now.strftime("%Y-%m-%d"), "per_hour": now.strftime("%Y-%m-%dT%H"),
                "per_minute": now.strftime("%Y-%m-%dT%H:%M")}.get(window, "all")

    # ---- entry point ----
    def evaluate(self, workspace: str, tool: str, args: dict) -> Verdict:
        capability, fields, binding = self.read(tool, args or {})
        v = Verdict("allow", capability=capability, fields=fields, mandate=self.name)
        if binding is None:
            caps = self.doc.get("capabilities", {})
            if caps.get("allow"):
                v.findings.append(self._f("security.mandate_violation.capability",
                                          f"unbound tool '{tool}': capability not granted"))
            v.unjudged = ["mandate_violation.scope", "mandate_violation.limit",
                          "mandate_violation.window", "mandate_violation.irreversible"]
        else:
            for f in (self.check_scope(fields, binding, v.unjudged),
                      self.check_capability(capability, v.unjudged),
                      self.check_window(capability, v.unjudged),
                      self.check_irreversible(capability, fields)):
                if f:
                    v.findings.append(f)
            v.findings.extend(self.check_limits(workspace, capability, fields, v.unjudged))
        if any(f["action"] == "block" for f in v.findings):
            v.decision = "block"
        return v

    def grants(self, tool: str) -> bool:
        """Would this tool's plain capability be allowed at all? Used to hide ungranted tools from
        list_tools so an agent is not shown doors it cannot open. Argument-conditional
        capabilities are not considered here; the call is still judged in full."""
        b = self.bind.get(tool)
        caps = self.doc.get("capabilities", {})
        cap = b.get("capability") if b else None
        if cap is None:
            return not caps.get("allow")
        if cap in caps.get("deny", []):
            return False
        return not caps.get("allow") or cap in caps["allow"]
