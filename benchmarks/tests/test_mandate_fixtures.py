"""Structural validation of the mandate-violation category-expectation corpora.

These two suites (trading, security-operations) are the executable form of the
agentic-trading and security-operations mapping tables in
specification/taxonomy.md, and of the envelope dimensions in
specification/mandate.md. Like the healthcare fixtures they carry
`expected_categories` rather than being scored by the binary seed-v0 leaderboard:
the reference detectors do not evaluate a mandate (a mandate is runtime
configuration, not a detector), so this test checks that the labels are
well-formed and internally consistent, keeping the corpora CI-covered.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "benchmarks" / "harness"
SUITES = ROOT / "benchmarks" / "suites" / "security"
sys.path.insert(0, str(HARNESS))

from ogrlib import Event  # noqa: E402

FIXTURES = {
    "mandate_violation_trading": SUITES / "mandate_violation_trading.jsonl",
    "mandate_violation_secops": SUITES / "mandate_violation_secops.jsonl",
}

# Every id these corpora reference must live in the security.* namespace of
# specification/taxonomy.md. The mandate/market/restricted/persistence ids are
# the ones OGR 1.3 adds; the rest are pre-existing.
ALLOWED = {
    "security.mandate_violation.scope",
    "security.mandate_violation.capability",
    "security.mandate_violation.limit",
    "security.mandate_violation.window",
    "security.mandate_violation.irreversible",
    "security.market_manipulation.spoofing",
    "security.market_manipulation.wash_trade",
    "security.market_manipulation.marking",
    "security.market_manipulation.momentum_ignition",
    "security.market_manipulation.quote_stuffing",
    "security.restricted_information.mnpi",
    "security.restricted_information.client_order_flow",
    "security.persistence",
    "security.resource_exhaustion",
    "security.prompt_injection",
    "security.secret_leak.api_key",
    "security.data_exfiltration",
    "security.malicious_command",
    "security.privilege_escalation",
    "security.supply_chain",
}

VALID_KINDS = {"tool_call", "exec", "model_output"}


def load_cases(path: Path) -> list[dict]:
    assert path.is_file(), f"missing fixture file: {path}"
    cases = []
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            cases.append(json.loads(raw))
        except json.JSONDecodeError as exc:
            pytest.fail(f"{path.name}: invalid JSON on line {n}: {exc}")
    return cases


@pytest.mark.parametrize("suite,path", FIXTURES.items())
def test_mandate_fixtures_wellformed(suite: str, path: Path) -> None:
    cases = load_cases(path)
    ids = [c["id"] for c in cases]

    assert ids, f"{suite}: no cases"
    assert len(ids) == len(set(ids)), f"{suite}: case ids must be unique"
    assert any(c["unsafe"] for c in cases), f"{suite}: needs positive cases"
    assert any(not c["unsafe"] for c in cases), \
        f"{suite}: needs at least one compliant (safe) control case"

    for case in cases:
        cid = case["id"]
        assert case["suite"] == suite, cid

        actual = set()
        for cat in case["expected_categories"]:
            assert set(cat) == {"id", "domain"}, cid
            assert cat["domain"] == "security", cid
            assert cat["id"].startswith("security."), cid
            assert cat["id"] in ALLOWED, f"{cid}: unregistered category {cat['id']}"
            actual.add(cat["id"])

        # A case is unsafe iff it expects at least one category — the same
        # invariant the healthcare corpus holds.
        assert case["unsafe"] is bool(actual), cid

        event = Event.from_case(case)
        assert event.kind in VALID_KINDS, cid
        assert event.text(), f"{cid}: event carries no inspectable text"
