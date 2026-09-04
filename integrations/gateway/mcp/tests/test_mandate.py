from datetime import datetime
from zoneinfo import ZoneInfo

from ogr_mcp_gateway.ledger import MemoryLedger
from ogr_mcp_gateway.mandate import Mandate

RTH = lambda: datetime(2026, 9, 8, 10, 30, tzinfo=ZoneInfo("America/New_York"))   # a Tuesday, inside RTH
NIGHT = lambda: datetime(2026, 9, 8, 21, 0, tzinfo=ZoneInfo("America/New_York"))


def order(**kw):
    return {"symbol": "SPY", "side": "buy", "notional": "1000", "type": "market", "time_in_force": "day", **kw}


def test_senior_may_place_in_scope_order_in_rth(senior):
    v = Mandate(senior, MemoryLedger(), RTH).evaluate("quant-senior", "place_stock_order", order())
    assert v.decision == "allow" and v.capability == "order.place" and not v.findings


def test_scope_deny_outside_universe(senior):
    v = Mandate(senior, MemoryLedger(), RTH).evaluate("quant-senior", "place_stock_order", order(symbol="TSLA"))
    assert v.blocked and v.findings[0]["category"] == "security.mandate_violation.scope"


def test_short_via_capability_map(senior):
    v = Mandate(senior, MemoryLedger(), RTH).evaluate("quant-senior", "place_stock_order", order(side="sell_short"))
    assert v.blocked and v.capability == "order.short"


def test_extended_hours_bool_maps_to_denied_capability(senior):
    v = Mandate(senior, MemoryLedger(), RTH).evaluate("quant-senior", "place_stock_order", order(extended_hours=True))
    assert v.blocked and v.capability == "order.extended_hours"


def test_notional_cap_and_unjudged_when_only_qty(senior):
    m = Mandate(senior, MemoryLedger(), RTH)
    big = m.evaluate("quant-senior", "place_stock_order", order(notional="20000"))
    assert big.blocked and "per-order-notional" in big.findings[0]["subject"]
    q = m.evaluate("quant-senior", "place_stock_order", {**order(), "notional": None, "qty": "10"})
    assert q.decision == "allow" and "mandate_violation.limit" in q.unjudged


def test_window_blocks_after_hours(senior):
    v = Mandate(senior, MemoryLedger(), NIGHT).evaluate("quant-senior", "place_stock_order", order())
    assert v.blocked and v.findings[0]["category"] == "security.mandate_violation.window"


def test_window_does_not_apply_to_reads(senior):
    v = Mandate(senior, MemoryLedger(), NIGHT).evaluate("quant-senior", "get_account_info", {})
    assert v.decision == "allow"


def test_rate_limit_counts_across_calls(senior):
    m = Mandate(senior, MemoryLedger(), RTH)
    results = [m.evaluate("quant-senior", "place_stock_order", order()) for _ in range(6)]
    assert [r.decision for r in results] == ["allow"] * 5 + ["block"]
    assert results[-1].findings[0]["category"] == "security.resource_exhaustion"


def test_irreversible_unwind_is_critical(senior):
    v = Mandate(senior, MemoryLedger(), RTH).evaluate("quant-senior", "close_all_positions", {})
    assert v.blocked and any(f["severity"] == "critical" for f in v.findings)


def test_junior_is_read_only(junior):
    m = Mandate(junior, MemoryLedger(), RTH)
    assert m.evaluate("quant-junior", "get_stock_bars", {"symbols": "SPY"}).decision == "allow"
    assert m.evaluate("quant-junior", "place_stock_order", order()).blocked
    assert m.evaluate("quant-junior", "cancel_order_by_id", {"order_id": "x"}).blocked


def test_unbound_tool_is_not_granted_under_closed_allow(junior):
    v = Mandate(junior, MemoryLedger(), RTH).evaluate("quant-junior", "some_new_tool", {})
    assert v.blocked and len(v.unjudged) == 4


def test_grants_hides_denied_tools(senior, junior):
    s, j = Mandate(senior), Mandate(junior)
    assert s.grants("place_stock_order") and not s.grants("place_option_order") and not s.grants("close_all_positions")
    assert j.grants("get_account_info") and not j.grants("place_stock_order")
