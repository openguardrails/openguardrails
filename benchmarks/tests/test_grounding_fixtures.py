"""Shape checks on the grounding corpora, profiles and record worlds — the same
kind of executable label validation the healthcare fixtures get, plus the
invariants a domain profile must keep: every id it emits is a registered leaf,
every regex compiles, every conclusion's required field exists, and the worlds
are declared synthetic.
"""
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "benchmarks" / "harness"
SAFETY = ROOT / "benchmarks" / "suites" / "safety"
sys.path.insert(0, str(HARNESS))

from grounding import GDIM  # noqa: E402
from ogrlib import Event  # noqa: E402

SUITES = {
    "grounding_ip": ("grounding_ip.profile.json", "grounding_ip.records.json"),
    "grounding_life_sciences": ("grounding_life_sciences.profile.json", "grounding_life_sciences.records.json"),
}
OWNERS = {"grounding", "judge", "mandate", "injection", "secret_leak", "unsafe_advice_healthcare"}
KNOWN_OTHER = {"security.mandate_violation.capability", "security.prompt_injection",
               "security.secret_leak.api_key", "safety.unsafe_advice.medication_interaction"}
ID_RE = re.compile(r"^(safety|security|privacy|x)\.[a-z0-9_.]+$")  # verdict.schema.json


def load_jsonl(p: Path) -> list[dict]:
    cases = []
    for n, raw in enumerate(p.read_text(encoding="utf-8").splitlines(), start=1):
        if raw.strip():
            try:
                cases.append(json.loads(raw))
            except json.JSONDecodeError as exc:
                pytest.fail(f"{p.name}: invalid JSON on line {n}: {exc}")
    return cases


@pytest.mark.parametrize("suite", list(SUITES))
def test_corpus_labels(suite):
    cases = load_jsonl(SAFETY / f"{suite}.jsonl")
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "case ids must be unique"
    for c in cases:
        assert c["suite"] == suite, c["id"]
        assert c["owner"] in OWNERS, c["id"]
        cats = set()
        for cat in c["expected_categories"]:
            assert set(cat) == {"id", "domain"}, c["id"]
            assert ID_RE.match(cat["id"]), c["id"]
            assert cat["id"].startswith(cat["domain"] + "."), c["id"]
            cats.add(cat["id"])
        assert c["unsafe"] is bool(cats), c["id"]
        if c["owner"] in ("grounding", "judge"):
            assert cats <= GDIM, f"{c['id']}: a grounding case may only expect grounding leaves"
            assert c["event"]["kind"] == "model_output", c["id"]
            assert Event.from_case(c).text(), c["id"]
            if c["unsafe"]:
                assert c.get("rule", "").startswith(("OG-IP-", "OG-LS-")), c["id"]
        else:
            assert cats <= KNOWN_OTHER, f"{c['id']}: lane case expects an id this fixture set does not know"
        if c["owner"] == "judge":
            assert c["unsafe"], f"{c['id']}: judge fixtures are positives"
    owners = {c["owner"] for c in cases}
    assert {"grounding", "judge"} <= owners
    assert any(c.get("expect_unjudged") for c in cases), "a provider-outage case is required"


@pytest.mark.parametrize("suite", list(SUITES))
def test_profile_invariants(suite):
    profile_file, records_file = SUITES[suite]
    prof = json.loads((SAFETY / profile_file).read_text(encoding="utf-8"))
    assert prof["profile"] and prof["domain"]
    assert prof.get("on_violation", "flag") in ("flag", "block")
    for cat, outcome in prof.get("outcomes", {}).items():
        assert cat in GDIM and outcome in ("flag", "block"), cat

    ref_types = set()
    for r in prof["references"]:
        assert bool(r.get("pattern")) != bool(r.get("lexicon")), r["type"]
        if r.get("pattern"):
            re.compile(r["pattern"])
        ref_types.add(r["type"])

    for a in prof.get("assertions", []):
        assert a["reference"] in ref_types, a["id"]
        re.compile(a["pattern"])
        assert a.get("mode", "equals") in ("equals", "contains", "date"), a["id"]
        assert a.get("absent", "unjudged") in ("unjudged", "mismatch"), a["id"]
        assert a["rule"].startswith(("OG-IP-", "OG-LS-")), a["id"]

    fields = {}
    for f in prof.get("fields", []):
        assert bool(f.get("pattern")) != bool(f.get("resolved")), f["id"]
        if f.get("pattern"):
            re.compile(f["pattern"])
        else:
            assert f["resolved"]["type"] in ref_types, f["id"]
        assert f.get("missing", "safety.unsafe_advice.evidence_gap") in GDIM, f["id"]
        fields[f["id"]] = f

    for c in prof.get("conclusions", []):
        assert c["cues"], c["id"]
        for x in c["cues"] + c.get("determination", []):
            re.compile(x)
        for fid in c.get("requires", []):
            assert fid in fields, f"{c['id']} requires unknown field {fid}"
        assert c.get("verifiability") in ("record", "structural", "judgment"), c["id"]


@pytest.mark.parametrize("suite", list(SUITES))
def test_record_world_is_declared_synthetic_and_frozen(suite):
    _, records_file = SUITES[suite]
    world = json.loads((SAFETY / records_file).read_text(encoding="utf-8"))
    assert "SYNTHETIC" in world["world"]
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", world["as_of"])
    for rtype, recs in world["records"].items():
        assert recs, rtype
    for entry in world.get("unavailable", []):
        rtype, key = entry.split(":", 1)
        assert rtype in world["records"], entry
        assert key not in world["records"][rtype], f"{entry}: an unavailable id must not also resolve"
