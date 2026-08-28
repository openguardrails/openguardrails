#!/usr/bin/env python3
"""A reference mandate evaluator — the runtime-side check specified in
specification/mandate.md, small enough to read in one sitting.

It takes ONE mandate (schema/mandate.schema.json) and a SEQUENCE of the agent's
own tool calls, and turns each call into zero or more mandate findings
(security.mandate_violation.*). It exists to make the mechanism concrete: a
mandate is CONFIGURATION held by the runtime and resolved by workspace — never a
wire field — and a violation arrives at the enforcement point as an ordinary
finding.

    python3 evaluate_mandate.py equities-mandate.json sample_calls.json

Dependency-free (stdlib only). The evaluator is deterministic; pass --now
2026-08-04T10:00:00 to fix the clock windows are checked against (the default is
a Tuesday inside regular US trading hours, so the window rules pass unless a call
overrides its session).

⚠️ This is a teaching implementation, not a conformance target. It reads only
what a call carries (see mandate.md § "what a mandate cannot do"): it does not
resolve a CIDR, look up a live price, or know an account balance, and it reports
any dimension it cannot read as `unjudged` rather than guessing.
"""
from __future__ import annotations

import fnmatch
import ipaddress
import json
import sys
from datetime import datetime, time

WEEKDAY = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def finding(category, subject, severity="high"):
    return {"category": category, "severity": severity, "score": 1.0, "subject": subject}


def selector_matches(patterns, value):
    """glob match, with CIDR containment when both sides look like IP/networks."""
    for p in patterns:
        if fnmatch.fnmatch(value, p):
            return p
        try:
            if ipaddress.ip_address(value) in ipaddress.ip_network(p, strict=False):
                return p
        except ValueError:
            pass
    return None


