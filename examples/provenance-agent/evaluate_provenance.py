#!/usr/bin/env python3
"""A reference provenance evaluator — the runtime-side derivation specified in
specification/provenance.md, small enough to read in one sitting.

It takes ONE policy (bindings + provenance rules, runtime configuration) and a
SEQUENCE of GuardEvents, and turns each step's tool calls into zero or more
`security.tainted_action` findings. It exists to make one claim concrete: the
control judges an EDGE, not a text, and the edge here spans four days and two
sessions.

    python3 evaluate_provenance.py policy.json episode.json
    python3 evaluate_provenance.py policy.json episode.json --no-sources
    python3 evaluate_provenance.py policy.json episode.json --no-provenance

`--no-sources` drops the optional wire field and shows what the runtime still
derives without it. Note the direction of the conformance rule: WITH the field a
runtime MUST NOT reach a LESS strict decision than without it. Dropping it here
turns a BLOCK into a FLAG — permissive, which is the safe way to be wrong about
a self-declared label.
`--no-provenance` is the control group: point judgment only, which is what every
deployment without this control sees.

Dependency-free (stdlib only), deterministic, no network.

⚠️ This is a teaching implementation, not a conformance target. Its injection
detector is a stub that always abstains — deliberately, because the episode's
tainting email carries no injection signature and the whole point is that the
control holds anyway. A real runtime runs detectors here and lowers `untrusted`
to `hostile` on a hit.
"""
from __future__ import annotations

import fnmatch
import json
import sys

# hostile is the floor; the ordering is total (provenance.md § Trust levels).
TRUST_ORDER = ["hostile", "untrusted", "user", "trusted"]
ROLE_TRUST = {"system": "trusted", "user": "user", "tool": "untrusted"}

BOLD, DIM, RED, YEL, GRN, OFF = "\033[1m", "\033[2m", "\033[31m", "\033[33m", "\033[32m", "\033[0m"


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def floor(a, b):
    """The lower of two trust levels. Trust never rises (rule 3)."""
    if a is None:
        return b
    if b is None:
        return a
    return a if TRUST_ORDER.index(a) < TRUST_ORDER.index(b) else b


def matches(patterns, value):
    return any(fnmatch.fnmatch(value, p) for p in patterns)


def tool_of(call):
    return call.get("function", {}).get("name", "")


def args_of(call):
    raw = call.get("function", {}).get("arguments", "{}")
    try:
        return json.loads(raw) if isinstance(raw, str) else (raw or {})
    except json.JSONDecodeError:
        return {}


def detect_injection(_text):
    """Stub. Always abstains — see the module docstring."""
    return False


