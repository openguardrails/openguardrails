#!/usr/bin/env python3
"""Run the reference detectors over the OGR seed suites and score them.

    python3 harness/run.py

Each category file under suites/<domain>/*.jsonl holds positive (unsafe) cases.
Each domain can provide a sibling _benign.jsonl with negative (safe) cases,
paired with every category in that domain. Output: per-detector per-suite precision/recall/F1 + p95 latency,
written to leaderboard/results.json and leaderboard/RESULTS.md.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from ogrlib import Event, predicted_unsafe          # noqa: E402
from detectors import REFERENCE_DETECTORS           # noqa: E402

ROOT = HERE.parent
OUT = ROOT / "leaderboard"

SUITE_FILES = {
    "prompt_injection": ROOT / "suites" / "security" / "prompt_injection.jsonl",
    "malicious_command": ROOT / "suites" / "security" / "malicious_command.jsonl",
    "data_exfiltration": ROOT / "suites" / "security" / "data_exfiltration.jsonl",
    "secret_leak": ROOT / "suites" / "security" / "secret_leak.jsonl",
    "unsafe_advice": ROOT / "suites" / "safety" / "unsafe_advice.jsonl",
}
SUITE_ORDER = list(SUITE_FILES)


def load_jsonl(p: Path) -> list[dict]:
    cases = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    validate_cases(p, cases)
    return cases


def load_negatives(suite_file: Path) -> list[dict]:
    return load_jsonl(suite_file.with_name("_benign.jsonl"))


def validate_cases(p: Path, cases: list[dict]) -> None:
    for case in cases:
        expected = case.get("expected_categories")
        if expected is None:
            continue
        if not isinstance(expected, list):
            raise ValueError(f"{p}:{case.get('id')} expected_categories must be a list")
        for cat in expected:
            if not isinstance(cat, dict):
                raise ValueError(f"{p}:{case.get('id')} expected category must be an object")
            if cat.get("domain") not in {"safety", "security"}:
                raise ValueError(f"{p}:{case.get('id')} category domain must be safety or security")
            cid = cat.get("id")
            if not isinstance(cid, str) or "." not in cid:
                raise ValueError(f"{p}:{case.get('id')} category id must be a dotted string")
            if not cid.startswith(cat["domain"] + "."):
                raise ValueError(f"{p}:{case.get('id')} category id must match its domain")
            score = cat.get("score")
            if score is not None and (not isinstance(score, (int, float)) or not 0 <= score <= 1):
                raise ValueError(f"{p}:{case.get('id')} category score must be between 0 and 1")


def p95(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]


def score(detector, cases: list[dict]) -> dict:
    tp = fp = fn = tn = 0
    lat: list[float] = []
    for c in cases:
        ev = Event.from_case(c)
        t0 = time.perf_counter()
        decision = detector.evaluate(ev)
        lat.append((time.perf_counter() - t0) * 1000)
        pred = predicted_unsafe(decision)
        truth = bool(c["unsafe"])
        if pred and truth:
            tp += 1
        elif pred and not truth:
            fp += 1
        elif not pred and truth:
            fn += 1
        else:
            tn += 1
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3),
            "tp": tp, "fp": fp, "fn": fn, "tn": tn, "p95ms": round(p95(lat), 4)}


def main() -> None:
    suites = {s: load_jsonl(SUITE_FILES[s]) for s in SUITE_ORDER}
    negatives = {s: load_negatives(SUITE_FILES[s]) for s in SUITE_ORDER}

    results = []
    for det in REFERENCE_DETECTORS:
        per_suite, f1s, lats = {}, [], []
        for s in SUITE_ORDER:
            r = score(det, suites[s] + negatives[s])
            per_suite[s] = r
            f1s.append(r["f1"])
            lats.append(r["p95ms"])
        macro = round(sum(f1s) / len(f1s), 3)
        results.append({"name": det.name, "type": det.type,
                        "perSuite": per_suite, "macroF1": macro,
                        "p95ms": round(max(lats), 4)})

    results.sort(key=lambda r: r["macroF1"], reverse=True)
    OUT.mkdir(exist_ok=True)
    payload = {"version": "seed-v0", "suiteOrder": SUITE_ORDER,
               "counts": {s: {"unsafe": len(suites[s]), "safe": len(negatives[s])} for s in SUITE_ORDER},
               "detectors": results}
    (OUT / "results.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    write_markdown(payload)
    print_table(payload)


def write_markdown(p: dict) -> None:
    cols = p["suiteOrder"]
    head = ["Detector", "Type"] + [c.replace("_", " ") + " F1" for c in cols] + ["Macro F1", "P95 ms"]
    lines = ["# OGR seed benchmark — results (`seed-v0`)", "",
             "Reference detectors only. Third-party vendors appear when they submit "
             "a conformant detector. OpenGuardrails does not submit a detector.", "",
             "| " + " | ".join(head) + " |",
             "|" + "|".join(["---"] * len(head)) + "|"]
    for d in p["detectors"]:
        row = [d["name"], d["type"]] + [f"{d['perSuite'][c]['f1']:.3f}" for c in cols] + \
              [f"**{d['macroF1']:.3f}**", f"{d['p95ms']:.3f}"]
        lines.append("| " + " | ".join(row) + " |")
    counts = p["counts"]
    lines += ["", "Suite sizes (unsafe / shared safe): " +
              ", ".join(f"{c.replace('_',' ')} {counts[c]['unsafe']}/{counts[c]['safe']}" for c in cols)]
    (OUT / "RESULTS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def print_table(p: dict) -> None:
    cols = p["suiteOrder"]
    print(f"\nOGR seed benchmark ({p['version']}) — macro-F1 ranked\n")
    print(f"{'detector':<26} {'type':<9} " + " ".join(f"{c[:8]:>8}" for c in cols) + f" {'macro':>7}")
    for d in p["detectors"]:
        f1s = " ".join(f"{d['perSuite'][c]['f1']:>8.3f}" for c in cols)
        print(f"{d['name']:<26} {d['type']:<9} {f1s} {d['macroF1']:>7.3f}")
    print(f"\nwrote {OUT/'results.json'} and {OUT/'RESULTS.md'}")


if __name__ == "__main__":
    main()
