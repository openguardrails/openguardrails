import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from mcp_types import CallToolResult, TextContent, Tool

from ogr_mcp_gateway import config as cfgmod
from ogr_mcp_gateway.gateway import Gateway, UpstreamAccountReader
from ogr_mcp_gateway.ledger import MemoryLedger

ROOT = Path(__file__).resolve().parents[1]


def wrap(data):
    return CallToolResult(content=[TextContent(type="text", text=json.dumps({"_alpaca_mcp_security": {}, "data": data}))])


class FakeAlpaca:
    name = "alpaca"
    def __init__(self):
        self.calls = []
        self.account = {"equity": "100000", "cash": "100000", "last_equity": "100000"}
        self.positions = []
    async def list_tools(self):
        names = ["get_account_info", "get_all_positions", "get_stock_latest_trade", "place_stock_order",
                 "place_option_order", "close_all_positions", "cancel_order_by_id"]
        return [Tool(name=n, input_schema={"type": "object"}) for n in names]
    async def call_tool(self, name, args):
        self.calls.append((name, args))
        if name == "get_account_info": return wrap(self.account)
        if name == "get_all_positions": return wrap(self.positions)
        if name == "get_stock_latest_trade": return wrap({args["symbols"]: {"price": 500.0}})
        return wrap({"id": "order-1", "status": "accepted", **args})


@pytest.fixture
def gw(tmp_path, monkeypatch):
    for k in ("OGR_MCP_TOKEN_JUNIOR", "OGR_MCP_TOKEN_MID", "OGR_MCP_TOKEN_SENIOR", "ALPACA_API_KEY", "ALPACA_SECRET_KEY"):
        monkeypatch.setenv(k, k.lower())
    monkeypatch.delenv("OGR_RUNTIME_URL", raising=False); monkeypatch.delenv("OGR_API_KEY", raising=False)
    cfg = cfgmod.load(ROOT / "config.example.json")
    cfg.audit_log = str(tmp_path / "audit.jsonl")
    up = FakeAlpaca()
    g = Gateway(cfg, up, MemoryLedger())
    for m in g.mandates.values():
        m.clock = lambda: datetime(2026, 9, 8, 10, 30, tzinfo=ZoneInfo("America/New_York"))
    return g, up, cfg


def principal(cfg, ws):
    return next(p for p in cfg.principals if p.workspace == ws)


async def test_tools_are_filtered_per_tier(gw):
    g, up, cfg = gw
    assert {t.name for t in await g.tools_for(principal(cfg, "quant-junior"))} == {"get_account_info", "get_all_positions", "get_stock_latest_trade"}
    senior = {t.name for t in await g.tools_for(principal(cfg, "quant-senior"))}
    assert "place_stock_order" in senior and "place_option_order" not in senior and "close_all_positions" not in senior
    assert await g.tools_for(None) == []


async def test_senior_order_passes_all_layers_and_is_audited(gw):
    g, up, cfg = gw
    r = await g.call(principal(cfg, "quant-senior"), "place_stock_order", {"symbol": "SPY", "side": "buy", "qty": "10"})
    assert not r.is_error and up.calls[-1][0] == "place_stock_order"
    line = json.loads(Path(cfg.audit_log).read_text().splitlines()[-1])
    assert line["decision"] == "allow" and line["capability"] == "order.place" and line["workspace"] == "quant-senior"
    assert "mandate_violation.limit" in line["unjudged"]      # qty-only ticket: mandate could not judge notional; pretrade did


async def test_pretrade_blocks_oversized_qty_order(gw):
    g, up, cfg = gw
    r = await g.call(principal(cfg, "quant-senior"), "place_stock_order", {"symbol": "SPY", "side": "buy", "qty": "40"})  # 20k
    body = json.loads(r.content[0].text)["_ogr"]
    assert r.is_error and body["stage"] == "pretrade" and "15%" in body["reason"]
    assert all(c[0] != "place_stock_order" for c in up.calls)


async def test_mandate_blocks_before_touching_upstream(gw):
    g, up, cfg = gw
    r = await g.call(principal(cfg, "quant-junior"), "place_stock_order", {"symbol": "SPY", "side": "buy", "notional": "10"})
    assert r.is_error and json.loads(r.content[0].text)["_ogr"]["stage"] == "mandate" and up.calls == []


async def test_unknown_workspace_gets_nothing(gw):
    g, up, cfg = gw
    p = cfgmod.Principal("t", "x", "x", "nowhere")
    r = await g.call(p, "get_account_info", {})
    assert r.is_error and json.loads(r.content[0].text)["_ogr"]["stage"] == "identity"


async def test_runtime_fail_closed(gw, monkeypatch):
    g, up, cfg = gw
    cfg.runtime = cfgmod.Runtime("http://127.0.0.1:1", "k", "closed", 300)
    r = await g.call(principal(cfg, "quant-junior"), "get_account_info", {})
    assert r.is_error and json.loads(r.content[0].text)["_ogr"]["stage"] == "runtime"
    cfg.runtime = cfgmod.Runtime("http://127.0.0.1:1", "k", "open", 300)
    r = await g.call(principal(cfg, "quant-junior"), "get_account_info", {})
    assert not r.is_error


async def test_account_reader_parses_alpaca_shapes():
    up = FakeAlpaca(); up.positions = [{"symbol": "spy", "market_value": "1234.5"}, {"symbol": "QQQ", "market_value": None}]
    rd = UpstreamAccountReader(up)
    assert (await rd.account())["equity"] == "100000"
    assert await rd.positions() == {"SPY": 1234.5, "QQQ": 0.0}
    assert await rd.price("SPY") == 500.0


async def test_http_app_has_bearer_auth(gw):
    from starlette.middleware.authentication import AuthenticationMiddleware
    from ogr_mcp_gateway.serve import StaticTokenVerifier, build_http_app, build_server
    g, up, cfg = gw
    app = build_http_app(build_server(g, None), cfg)
    assert any(m.cls is AuthenticationMiddleware for m in app.user_middleware)
    tok = await StaticTokenVerifier(cfg).verify_token(principal(cfg, "quant-senior").token)
    assert tok and tok.client_id == "claude-senior" and tok.scopes == ["quant-senior"]
    assert await StaticTokenVerifier(cfg).verify_token("nope") is None