class Evaluator:
    def __init__(self, mandate, now):
        self.m = mandate
        self.now = now
        self.bind = {b["tool"]: b for b in mandate.get("bindings", [])}
        self.counts = {}  # (limit_id, bucket) -> running count

    def read_fields(self, call):
        b = self.bind.get(call["name"])
        if not b:
            return None, {}, None  # unbound
        args = call.get("arguments", {})
        fields = {}
        for dim, key in b.get("fields", {}).items():
            if key in args:
                fields[dim] = args[key]
        capability = b.get("capability")
        for key, mapping in b.get("capability_map", {}).items():  # argument-conditional
            if args.get(key) in mapping:
                capability = mapping[args[key]]
        return capability, fields, b

    def check_scope(self, fields, binding, unjudged):
        scope = self.m.get("scope")
        if not scope:
            return None
        bound = binding.get("fields", {}) if binding else {}
        # scope applies to a tool only if the operator bound a target to it
        if "instrument" not in bound and "target" not in bound:
            return None
        target = fields.get("instrument") or fields.get("target")
        if target is None:  # bound, but this call omitted the value
            unjudged.append("mandate_violation.scope")
            return None
        ac = fields.get("asset_class")
        key = f"{ac}:{target}" if ac else str(target)
        if selector_matches(scope.get("deny", []), key):
            return finding("security.mandate_violation.scope", f"{key} is on the scope deny list")
        allow = scope.get("allow", [])
        if allow and not selector_matches(allow, key):
            return finding("security.mandate_violation.scope", f"{key} is outside the declared scope")
        return None

    def check_capability(self, capability, unjudged):
        caps = self.m.get("capabilities")
        if not caps:
            return None
        if capability is None:
            unjudged.append("mandate_violation.capability")
            return None
        if capability in caps.get("deny", []):
            return finding("security.mandate_violation.capability", f"{capability} is withheld")
        allow = caps.get("allow", [])
        if allow and capability not in allow:
            return finding("security.mandate_violation.capability", f"{capability} is not granted")
        return None

    def check_window(self, capability):
        wins = self.m.get("windows")
        if not wins:
            return None
        applicable = [w for w in wins
                      if capability in w.get("applies_to", {}).get("capabilities", [capability])]
        if not applicable:
            return None
        day = WEEKDAY[self.now.weekday()]
        for w in applicable:
            if w.get("days") and day not in w["days"]:
                continue
            f = time.fromisoformat(w["from"])
            t = time.fromisoformat(w["to"])
            if f <= self.now.time() <= t:
                return None  # inside at least one window
        return finding("security.mandate_violation.window",
                       f"{self.now.isoformat()} is outside every authorized window")

    def check_irreversible(self, capability, fields):
        for rule in self.m.get("irreversible", []):
            if rule["capability"] != capability:
                continue
            when = rule.get("when")
            if when is None:
                return finding("security.mandate_violation.irreversible",
                               f"{capability} is reserved to a human", "critical")
            ok = True
            for dim, expected in when.items():
                got = fields.get(dim)
                allowed = expected if isinstance(expected, list) else [expected]
                if got not in allowed:
                    ok = False
                    break
            if ok:
                return finding("security.mandate_violation.irreversible",
                               f"{rule['id']}: {capability} matched a reserved action", "critical")
        return None

    def check_limits(self, capability, fields):
        out = []
        for lim in self.m.get("limits", []):
            if lim["metric"] == "quantity":
                q = fields.get("quantity")
                if q is None:
                    continue
                if q > lim["max"]:
                    out.append(finding("security.mandate_violation.limit",
                                       f"quantity={q} > {lim['id']} ({lim['max']})"))
            elif lim["metric"] == "count":
                bucket = self._bucket(lim["window"])
                k = (lim["id"], bucket)
                self.counts[k] = self.counts.get(k, 0) + 1
                if self.counts[k] > lim["max"]:
                    out.append(finding("security.resource_exhaustion",
                                       f"{lim['id']}: {self.counts[k]} > {lim['max']} per {lim['window']}"))
            # notional/concurrency: not computable from the call alone here
        return out

    def _bucket(self, window):
        if window == "per_day":
            return self.now.date().isoformat()
        if window == "per_minute":
            return self.now.strftime("%Y-%m-%dT%H:%M")
        if window == "per_hour":
            return self.now.strftime("%Y-%m-%dT%H")
        return "all"

    def evaluate(self, call):
        unjudged: list[str] = []
        capability, fields, binding = self.read_fields(call)
        findings = []

        if binding is None:
            # Unbound: evaluate against capabilities only (mandate.md). With a
            # closed allow-list, a tool nobody bound is a capability nobody
            # granted -> denied; the other dimensions are simply unreadable.
            caps = self.m.get("capabilities", {})
            if caps.get("allow"):
                findings.append(finding("security.mandate_violation.capability",
                                        f"unbound tool '{call['name']}': capability not granted"))
            unjudged = ["mandate_violation.scope", "mandate_violation.limit",
                        "mandate_violation.window", "mandate_violation.irreversible"]
            blocking = self.m.get("on_violation", "block") == "block" and bool(findings)
            return {"decision": "block" if blocking else "allow",
                    "findings": findings, "unjudged": unjudged}

        for f in (self.check_scope(fields, binding, unjudged),
                  self.check_capability(capability, unjudged),
                  self.check_window(capability),
                  self.check_irreversible(capability, fields)):
            if f:
                findings.append(f)
        findings.extend(self.check_limits(capability, fields))
        blocking = self.m.get("on_violation", "block") == "block" and bool(findings)
        return {"decision": "block" if blocking else "allow",
                "findings": findings, "unjudged": unjudged}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    now = datetime.fromisoformat("2026-08-04T10:00:00")  # a Tuesday, inside RTH
    for a in sys.argv[1:]:
        if a.startswith("--now="):
            now = datetime.fromisoformat(a.split("=", 1)[1])
    mandate = load(args[0])
    calls = load(args[1])
    ev = Evaluator(mandate, now)
    print(f"mandate: {mandate['mandate']}  (workspace {mandate.get('workspace','-')})\n")
    mismatches = 0
    for call in calls:
        expect = call.pop("_expect", None)
        v = ev.evaluate(call)
        cats = ",".join(f["category"].split(".", 1)[1] for f in v["findings"]) or "-"
        unj = f"  unjudged={v['unjudged']}" if v["unjudged"] else ""
        flag = ""
        if expect and expect != v["decision"]:
            flag, mismatches = "  <-- MISMATCH", mismatches + 1
        print(f"  {v['decision']:5s}  {call['name']:12s} {json.dumps(call.get('arguments',{}))[:52]:52s} {cats}{unj}{flag}")
    if mismatches:
        print(f"\n{mismatches} mismatch(es) vs _expect labels")
        sys.exit(1)
    print("\nall calls matched their _expect labels")


if __name__ == "__main__":
    main()