class Runtime:
    """Holds the ledger. In OGR the ledger lives entirely in the runtime, which
    is why the cross-session edge is visible here and nowhere else."""

    def __init__(self, policy, use_sources=True):
        self.policy = policy
        self.use_sources = use_sources
        self.bind = {b["tool"]: b for b in policy.get("bindings", [])}
        self.prov = policy.get("provenance", {})
        self.memory = {}          # key -> trust   (the cross-session edge)

    # -- trust derivation -------------------------------------------------

    def label(self, event):
        """path -> trust, for every message in the payload."""
        payload = event.get("payload", {})
        messages = payload.get("messages", [])

        # call_id -> (tool, args), so a tool RESULT can be traced to what produced it
        produced_by = {}
        for m in messages:
            for c in m.get("tool_calls", []) or []:
                produced_by[c.get("id")] = (tool_of(c), args_of(c))

        labels, why = {}, {}
        for i, m in enumerate(messages):
            path = f"payload.messages.{i}.content"
            role = m.get("role", "")
            t = ROLE_TRUST.get(role)          # assistant -> None: derived, takes the floor
            reason = f"role={role}"

            if role == "tool":
                tool, targs = produced_by.get(m.get("tool_call_id"), ("", {}))
                b = self.bind.get(tool, {})
                # A read from a durable store RESTORES the taint its write carried.
                if b.get("capability") == "memory.read":
                    key = targs.get(b.get("key_field", "key"))
                    if key in self.memory:
                        t = floor(t, self.memory[key])
                        reason = f"memory_read '{key}' -> taint restored from the ledger"
                if detect_injection(m.get("content", "")):
                    t = "hostile"
                    reason += " + injection finding"

            labels[path] = t
            why[path] = reason

        if self.use_sources:
            for s in event.get("sources", []) or []:
                p = s.get("path")
                if p not in labels:
                    continue                  # a path naming nothing is dropped, never an error
                # `sources` may only ever LOWER trust.
                for rule in self.prov.get("lower_trust", []):
                    w = rule.get("when", {})
                    if w.get("channel") and s.get("channel") != w["channel"]:
                        continue
                    ok = True
                    for k, accepted in (w.get("auth") or {}).items():
                        if (s.get("auth") or {}).get(k) not in accepted:
                            ok = False
                    if not ok:
                        continue
                    lowered = floor(labels[p], rule["to"])
                    if lowered != labels[p]:
                        labels[p] = lowered
                        why[p] = (f"{s.get('channel')} from {s.get('origin')} "
                                  f"(dmarc={(s.get('auth') or {}).get('dmarc')}) "
                                  f"-> rule '{rule['id']}'")
        return labels, why

    def context_floor(self, labels):
        """Rule 1: derived content takes the lowest trust in context. A model does
        not report which tokens it drew on, so this is the only honest answer."""
        f, at = None, None
        for path, t in labels.items():
            if t is None:
                continue
            if f is None or TRUST_ORDER.index(t) < TRUST_ORDER.index(f):
                f, at = t, path
        return (f or "trusted"), at

    # -- enforcement ------------------------------------------------------

    def judge(self, event):
        labels, why = self.label(event)
        ctx, at = self.context_floor(labels)

        out = {"floor": ctx, "floor_at": at, "why": why.get(at, ""),
               "calls": [], "findings": [], "unjudged": []}

        for n, call in enumerate(event.get("payload", {}).get("tool_calls", []) or []):
            tool, targs = tool_of(call), args_of(call)
            path = f"payload.tool_calls.{n}"
            b = self.bind.get(tool)

            if not b:
                # Unbound is not permitted-by-default, and it is not guessed either.
                out["unjudged"].append(path)
                out["calls"].append((tool, "?", "unjudged", None))
                continue

            cap = b["capability"]
            verdict, fired = "allow", None
            for rule in self.prov.get("rules", []):
                w = rule["when"]
                if ctx in w.get("trust", []) and matches(w.get("capability", []), cap):
                    verdict, fired = rule["then"], rule["id"]
                    break

            # Sinks inherit (rule 2): a durable write carries the context floor.
            if cap == "memory.write" and verdict != "block":
                key = targs.get(b.get("key_field", "key"))
                if key:
                    self.memory[key] = floor(self.memory.get(key), ctx)

            if verdict in ("block", "flag"):
                out["findings"].append({
                    "category": "security.tainted_action",
                    "severity": "critical" if verdict == "block" else "high",
                    "path": f"{path}.arguments",   # the ACTION, never the tainting content
                    "score": 1.0,
                    "detector": "provenance",
                })
            out["calls"].append((tool, cap, verdict, fired))

        out["decision"] = "block" if any(c[2] == "block" for c in out["calls"]) else "allow"
        return out


def run(policy, episode, use_sources=True, use_provenance=True):
    rt = Runtime(policy, use_sources)
    blocked = 0

    for step in episode["steps"]:
        ev = step["event"]
        print(f"\n{BOLD}{step['day']}  {ev['step_id']}{OFF}  {DIM}{step['note']}{OFF}")

        if not use_provenance:
            calls = ev.get("payload", {}).get("tool_calls", []) or []
            for c in calls:
                print(f"   {tool_of(c):<14} {GRN}allow{OFF}   {DIM}(point judgment only: "
                      f"no injection signature in this payload){OFF}")
            continue

        r = rt.judge(ev)
        print(f"   context floor: {r['floor']:<10} {DIM}{r['floor_at'] or ''}"
              f"{('  — ' + r['why']) if r['why'] else ''}{OFF}")
        for tool, cap, verdict, fired in r["calls"]:
            colour = {"block": RED, "flag": YEL, "allow": GRN, "unjudged": DIM}[verdict]
            tail = f"   {DIM}rule '{fired}'{OFF}" if fired else ""
            print(f"   {tool:<14} {cap:<14} {colour}{verdict.upper()}{OFF}{tail}")
        for f in r["findings"]:
            print(f"   {DIM}finding {f['category']} @ {f['path']}{OFF}")
        for p in r["unjudged"]:
            print(f"   {DIM}unjudged: {p}  (no binding — a capability is never guessed){OFF}")
        if r["decision"] == "block":
            blocked += 1

    return blocked


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    if len(args) != 2:
        print(__doc__)
        return 2

    policy, episode = load(args[0]), load(args[1])
    use_sources = "--no-sources" not in flags
    use_prov = "--no-provenance" not in flags

    mode = ("point judgment only (no provenance)" if not use_prov
            else "provenance, sources withheld" if not use_sources
            else "provenance, sources present")
    print(f"{BOLD}episode:{OFF} {episode['episode']}   {BOLD}mode:{OFF} {mode}")

    blocked = run(policy, episode, use_sources, use_prov)
    print(f"\n{BOLD}steps blocked: {blocked}{OFF}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
