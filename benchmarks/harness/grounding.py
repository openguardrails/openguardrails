"""A grounding evaluator for the benchmark harness — the runtime-side evidence
check of specification/grounding.md, adapted to the harness `Event`.

A grounding profile is CONFIGURATION, not a submitted detector: it is loaded from
a JSON file (schema/grounding-profile.schema.json) and resolved per workspace,
and it needs a RECORD PROVIDER — here a frozen fixture world, in a deployment a
patent office feed, ClinicalTrials.gov, a vendor database. So this is not one of
the competing `detectors.py` entries — it is scored on its own, over the
`grounding_*` corpora, by run.py.

The honest boundary the evaluator keeps (grounding.md § "what grounding cannot do"):
it verifies the REFERENCES an answer makes and the ATTRIBUTES it asserts about
them, and it checks that a conclusion of a declared class carries the evidence
envelope the profile requires. It does not judge whether the answer is right. On
anything that is not model output it ABSTAINS — a tool call is the mandate's, a
shell string is the command judge's — rather than guessing. Rules the profile
tags `judgment` (a real record that does not support the proposition attributed
to it) are NOT implemented here: they are a model judge's, and the corpus carries
them as fixtures with `owner: "judge"`.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

GDIM = {  # the leaves a grounding profile owns
    "safety.hallucination.citation",
    "safety.hallucination.attribute",
    "safety.hallucination.unsupported",
    "safety.unsafe_advice.overreach",
    "safety.unsafe_advice.evidence_gap",
    "safety.unsafe_advice.jurisdiction",
    "safety.unsafe_advice.temporal",
}

_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_FLAGS = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


def _compile(pattern: str, flags: str = "") -> re.Pattern:
    f = 0
    for ch in flags:
        f |= _FLAGS[ch]
    return re.compile(pattern, f)


def load_profile(path: str | Path) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_records(path: str | Path) -> "RecordStore":
    with open(path, encoding="utf-8") as fh:
        return RecordStore(json.load(fh))


class RecordStore:
    """The harness's record provider: a frozen synthetic world.

    resolve() answers one of three things, and the difference between the last
    two is the whole point: NOT FOUND is a finding, UNAVAILABLE is coverage the
    verdict must confess in `unjudged`."""

    FOUND, NOT_FOUND, UNAVAILABLE = "found", "not_found", "unavailable"

    def __init__(self, world: dict):
        self.as_of = world.get("as_of")
        self.records = world.get("records", {})
        self.unavailable = set(world.get("unavailable", []))

    def resolve(self, rtype: str, key: str):
        if f"{rtype}:{key}" in self.unavailable:
            return self.UNAVAILABLE, None
        rec = self.records.get(rtype, {}).get(key)
        return (self.FOUND, rec) if rec is not None else (self.NOT_FOUND, None)

    def names(self, rtype: str) -> list[str]:
        return list(self.records.get(rtype, {}).keys())


def _get_path(obj, dotted: str):
    """Walk 'approvals.FDA.status' through a record; None when any hop is absent."""
    cur = obj
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _substitute(template: str, m: re.Match) -> str:
    out = template
    for i in range(1, (m.re.groups or 0) + 1):
        out = out.replace(f"${i}", (m.group(i) or "").strip())
    return out


def _normalize(value: str, norm: dict | None) -> str:
    if not norm:
        return value
    v = value
    if norm.get("strip"):
        v = re.sub(norm["strip"], "", v)
    if norm.get("strip_suffix"):
        v = re.sub(norm["strip_suffix"], "", v)
    if norm.get("upper"):
        v = v.upper()
    return v


class GroundingEvaluator:
    def __init__(self, profile: dict, provider: RecordStore):
        self.p = profile
        self.provider = provider
        self.refs = []
        for r in profile.get("references", []):
            self.refs.append({
                "type": r["type"],
                "pattern": _compile(r["pattern"], r.get("flags", "")) if r.get("pattern") else None,
                "lexicon": bool(r.get("lexicon")),
                "normalize": r.get("normalize"),
            })
        self.assertions = [dict(a, _re=_compile(a["pattern"], a.get("flags", "i")))
                           for a in profile.get("assertions", [])]
        self.fields = {f["id"]: dict(f, _re=_compile(f["pattern"], f.get("flags", "i")) if f.get("pattern") else None)
                       for f in profile.get("fields", [])}
        self.conclusions = [dict(c,
                                 _cues=[_compile(x, "i") for x in c.get("cues", [])],
                                 _det=[_compile(x, "i") for x in c.get("determination", [])])
                            for c in profile.get("conclusions", [])]
        self.outcomes = profile.get("outcomes", {})
        self.default_outcome = profile.get("on_violation", "flag")

    # -- references: what the answer points at -------------------------------
    def _references(self, text: str) -> list[dict]:
        found = []
        for r in self.refs:
            if r["lexicon"]:
                for name in self.provider.names(r["type"]):
                    for m in re.finditer(r"\b" + re.escape(name) + r"\b", text, re.IGNORECASE):
                        found.append({"type": r["type"], "key": name, "raw": m.group(0),
                                      "start": m.start(), "end": m.end()})
            elif r["pattern"] is not None:
                for m in r["pattern"].finditer(text):
                    found.append({"type": r["type"], "key": _normalize(m.group(0), r["normalize"]),
                                  "raw": m.group(0), "start": m.start(), "end": m.end()})
        return found

    def _resolve(self, refs: list[dict], unjudged: set, findings: list):
        for ref in refs:
            status, rec = self.provider.resolve(ref["type"], ref["key"])
            ref["status"], ref["record"] = status, rec
            if status == RecordStore.NOT_FOUND:
                findings.append({"category": "safety.hallucination.citation",
                                 "subject": ref["raw"], "start": ref["start"], "end": ref["end"]})
            elif status == RecordStore.UNAVAILABLE:
                unjudged.add(f"payload.text#{ref['type']}:{ref['key']}")

    # -- assertions: what the answer says ABOUT a record -----------------------
    def _assertions(self, text: str, refs: list[dict], unjudged: set, findings: list):
        sentences = []
        pos = 0
        for s in _SENTENCE.split(text):
            start = text.find(s, pos)
            sentences.append((start, start + len(s), s))
            pos = start + len(s)
        for a in self.assertions:
            for (s0, s1, s) in sentences:
                in_sentence = [r for r in refs if r["type"] == a["reference"] and s0 <= r["start"] < s1]
                if not in_sentence:
                    continue
                for m in a["_re"].finditer(s):
                    attr = _substitute(a["attribute"], m)
                    want = _substitute(str(a["value"]), m)
                    want = a.get("map", {}).get(want, want)
                    # An assertion is ABOUT the nearest reference in its sentence
                    # (the one it follows, or failing that the one it precedes).
                    # "X (published 2013) and Y (published 2008)" binds each date
                    # to its own record; a real extractor does this with a parser
                    # or a model, and this is the floor a benchmark can rely on.
                    a0 = s0 + m.start()
                    ref = min(in_sentence, key=lambda r: (a0 - r["end"]) if r["end"] <= a0 else (r["start"] - a0) + 0.5)
                    for ref in (ref,):
                        if ref["status"] != RecordStore.FOUND:
                            continue
                        have = _get_path(ref["record"], attr)
                        if have is None:
                            if a.get("absent", "unjudged") == "mismatch":
                                findings.append({"category": "safety.hallucination.attribute",
                                                 "subject": f"{ref['raw']}: {attr}={want!r} (record: none)",
                                                 "start": s0 + m.start(), "end": s0 + m.end()})
                            else:
                                unjudged.add(f"payload.text#{ref['type']}:{ref['key']}.{attr}")
                            continue
                        if not self._matches(have, want, a.get("mode", "equals")):
                            findings.append({"category": "safety.hallucination.attribute",
                                             "subject": f"{ref['raw']}: {attr}={want!r} (record: {have!r})",
                                             "start": s0 + m.start(), "end": s0 + m.end()})

    @staticmethod
    def _matches(have, want: str, mode: str) -> bool:
        if mode == "contains":
            hay = have if isinstance(have, list) else [have]
            return any(want.lower() in str(h).lower() for h in hay)
        if mode == "date":
            return str(have)[:10] == want[:10]
        if isinstance(have, list):
            return want.lower() in {str(h).lower() for h in have}
        if isinstance(have, (int, float)) and not isinstance(have, bool):
            return str(have) == want.replace(",", "")
        return str(have).lower() == want.lower()

    # -- conclusions: what the answer must SHOW before it may conclude ---------
    def _conclusions(self, text: str, refs: list[dict], findings: list):
        for c in self.conclusions:
            cue_hits = [m for cue in c["_cues"] for m in cue.finditer(text)]
            if not cue_hits:
                continue
            for det in c["_det"]:
                for m in det.finditer(text):
                    findings.append({"category": "safety.unsafe_advice.overreach",
                                     "subject": f"{c['id']}: {m.group(0)}",
                                     "start": m.start(), "end": m.end()})
            for fid in c.get("requires", []):
                f = self.fields[fid]
                if f.get("resolved"):
                    want_type, need = f["resolved"]["type"], f["resolved"].get("min", 1)
                    have = sum(1 for r in refs if r["type"] == want_type and r["status"] == RecordStore.FOUND)
                    ok = have >= need
                else:
                    ok = len(f["_re"].findall(text)) >= f.get("min", 1)
                if not ok:
                    findings.append({"category": f.get("missing", "safety.unsafe_advice.evidence_gap"),
                                     "subject": f"{c['id']}: missing {fid}"})

    # -- the one entry point run.py calls --------------------------------------
    def assess(self, ev) -> dict:
        """-> {decision, categories:set, unjudged:set, judged:bool, findings:list}."""
        if ev.kind != "model_output":
            return {"decision": "allow", "categories": set(), "unjudged": set(),
                    "judged": False, "findings": []}
        text = ev.payload.get("text", "") or ""
        findings: list = []
        unjudged: set = set()
        refs = self._references(text)
        self._resolve(refs, unjudged, findings)
        self._assertions(text, refs, unjudged, findings)
        self._conclusions(text, refs, findings)
        cats = {f["category"] for f in findings}
        block = any(self.outcomes.get(cat, self.default_outcome) == "block" for cat in cats)
        return {"decision": "block" if block else "allow", "categories": cats,
                "unjudged": unjudged, "judged": True, "findings": findings}

    def evaluate(self, ev) -> str:
        return self.assess(ev)["decision"]
