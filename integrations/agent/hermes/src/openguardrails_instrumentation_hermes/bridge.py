"""OGR <-> Hermes bridge: maps Hermes' plugin hooks onto the v0.8 recipe.

The recipe (specification/runtime-api.md) is two evaluates per model call —
step/request before, step/response after, paired by a fresh step_id — and
Hermes' hooks land on it like this:

    pre_api_request       -> step/request evaluate  (canonical {messages})
    post_api_request      -> step/response evaluate (canonical {text,
                             reasoning?, tool_calls, timing})
    transform_llm_output  -> ENFORCE on the answer   (see "the seam split")
    pre_tool_call         -> ENFORCE on tool calls
    BaseEnvironment.execute (wrapped, sandbox_guard.py)
                          -> a FRAGMENT vantage: one exec about to run, sent
                             as its own canonical step/response

The seam split, which shapes everything here: Hermes DISCARDS what
pre/post_api_request return (agent/conversation_loop.py invokes them for
effect only), so the hooks that hold the step's content cannot enforce, and
the hooks that can enforce — transform_llm_output substitutes the answer,
pre_tool_call blocks a dispatch — hold only fragments. So verdicts are
obtained where the content is and PARKED per session for the seams that can
act. Two honest costs, documented in the README: a step/request block cannot
prevent the model call itself (only its effects — the answer is withheld and
the round's tool calls are denied), and a blocked step/response denies ALL
of the round's tool calls rather than only the finding's path.

Payloads are `llm_protocol: "canonical"` throughout: Hermes hands its hooks
message lists and an assistant-message object, never the provider's raw
request/response body, and the canonical shape is exactly the vocabulary for
an integration that holds no provider body. Nothing is fabricated to look
raw — the events say what this vantage actually sees.
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from .wire import OgrClient

logger = logging.getLogger("ogr-guard")

_lock = threading.Lock()

# One client for every hook (config is env-read once, at first use).
_client: OgrClient | None = None

# api-round key -> (step_id, started_at): minted at pre_api_request, consumed
# by post_api_request so ONE model call's two events share ONE step_id — the
# single coordinate v0.8 kept, because interleaved concurrent calls make it
# underivable. Hermes' api_request_id identifies exactly one round-trip (one
# pre/post pair), which is precisely the pairing step_id exists to carry.
_pending_steps: dict[str, tuple[str, str]] = {}

# session_id -> {"verdict": <Verdict dict>, "judged": <the text the runtime
# scored>}: the decide-here / act-there hand-off across the seam split.
# Set by the two evaluate hooks, read by pre_tool_call (without consuming —
# several calls per round), consumed by transform_llm_output, cleared when a
# new round starts so a stale verdict can never land on a later answer.
_parked: dict[str, dict[str, Any]] = {}


def get_client() -> OgrClient:
    global _client
    if _client is None:
        _client = OgrClient()
    return _client


def reset() -> None:
    """Drop the cached client and all cross-hook state. For tests, which
    change the environment between cases; a live Hermes never calls this."""
    global _client
    with _lock:
        _client = None
        _pending_steps.clear()
        _parked.clear()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _round_key(session_id: str, turn_id: str, api_request_id: str) -> str:
    # api_request_id is Hermes' own name for one model round-trip; the
    # fallback only exists for a hook invocation that arrives without one.
    return api_request_id or f"{session_id}|{turn_id}"


# A verdict-shaped local stand-in for "fail-closed with no runtime answer",
# so the parking/enforcement path has one shape to act on. Never sent
# anywhere — event_id is runtime-born and this verdict was never born there.
_FAIL_CLOSED_BLOCK: dict[str, Any] = {
    "event_id": "",
    "provider": "ogr-guard(fail-closed)",
    "decision": "block",
}


# --------------------------------------------------------------------------- #
# canonical payload building (plain JSON out of whatever Hermes hands over)
# --------------------------------------------------------------------------- #
def _plain_tool_call(tc: Any) -> dict[str, Any]:
    """One tool call in the canonical {id, name, arguments} shape. Hermes
    hands SDK objects with a nested .function; a dict passes through as-is
    (it is already wire-shaped, and decomposing it would be fabrication)."""
    if isinstance(tc, dict):
        return tc
    fn = getattr(tc, "function", None)
    return {
        "id": getattr(tc, "id", "") or "",
        "name": (getattr(fn, "name", "") if fn else "") or "",
        "arguments": (getattr(fn, "arguments", "") if fn else "") or "",
    }


def _plain_message(m: Any) -> dict[str, Any]:
    """One conversation message as plain JSON. Dicts pass through untouched —
    forwarding, not decomposing, is the v0.8 rule, and Hermes' dict messages
    are already the shape it sends its provider. SDK message objects get
    their known attributes lifted; anything unserializable degrades to str()
    at the wire (wire.py's json default), never to a dropped message."""
    if isinstance(m, dict):
        return m
    out: dict[str, Any] = {
        "role": getattr(m, "role", "") or "",
        "content": getattr(m, "content", None),
    }
    for attr in ("name", "tool_call_id"):
        value = getattr(m, attr, None)
        if isinstance(value, str) and value:
            out[attr] = value
    tool_calls = getattr(m, "tool_calls", None) or []
    if tool_calls:
        out["tool_calls"] = [_plain_tool_call(tc) for tc in tool_calls]
    return out


def _spans(verdict: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not verdict:
        return []
    return (verdict.get("modifications") or {}).get("spans") or []


def _brief(verdict: dict[str, Any] | None) -> str:
    """One line for logs and for the block message the AGENT reads (never the
    end user — see _refusal_text): decision plus finding categories/scores."""
    if verdict is None:
        return "[OGR:unjudged] runtime unreachable"
    cats = ", ".join(
        f"{f.get('category', '?')}({f.get('score', 0):.2f})"
        for f in (verdict.get("findings") or [])
    ) or "—"
    return f"[OGR:{verdict.get('decision', '?')}] {cats}"


# --------------------------------------------------------------------------- #
# the two step halves
# --------------------------------------------------------------------------- #
def on_pre_api_request(session_id="", task_id="", turn_id="", api_request_id="",
                       user_message=None, conversation_history=None,
                       request_messages=None, **_):
    """Recipe step 2 — PRE-MODEL: judge exactly what is about to be sent.

    The payload is the full conversation Hermes is sending, canonical
    {messages}: tool RESULTS being fed back need no evaluate of their own —
    this is the event that carries and judges them (guard-event.md), which
    is why the v0.6 post_tool_call/transform_tool_result hooks are gone.

    Hermes discards this hook's return value, so a block here cannot skip
    the model call (recipe's "do not call the model" has no seam). It is
    parked instead and enforced where Hermes allows: the answer is withheld,
    the round's tool calls are denied. The model-provider round-trip still
    happens — the honest statement is that this vantage cannot prevent it.
    """
    client = get_client()
    step_id = uuid.uuid4().hex          # one id, both halves of this call
    started_at = _now()
    key = _round_key(session_id, turn_id, api_request_id)
    with _lock:
        # A new round: the previous round's verdict was already enforced at
        # its own seams (or the turn was interrupted and it never will be —
        # either way it must not land on THIS round's answer).
        _parked.pop(session_id, None)
        _pending_steps[key] = (step_id, started_at)
    messages = [_plain_message(m) for m in (request_messages or conversation_history or [])]
    verdict = client.evaluate("step/request", step_id, "canonical",
                              {"messages": messages})
    if client.blocked(verdict):
        logger.warning("ogr-guard: step/request blocked %s", _brief(verdict))
        with _lock:
            _parked[session_id] = {"verdict": verdict or _FAIL_CLOSED_BLOCK,
                                   "judged": ""}
    return None


def on_post_api_request(session_id="", task_id="", turn_id="", api_request_id="",
                        assistant_message=None, **_):
    """Recipe step 4 — POST-MODEL, the enforcement moment that matters most:
    the model's tool calls, held before execution, are the only copy of an
    action anyone can still refuse.

    Canonical {text, reasoning?, tool_calls, timing}: Hermes surfaces the
    assistant message, never the provider's raw response body. `timing` is
    the two wall-clock facts this vantage observes (no byte path, so no
    first_token_at); `usage` is OMITTED, not zeroed — the hook holds no
    token counts and absence is the honest value (guard-event.md).

    This hook's return value is discarded too, so the verdict is parked:
    a block (or an unanswered evaluate under fail-closed) withholds the
    answer via transform_llm_output and denies the round's tool calls via
    pre_tool_call; an allow with spans on payload.text is a redaction
    transform_llm_output must apply before the answer proceeds.
    """
    client = get_client()
    key = _round_key(session_id, turn_id, api_request_id)
    with _lock:
        step_id, started_at = _pending_steps.pop(key, ("", ""))
    if not step_id:
        # A response whose request half this process never saw (plugin loaded
        # mid-conversation). Judge it anyway under a fresh id — an unpaired
        # step beats an unjudged one — but never reuse another call's id.
        step_id = uuid.uuid4().hex
    text = getattr(assistant_message, "content", "") or ""
    reasoning = getattr(assistant_message, "reasoning_content", "") or ""
    tool_calls = [_plain_tool_call(tc)
                  for tc in (getattr(assistant_message, "tool_calls", None) or [])]
    payload: dict[str, Any] = {"text": text, "tool_calls": tool_calls}
    if reasoning:
        payload["reasoning"] = reasoning
    if started_at:
        payload["timing"] = {"started_at": started_at, "completed_at": _now()}
    verdict = client.evaluate("step/response", step_id, "canonical", payload)
    if client.blocked(verdict):
        logger.warning("ogr-guard: step/response blocked %s", _brief(verdict))
        with _lock:
            # setdefault: a request-half block already parked for this round
            # stays parked — the stricter verdict wins, never the later one.
            _parked.setdefault(session_id, {"verdict": verdict or _FAIL_CLOSED_BLOCK,
                                            "judged": text})
    elif _spans(verdict):
        with _lock:
            _parked.setdefault(session_id, {"verdict": verdict, "judged": text})
    return None


# --------------------------------------------------------------------------- #
# enforcement seams
# --------------------------------------------------------------------------- #
def on_pre_tool_call(tool_name="", args=None, session_id="", tool_call_id="", **_):
    """Enforce the round's step/response verdict on a tool about to dispatch:
    "block on response -> do not execute tool calls". Reads the parked
    verdict without consuming it — a round dispatches several calls, and the
    verdict covers them all.

    No evaluate happens here: the full response, all tool calls included,
    was already judged as ONE step/response — a second, fragmentary evaluate
    of the same call would be exactly the step-shattering v0.8 removed the
    vocabulary for.

    Deliberately coarse: a blocked response denies ALL of the round's calls,
    though findings[].path could name just one. Feeding a per-call error
    back while executing siblings needs call-index bookkeeping this hook's
    arguments don't carry; conservative beats clever at a deny seam.
    """
    with _lock:
        parked = _parked.get(session_id)
    if parked is None:
        return None
    verdict = parked["verdict"]
    if verdict.get("decision") == "block":
        return {"action": "block", "message": _brief(verdict)}
    # allow + spans naming a tool call's arguments: the redaction cannot be
    # applied here — this hook can block or pass, never rewrite — so the
    # softer decision degrades to the denial it was a gentler form of. The
    # message says what to do, because the reader is the agent: strip the
    # value and retry is the action a span on an action was reaching for.
    if any(str(s.get("path", "")).startswith("payload.tool_calls") for s in _spans(verdict)):
        return {"action": "block",
                "message": (f"{_brief(verdict)} — arguments contain content that must "
                            f"be redacted; remove the flagged value and retry")}
    return None


def on_transform_llm_output(response_text="", session_id="", **_):
    """Enforce on the answer — the one hook Hermes lets a plugin change what
    the user sees (the finalizer substitutes the first non-empty string a
    plugin returns). Consumes the parked verdict; nothing parked means
    nothing to enforce, so this hook adds no latency and cannot fail open
    by accident.

    block -> the refusal text. allow + spans on payload.text -> the spans
    are applied in place before the content proceeds, as the Verdict spec
    requires; a span set that cannot be applied withholds the answer, never
    ships it — "redacted" must not be a label on the verbatim value.
    """
    with _lock:
        parked = _parked.pop(session_id, None)
    if parked is None:
        return None
    verdict = parked["verdict"]
    if verdict.get("decision") == "block":
        logger.info("ogr-guard: answer withheld %s", _brief(verdict))
        return _refusal_text()
    text_spans = [s for s in _spans(verdict) if s.get("path") == "payload.text"]
    if not text_spans:
        return None
    redacted = _apply_spans(response_text, parked["judged"], text_spans)
    if redacted is not None:
        logger.info("ogr-guard: answer redacted %s", _brief(verdict))
        return redacted
    logger.warning("ogr-guard: redaction unfulfillable — answer withheld %s",
                   _brief(verdict))
    return _refusal_text()


def _apply_spans(text: str, judged: str, spans: list[dict[str, Any]]) -> str | None:
    """The redacted form of `text`, or None when the spans cannot be applied
    (the caller then withholds — fail closed on a redaction, always).

    Offsets index `judged`, the exact string the runtime scored ("offsets
    refer to the payload as transported", verdict.md) — and Hermes' finalizer
    can hand this hook a DIFFERENT string (it may append to an answer). Two
    paths, in order:

    1. text == judged -> slice by offsets, right-to-left so applying one span
       never shifts the next one's start.
    2. otherwise -> recover each value from judged[start:end] and replace it
       by VALUE wherever it appears, longest first so a value that is a
       substring of another cannot corrupt it. The moment the string is not
       byte-identical to what the detector saw, offsets are meaningless.
    """
    if text == judged:
        out = text
        for s in sorted(spans, key=lambda s: int(s.get("start", 0)), reverse=True):
            start, end = int(s.get("start", -1)), int(s.get("end", -1))
            if not (0 <= start < end <= len(out)):
                return None
            out = out[:start] + _replacement_for(s) + out[end:]
        return out

    pairs: list[tuple[str, str]] = []
    for s in spans:
        start, end = int(s.get("start", -1)), int(s.get("end", -1))
        if not (0 <= start < end <= len(judged)):
            return None
        value = judged[start:end]
        if value not in text:
            return None
        pairs.append((value, _replacement_for(s)))
    out = text
    for value, replacement in sorted(pairs, key=lambda p: len(p[0]), reverse=True):
        out = out.replace(value, replacement)
    return out


def _replacement_for(span: dict[str, Any]) -> str:
    """What goes in place of a span: the verdict's own `replacement` — a
    `${OGR_PHONE_1}`-style placeholder, stable per value, so two mentions of
    one number still read as one number. `OGR_REDACT_MASK` swaps in a flat
    string (e.g. `[已隐去]`) for customer-facing output, at the cost of that
    distinction — a fair trade at the end of the line, where nobody restores
    anything."""
    mask = os.environ.get("OGR_REDACT_MASK", "").strip()
    if mask:
        return mask
    replacement = span.get("replacement")
    return replacement if isinstance(replacement, str) and replacement else "[redacted]"


def _refusal_text() -> str:
    """What the user gets instead of a blocked answer.

    Deliberately says NOTHING about why: everything the verdict carries is
    written for someone else — finding categories are taxonomy ids, and the
    policy behind them is a map of what to route around. Both belong in the
    runtime's own record and this plugin's log, not in front of an end user.
    Set OGR_REFUSAL_TEXT to the sentence this deployment should say; the
    tenant owns that copy (voice, language, support channel) and no default
    is right for every deployment."""
    return os.environ.get("OGR_REFUSAL_TEXT", "").strip() \
        or "Sorry — I can't help with that here."


# --------------------------------------------------------------------------- #
# the exec fragment (called by sandbox_guard's BaseEnvironment.execute wrap)
# --------------------------------------------------------------------------- #
def guard_exec(command: str, cwd: str = "/workspace") -> tuple[bool, str]:
    """Judge one REAL exec just before it runs. Returns (allowed, brief).

    A fragment vantage, stated as such: this wrapper holds one command about
    to execute — not the model call that produced it, and (v0.8 having no
    cross-event correlation to declare) no link to the step it belongs to.
    So the event is a canonical step/response carrying exactly the one tool
    call this vantage actually holds, under its own fresh step_id: to the
    runtime it is a synthetic single-call step. What it buys over
    pre_tool_call is the REAL argv — a script that shells out to something
    its tool arguments never mentioned is seen here and only here.
    """
    client = get_client()
    step_id = uuid.uuid4().hex
    payload = {"tool_calls": [{
        "id": f"exec-{step_id[:8]}",
        "name": "bash",
        "arguments": {"command": command, "cwd": cwd},
    }]}
    verdict = client.evaluate("step/response", step_id, "canonical", payload)
    allowed = not client.blocked(verdict)
    if not allowed:
        logger.warning("ogr-guard: exec blocked %s :: %s", _brief(verdict), command)
    return allowed, _brief(verdict)
