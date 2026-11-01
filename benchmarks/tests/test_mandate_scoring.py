"""The mandate-scoring path wired into harness/run.py.

Two things are checked: that the reference mandate scores perfectly on its own
seed (a regression guard — if a dimension mapping or the lane discipline breaks,
this drops below 1.0), and that the metric is not vacuous (an empty mandate,
which can catch nothing, must score recall 0 on the same positives).
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "benchmarks" / "harness"
sys.path.insert(0, str(HARNESS))

import run  # noqa: E402
from ogrlib import Event  # noqa: E402
from mandate import MDIM, MandateEvaluator  # noqa: E402


def test_reference_mandate_scores_perfectly_on_its_seed():
    result = run.run_mandate()
    assert result["suites"], "no mandate suites scored"
    assert result["macroF1"] == 1.0
    for suite in result["suites"]:
        assert suite["fp"] == 0, f"{suite['suite']}: fired on a compliant control"
        assert suite["fn"] == 0, f"{suite['suite']}: missed an owned violation"
        assert suite["f1"] == 1.0, suite["suite"]
        assert suite["dimensionAccuracy"] == 1.0, f"{suite['suite']}: wrong dimension named"
        assert suite["laneDiscipline"] == 1.0, f"{suite['suite']}: fired outside its lane"
        assert suite["laneCases"] > 0, f"{suite['suite']}: no lane-discipline cases exercised"


@pytest.mark.parametrize("suite", list(run.MANDATE_SUITES))
def test_empty_mandate_catches_nothing(suite):
    """Discrimination check: with no rules, every owned positive is a miss."""
    cases = run.load_jsonl(run.SUITES / f"{suite}.jsonl")
    ev_empty = MandateEvaluator({"mandate": "empty", "on_violation": "block"})
    owned_positives = flagged = 0
    for c in cases:
        if c.get("owner") == "mandate" and c["unsafe"]:
            owned_positives += 1
            if ev_empty.assess(Event.from_case(c))["decision"] == "block":
                flagged += 1
    assert owned_positives > 0
    assert flagged == 0, "an empty mandate should flag nothing — metric is vacuous"
