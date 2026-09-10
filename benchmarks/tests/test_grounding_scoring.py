"""The grounding-scoring path wired into harness/run.py.

Three things are checked: that the reference profiles score perfectly on their
own seed (a regression guard — if a reference grammar, an assertion, a required
field or the lane boundary breaks, this drops below 1.0); that the metric is not
vacuous (an empty profile, which recognises no reference and declares no
conclusion class, must score recall 0 on the same positives); and that a
provider outage surfaces as `unjudged`, never as a finding.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "benchmarks" / "harness"
sys.path.insert(0, str(HARNESS))

import run  # noqa: E402
from ogrlib import Event  # noqa: E402
from grounding import GDIM, GroundingEvaluator, RecordStore, load_profile, load_records  # noqa: E402


def test_reference_profiles_score_perfectly_on_their_seed():
    result = run.run_grounding()
    assert result["suites"], "no grounding suites scored"
    assert result["macroF1"] == 1.0
    for suite in result["suites"]:
        assert suite["fp"] == 0, f"{suite['suite']}: fired on a compliant control"
        assert suite["fn"] == 0, f"{suite['suite']}: missed an owned violation"
        assert suite["f1"] == 1.0, suite["suite"]
        assert suite["leafAccuracy"] == 1.0, f"{suite['suite']}: wrong leaf named"
        assert suite["laneDiscipline"] == 1.0, f"{suite['suite']}: fired outside its lane"
        assert suite["laneCases"] > 0, f"{suite['suite']}: no lane-discipline cases exercised"
        assert suite["unjudgedHonesty"] == 1.0, f"{suite['suite']}: provider outage mishandled"
        assert suite["unjudgedCases"] > 0, f"{suite['suite']}: no provider-outage case exercised"
        assert suite["judgeCases"] > 0, f"{suite['suite']}: no judge fixtures carried"


@pytest.mark.parametrize("suite", list(run.GROUNDING_SUITES))
def test_empty_profile_catches_nothing(suite):
    """Discrimination check: with no references and no conclusions, every owned
    positive is a miss."""
    cases = run.load_jsonl(run.SAFETY / f"{suite}.jsonl")
    _, records_file = run.GROUNDING_SUITES[suite]
    ev_empty = GroundingEvaluator({"profile": "empty"}, load_records(run.SAFETY / records_file))
    owned_positives = flagged = 0
    for c in cases:
        if c.get("owner") == "grounding" and c["unsafe"]:
            owned_positives += 1
            if ev_empty.assess(Event.from_case(c))["categories"] & GDIM:
                flagged += 1
    assert owned_positives > 0
    assert flagged == 0, "an empty profile should flag nothing — metric is vacuous"


@pytest.mark.parametrize("suite", list(run.GROUNDING_SUITES))
def test_provider_outage_is_unjudged_not_a_finding(suite):
    """Take every owned NEGATIVE, make the provider unavailable for everything, and
    check that nothing becomes a citation finding: 'could not look' is not 'found
    nothing' and it is not 'found a fabrication' either."""
    profile_file, records_file = run.GROUNDING_SUITES[suite]
    profile = load_profile(run.SAFETY / profile_file)
    world = load_records(run.SAFETY / records_file)
    dark = RecordStore({"as_of": world.as_of, "records": world.records})
    dark.resolve = lambda rtype, key: (RecordStore.UNAVAILABLE, None)  # type: ignore[assignment]
    ev = GroundingEvaluator(profile, dark)
    seen = 0
    for c in run.load_jsonl(run.SAFETY / f"{suite}.jsonl"):
        if c.get("owner") != "grounding" or c["unsafe"]:
            continue
        res = ev.assess(Event.from_case(c))
        assert "safety.hallucination.citation" not in res["categories"], c["id"]
        assert "safety.hallucination.attribute" not in res["categories"], c["id"]
        if res["judged"] and ev._references(c["event"]["payload"]["text"]):
            assert res["unjudged"], f"{c['id']}: an unanswered reference must be confessed"
            seen += 1
    assert seen > 0


def test_citation_blocks_and_the_rest_flag():
    """The seed profiles block only a fabricated record; everything else is an
    allow carrying findings — the outcome table is per leaf."""
    for suite, (profile_file, records_file) in run.GROUNDING_SUITES.items():
        ev = GroundingEvaluator(load_profile(run.SAFETY / profile_file), load_records(run.SAFETY / records_file))
        for c in run.load_jsonl(run.SAFETY / f"{suite}.jsonl"):
            if c.get("owner") != "grounding":
                continue
            res = ev.assess(Event.from_case(c))
            if "safety.hallucination.citation" in res["categories"]:
                assert res["decision"] == "block", c["id"]
            else:
                assert res["decision"] == "allow", c["id"]
