"""Pre-trade state checks: the OMS layer.

specification/mandate.md is explicit that a mandate reads only what a call carries and is not
a pre-trade risk control (proposals/quant-agent-mandate.md, D9). This module is that other
thing, kept separate so the boundary stays visible: it LOOKS STATE UP (account, positions, a
price) before an order-placing call is forwarded, and produces ordinary findings. Its
thresholds are gateway configuration, not mandate fields.

Only capabilities starting with `order.` are examined. Everything here is deterministic.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .mandate import finding

DETECTOR = "pretrade"
CAT = "security.pretrade."   # leaves: halt, drawdown, daily_loss, ticket, price, position, cash, exposure, state
CAT_LIMIT = CAT + "state"
CAT_CAP = CAT + "ticket"


class AccountReader(Protocol):
    async def account(self) -> dict: ...            # {"equity", "cash", "last_equity"}
    async def positions(self) -> dict[str, float]: ...  # symbol -> signed market value
    async def price(self, symbol: str) -> float | None: ...


@dataclass(frozen=True)
class PretradeLimits:
    max_position_pct: float = 0.15
    max_gross_exposure: float = 1.0
    max_daily_loss_pct: float = 0.02
    max_drawdown_pct: float = 0.10
    allowed_order_types: tuple[str, ...] = ("market", "limit")
    allowed_time_in_force: tuple[str, ...] = ("day",)
    allow_extended_hours: bool = False
    halt_file: str | None = None


def _f(subject: str, category: str = CAT_LIMIT, severity: str = "high") -> dict:
    return finding(category if "." in category.removeprefix(CAT) or category.startswith("security.") else CAT + category,
                   subject, "block", severity, DETECTOR)


def _num(v) -> float | None:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


async def check(capability: str | None, tool: str, args: dict, limits: PretradeLimits,
                reader: AccountReader, ledger, workspace: str) -> list[dict]:
    if not capability or not capability.startswith("order."):
        return []
    out: list[dict] = []
    if limits.halt_file and Path(limits.halt_file).exists() and capability != "order.cancel":
        return [_f(f"halt file {limits.halt_file} present: all order.* withheld", CAT + "halt", "critical")]
    if capability not in ("order.place", "order.close"):
        return out

    acct = await reader.account()
    equity, cash, last_eq = _num(acct.get("equity")) or 0.0, _num(acct.get("cash")) or 0.0, _num(acct.get("last_equity")) or 0.0
    if equity <= 0:
        return [_f("account equity unreadable; refusing to size an order", CAT + "state")]

    # account-level stops (apply to closes too: a halted book is a halted book)
    peak = max(ledger.get(workspace, "peak_equity", equity), equity)
    ledger.put(workspace, "peak_equity", peak)
    dd = 1 - equity / peak
    if dd > limits.max_drawdown_pct:
        out.append(_f(f"drawdown {dd:.1%} from peak {peak:,.0f} exceeds {limits.max_drawdown_pct:.0%}", CAT + "drawdown", "critical"))
    if last_eq > 0:
        dl = 1 - equity / last_eq
        if dl > limits.max_daily_loss_pct:
            out.append(_f(f"daily loss {dl:.1%} exceeds {limits.max_daily_loss_pct:.0%}", CAT + "daily_loss", "critical"))
    if out or capability == "order.close":
        return out

    # ticket shape
    otype = str(args.get("type", "market")).lower()
    tif = str(args.get("time_in_force", "day")).lower()
    if otype not in limits.allowed_order_types:
        out.append(_f(f"order type {otype!r} not in {list(limits.allowed_order_types)}", CAT_CAP))
    if tif not in limits.allowed_time_in_force:
        out.append(_f(f"time_in_force {tif!r} not in {list(limits.allowed_time_in_force)}", CAT_CAP))
    if args.get("extended_hours") and not limits.allow_extended_hours:
        out.append(_f("extended_hours is withheld", CAT_CAP))
    side = str(args.get("side", "")).lower()
    if side not in ("buy", "sell"):
        out.append(_f(f"side {side!r} is not buy/sell", CAT_CAP))
    if out:
        return out

    # size the order in dollars
    symbol = str(args.get("symbol", "")).upper()
    notional = _num(args.get("notional"))
    if notional is None:
        qty = _num(args.get("qty"))
        px = await reader.price(symbol) if qty else None
        if qty is None or px is None:
            return [_f(f"cannot size order for {symbol}: no notional and no price for qty", CAT + "price")]
        notional = qty * px
    signed = notional if side == "buy" else -notional

    positions = await reader.positions()
    cur = positions.get(symbol, 0.0)
    new = cur + signed
    if new < -1e-6:
        out.append(_f(f"{symbol}: selling {notional:,.0f} against {cur:,.0f} held would go short", CAT + "position"))
    if abs(new) > limits.max_position_pct * equity + 1e-6:
        out.append(_f(f"{symbol}: position {new:,.0f} would exceed {limits.max_position_pct:.0%} of equity {equity:,.0f}", CAT + "position"))
    if side == "buy" and notional > cash + 1e-6:
        out.append(_f(f"buy {notional:,.0f} exceeds cash {cash:,.0f} (no margin)", CAT + "cash"))
    gross = sum(abs(v) for s, v in positions.items() if s != symbol) + abs(new)
    if gross > limits.max_gross_exposure * equity + 1e-6:
        out.append(_f(f"gross exposure {gross:,.0f} would exceed {limits.max_gross_exposure:.0%} of equity", CAT + "exposure"))
    return out
