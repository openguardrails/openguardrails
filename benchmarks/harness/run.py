#!/usr/bin/env python3
"""Run the reference detectors over the OGR seed suites and score them.

    python3 harness/run.py

Each category file under suites/security/*.jsonl holds positive (unsafe) cases.
suites/security/_benign.jsonl holds the shared negative (safe) cases, paired with
every category. Output: per-detector per-suite precision/recall/F1 + p95 latency,
written to leaderboard/results.json and leaderboard/RESULTS.md.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from ogrlib import Event, predicted_unsafe          # noqa: E402
from detectors import REFERENCE_DETECTORS           # noqa: E402
from mandate import MandateEvaluator, load_mandate, MDIM  # noqa: E402

ROOT = HERE.parent
SUITES = ROOT / "suites" / "security"
OUT = ROOT / "leaderboard"

SUITE_ORDER = ["prompt_injection", "malicious_command", "data_exfiltration", "secret_leak"]

# Mandate scoring is SEPARATE from the vendor leaderboard: a mandate is runtime
# configuration, not a submitted detector. Each corpus is paired with the mandate
# that governs its agent.
MANDATE_SUITES = {
    "mandate_violation_trading": "mandate_trading.mandate.json",
    "mandate_violation_secops": "mandate_secops.mandate.json",
}


def load_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


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


def score_mandate(name: str, mandate_file: str) -> dict:
    """Score ONE mandate over its corpus. A mandate owns only the
    security.mandate_violation.* dimensions, so it is scored on the cases whose
    expected category is one of those (positives) against the compliant control
    cases (negatives). Cases owned by other detectors — injection, secret leak,
    manipulation, MNPI, raw-shell exec — are NOT counted for or against it; the
    mandate must simply stay in its lane and abstain, which is reported
    separately as lane discipline."""
    cases = load_jsonl(SUITES / f"{name}.jsonl")
    ev_mandate = MandateEvaluator(load_mandate(SUITES / mandate_file))

    tp = fp = fn = tn = 0
    dim_hits = dim_total = 0
    lane_ok = lane_total = 0
    lat: list[float] = []
    for c in cases:
        ev = Event.from_case(c)
        t0 = time.perf_counter()
        res = ev_mandate.assess(ev)
        lat.append((time.perf_counter() - t0) * 1000)
        flagged = res["decision"] == "block"
        expected = {x["id"] for x in c.get("expected_categories", [])}
        owns = c.get("owner") == "mandate"

        if owns and c["unsafe"]:                     # positive the mandate owns
            want = expected & MDIM
            if flagged:
                tp += 1
                dim_total += 1
                if (res["categories"] & MDIM) == want:
                    dim_hits += 1
            else:
                fn += 1
                dim_total += 1
        elif owns and not c["unsafe"]:               # compliant control (negative)
            if flagged:
                fp += 1
            else:
                tn += 1
        else:                                        # another detector's case
            lane_total += 1
            if not flagged:
                lane_ok += 1

    prec = tp / (tp + fp) if (tp + fp) else 0.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
    return {"suite": name, "mandate": mandate_file,
            "precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3),
            "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "dimensionAccuracy": round(dim_hits / dim_total, 3) if dim_total else 0.0,
            "laneDiscipline": round(lane_ok / lane_total, 3) if lane_total else 1.0,
            "laneCases": lane_total,
            "p95ms": round(p95(lat), 4)}


def run_mandate() -> dict:
    suites = [score_mandate(n, f) for n, f in MANDATE_SUITES.items()]
    macro = round(sum(s["f1"] for s in suites) / len(suites), 3) if suites else 0.0
    return {"suites": suites, "macroF1": macro}


def main() -> None:
    negatives = load_jsonl(SUITES / "_benign.jsonl")
    suites = {s: load_jsonl(SUITES / f"{s}.jsonl") for s in SUITE_ORDER}

    results = []
    for det in REFERENCE_DETECTORS:
        per_suite, f1s, lats = {}, [], []
        for s in SUITE_ORDER:
            r = score(det, suites[s] + negatives)
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
               "counts": {s: {"unsafe": len(suites[s]), "safe": len(negatives)} for s in SUITE_ORDER},
               "detectors": results,
               "mandate": run_mandate()}
    (OUT / "results.json").write_text(json.dumps(payload, indent=2) + "\n")
    write_markdown(payload)
    print_table(payload)


def write_markdown(p: dict) -> None:
    cols = ["prompt_injection", "malicious_command", "data_exfiltration", "secret_leak"]
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

    m = p.get("mandate")
    if m and m["suites"]:
        lines += ["", "## Mandate scoring (the authorization envelope)", "",
                  "Scored SEPARATELY from the leaderboard above: a mandate is runtime "
                  "configuration, not a submitted detector. Each corpus is judged by the "
                  "mandate that governs its agent "
                  "([specification/mandate.md](../../specification/mandate.md)). "
                  "Precision/recall are over the cases a mandate OWNS "
                  "(`security.mandate_violation.*`) against the compliant controls; "
                  "**dimension** is how often the right envelope dimension was named; "
                  "**lane** is how often the mandate correctly abstained on cases another "
                  "detector owns (injection, secret leak, manipulation, MNPI, raw exec).", "",
                  "| Mandate | P | R | F1 | Dimension | Lane (n) |",
                  "|---|---|---|---|---|---|"]
        for su in m["suites"]:
            lines.append("| {mandate} | {precision:.3f} | {recall:.3f} | **{f1:.3f}** | "
                         "{dimensionAccuracy:.3f} | {laneDiscipline:.3f} ({laneCases}) |".format(**su))
        lines += ["", f"Macro-F1 across mandates: **{m['macroF1']:.3f}**."]
    (OUT / "RESULTS.md").write_text("\n".join(lines) + "\n")


def print_table(p: dict) -> None:
    cols = p["suiteOrder"]
    print(f"\nOGR seed benchmark ({p['version']}) — macro-F1 ranked\n")
    print(f"{'detector':<26} {'type':<9} " + " ".join(f"{c[:8]:>8}" for c in cols) + f" {'macro':>7}")
    for d in p["detectors"]:
        f1s = " ".join(f"{d['perSuite'][c]['f1']:>8.3f}" for c in cols)
        print(f"{d['name']:<26} {d['type']:<9} {f1s} {d['macroF1']:>7.3f}")
    m = p.get("mandate")
    if m and m["suites"]:
        print(f"\nmandate scoring (config, not a detector) — macro-F1 {m['macroF1']:.3f}\n")
        print(f"{'mandate':<26} {'prec':>6} {'rec':>6} {'f1':>6} {'dim':>6} {'lane':>6}")
        for su in m["suites"]:
            print(f"{su['suite'].replace('mandate_violation_',''):<26} "
                  f"{su['precision']:>6.3f} {su['recall']:>6.3f} {su['f1']:>6.3f} "
                  f"{su['dimensionAccuracy']:>6.3f} {su['laneDiscipline']:>6.3f}")
    print(f"\nwrote {OUT/'results.json'} and {OUT/'RESULTS.md'}")


if __name__ == "__main__":
    main()
