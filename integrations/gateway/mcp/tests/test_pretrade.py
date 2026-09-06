import pytest

from ogr_mcp_gateway.ledger import MemoryLedger
from ogr_mcp_gateway.pretrade import PretradeLimits, check


class Reader:
    def __init__(self, equity=100_000, cash=100_000, last=100_000, positions=None, px=100.0):
        self.a = {"equity": equity, "cash": cash, "last_equity": last}; self.p = positions or {}; self.px = px
    async def account(self): return self.a
    async def positions(self): return self.p
    async def price(self, s): return self.px


L = PretradeLimits()


async def run(args, reader, cap="order.place", ledger=None, limits=L):
    return await check(cap, "place_stock_order", args, limits, reader, ledger or MemoryLedger(), "ws")


async def test_reads_are_ignored():
    assert await run({}, Reader(), cap="data.read") == []


async def test_position_cap():
    f = await run({"symbol": "SPY", "side": "buy", "notional": "20000"}, Reader())
    assert f and "15%" in f[0]["subject"]


async def test_qty_priced_from_reader():
    f = await run({"symbol": "SPY", "side": "buy", "qty": "100"}, Reader(px=200.0))   # 20,000 notional
    assert f and "15%" in f[0]["subject"]
    assert await run({"symbol": "SPY", "side": "buy", "qty": "100"}, Reader(px=100.0)) == []


async def test_no_short_no_margin_no_gross_leverage():
    assert "short" in (await run({"symbol": "SPY", "side": "sell", "notional": "1000"}, Reader()))[0]["subject"]
    f = await run({"symbol": "SPY", "side": "buy", "notional": "10000"}, Reader(cash=5000))
    assert any("cash" in x["subject"] for x in f)
    pos = {s: 14_000 for s in ("XLK", "XLF", "XLE", "XLV", "XLI", "XLP", "XLY")}
    f = await run({"symbol": "SPY", "side": "buy", "notional": "5000"}, Reader(cash=2000, positions=pos))
    assert any("cash" in x["subject"] or "gross" in x["subject"] for x in f)


async def test_daily_loss_and_drawdown_halt_even_closes():
    f = await run({"symbol": "SPY", "side": "sell", "notional": "100"}, Reader(equity=97_000, last=100_000), cap="order.close")
    assert f and "daily loss" in f[0]["subject"]
    led = MemoryLedger(); led.put("ws", "peak_equity", 120_000)
    f = await run({"symbol": "SPY", "side": "buy", "notional": "100"}, Reader(equity=100_000, last=100_000), ledger=led)
    assert f and "drawdown" in f[0]["subject"]


async def test_ticket_shape():
    f = await run({"symbol": "SPY", "side": "buy", "notional": "100", "type": "stop", "time_in_force": "gtc"}, Reader())
    assert len(f) == 2


async def test_halt_file(tmp_path):
    hf = tmp_path / "HALT"; hf.write_text("x")
    lim = PretradeLimits(halt_file=str(hf))
    f = await run({"symbol": "SPY", "side": "buy", "notional": "100"}, Reader(), limits=lim)
    assert f[0]["severity"] == "critical" and f[0]["category"] == "security.pretrade.halt"
    assert await run({}, Reader(), cap="order.cancel", limits=lim) == []
