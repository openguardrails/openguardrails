"""A mandate evaluator for the benchmark harness — the runtime-side authorization
check of specification/mandate.md, adapted to the harness `Event`.

A mandate is CONFIGURATION, not a submitted detector: it is loaded from a JSON
file (schema/mandate.schema.json) and resolved per workspace. So this is not one
of the competing `detectors.py` entries — it is scored on its own, over the
`mandate_violation_*` corpora, by run.py.

The honest boundary the evaluator keeps (mandate.md § "what a mandate cannot do"):
it judges STRUCTURED tool calls only. On a raw `exec` shell string or a
`model_output` it ABSTAINS — those are other detectors' work — rather than
guessing at fields it cannot read.
"""
from __future__ import annotations

import fnmatch
import ipaddress
import json
from pathlib import Path

MDIM = {  # the dimensions a mandate owns
    "security.mandate_violation.scope",
    "security.mandate_violation.capability",
    "security.mandate_violation.limit",
    "security.mandate_violation.window",
    "security.mandate_violation.irreversible",
}


def load_mandate(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _selector_match(patterns, value: str):
    for p in patterns:
        if fnmatch.fnmatch(value, p):
            return p
        try:
            if ipaddress.ip_address(value) in ipaddress.ip_network(p, strict=False):
                return p
        except ValueError:
            pass
    return None


class MandateEvaluator:
    def __init__(self, mandate: dict):
        self.m = mandate
        self.bind = {b["tool"]: b for b in mandate.get("bindings", [])}
        self._counts: dict = {}

    # -- reading the agent's own structured call ---------------------------
    def _read(self, name: str, args: dict):
        b = self.bind.get(name)
        if not b:
            return None, {}, None  # unbound
        fields = {dim: args[key] for dim, key in b.get("fields", {}).items() if key in args}
        capability = b.get("capability")
        for key, mapping in b.get("capability_map", {}).items():
            if args.get(key) in mapping:
                capability = mapping[args[key]]
        return capability, fields, b

    def _scope(self, fields, binding, unjudged):
        scope = self.m.get("scope")
        if not scope:
            return None
        bound = binding.get("fields", {})
        if "instrument" not in bound and "target" not in bound:
            return None  # scope not bound to this tool
        target = fields.get("instrument") or fields.get("target")
        if target is None:
            unjudged.add("security.mandate_violation.scope")
            return None
        ac = fields.get("asset_class")
        key = f"{ac}:{target}" if ac else str(target)
        if _selector_match(scope.get("deny", []), key):
            return "security.mandate_violation.scope"
        allow = scope.get("allow", [])
        if allow and not _selector_match(allow, key):
            return "security.mandate_violation.scope"
        return None

    def _capability(self, capability, unjudged):
        caps = self.m.get("capabilities")
        if not caps:
            return None
        if capability is None:
            unjudged.add("security.mandate_violation.capability")
            return None
        if capability in caps.get("deny", []):
            return "security.mandate_violation.capability"
        allow = caps.get("allow", [])
        if allow and capability not in allow:
            return "security.mandate_violation.capability"
        return None

    def _window(self, capability, fields, unjudged):
        wins = self.m.get("windows")
        if not wins:
            return None
        applicable = [w for w in wins
                      if capability in w.get("applies_to", {}).get("capabilities", [capability])]
        if not applicable:
            return None
        session = fields.get("session")
        session_rules = [w for w in applicable if w.get("sessions")]
        if session_rules:
            if session is None:
                unjudged.add("security.mandate_violation.window")
                return None
            if any(session in w["sessions"] for w in session_rules):
                return None
            return "security.mandate_violation.window"
        # clock-form windows are not evaluable in the harness (no event clock)
        unjudged.add("security.mandate_violation.window")
        return None

    def _irreversible(self, capability, fields):
        for rule in self.m.get("irreversible", []):
            if rule["capability"] != capability:
                continue
            when = rule.get("when")
            if when is None:
                return "security.mandate_violation.irreversible"
            ok = True
            for dim, expected in when.items():
                allowed = expected if isinstance(expected, list) else [expected]
                if fields.get(dim) not in allowed:
                    ok = False
                    break
            if ok:
                return "security.mandate_violation.irreversible"
        return None

    def _limits(self, capability, fields):
        out = set()
        for lim in self.m.get("limits", []):
            if lim["metric"] == "quantity":
                q = fields.get("quantity")
                if q is not None and q > lim["max"]:
                    out.add("security.mandate_violation.limit")
            elif lim["metric"] == "count":
                self._counts[lim["id"]] = self._counts.get(lim["id"], 0) + 1
                if self._counts[lim["id"]] > lim["max"]:
                    out.add("security.resource_exhaustion")
        return out

    # -- the one entry point run.py calls ---------------------------------
    def assess(self, ev) -> dict:
        """-> {decision, categories:set, unjudged:set, judged:bool}."""
        if ev.kind != "tool_call":
            # not a structured call: the mandate does not observe it
            return {"decision": "allow", "categories": set(), "unjudged": set(), "judged": False}
        name = ev.payload.get("name", "")
        args = ev.payload.get("arguments", {}) or {}
        capability, fields, binding = self._read(name, args)
        cats: set = set()
        unjudged: set = set()

        if binding is None:
            caps = self.m.get("capabilities", {})
            if caps.get("allow"):
                cats.add("security.mandate_violation.capability")
            unjudged = set(MDIM) - cats
            decision = "block" if (self.m.get("on_violation", "block") == "block" and cats) else "allow"
            return {"decision": decision, "categories": cats, "unjudged": unjudged, "judged": True}

        for c in (self._scope(fields, binding, unjudged),
                  self._capability(capability, unjudged),
                  self._window(capability, fields, unjudged),
                  self._irreversible(capability, fields)):
            if c:
                cats.add(c)
        cats |= self._limits(capability, fields)
        decision = "block" if (self.m.get("on_violation", "block") == "block" and cats) else "allow"
        return {"decision": decision, "categories": cats, "unjudged": unjudged, "judged": True}

    def evaluate(self, ev) -> str:
        return self.assess(ev)["decision"]
