"""OGR <-> Hermes bridge: turns Hermes plugin-hook callbacks into OGR
GuardEvents, runs them through one Runtime, and enforces the verdict.

This is the real-integration counterpart to the mocked ``adapters/hermes.py``
demo. It reuses the same ``ogr`` reference runtime + ``policy.json``.

Altitude mapping (see README):
    pre_api_request / post_api_request  -> observation_point="conversation"  (detect + taint)
    pre_tool_call                       -> observation_point="invocation" (DETECT + BLOCK)
    post_tool_call                      -> provenance/taint tracking
    BaseEnvironment.execute (wrapped)   -> observation_point="execution"    (DETECT + BLOCK)

Correlation: pre_tool_call mints a guard_id and stashes a guard-context on a
thread-local; the execution wrapper reads it so both altitudes decide on ONE
logical action. Provenance tainted at the conversation altitude/post_tool_call
flows into the invocation + execution events, so the SAME command gets a
different verdict depending on where it came from.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openguardrails import Category, GuardEvent, Provenance, Runtime, Verdict
from openguardrails.detectors.config_rules import ConfigRulesDetector
from openguardrails.detectors.llm_judge import LLMJudgeDetector

from .platform import agent_id, event_to_wire, evaluate as _evaluate_via_runtime, get_reporter, subject_for

_seq = itertools.count(1)
_lock = threading.Lock()
# Per-process tag folded into every generated id (same fix as
# ogr_mitmproxy/ogr_client.py's new_id()): a bare counter restarts at 1 every
# time Hermes starts a fresh process — which is EVERY `hermes -z` / `hermes
# chat --cli` invocation — so evt-/ga- ids collided across runs and the
# runtime's ingest queue (deterministic BullMQ jobId = event_id) silently
# dropped the reused ids as duplicates of the prior run's already-completed
# jobs. The tag keeps ids from different processes disjoint.
_proc_tag = secrets.token_hex(4)

# guard-context handed from pre_tool_call -> execution wrapper, per OS thread
# (each Hermes tool call dispatches + execs on one thread).
_tls = threading.local()

# per-session taint picked up from untrusted inputs (web fetches, mcp, etc.)
_session_taint: dict[str, list[Provenance]] = {}

# --------------------------------------------------------------------------- #
# subagent lineage (OGR v0.4 actor lineage: subject.parent_agent_id /
# delegation_chain, spec: guard-event.md#subject)
# --------------------------------------------------------------------------- #
# Every Hermes hook call (pre/post_tool_call, pre/post_api_request) carries a
# `task_id` distinct per delegate_task child (Hermes mints a fresh one per
# spawned subagent — see delegate_tool.py). The first task_id this PROCESS
# observes is treated as the top-level conversation; any later, different
# task_id is a subagent of it, reported as its own agent identity with
# lineage back to the top level.
#
# Known limitations (v1, matches what's actually been tested — see
# openguardrails-runtime's hermes-subagent-investigation memory):
#   - Assumes ONE top-level conversation per process (true for `hermes chat
#     --cli` / `hermes -z`; NOT true for the multi-session gateway/server
#     modes, which would need a different correlation strategy).
#   - Nested delegation (a subagent itself delegating, role="orchestrator")
#     attributes the grandchild directly to the top level, not to its
#     immediate orchestrator parent — one lineage hop is flattened.
_top_level_task_id: str | None = None
_reported_children: set[str] = set()


def _child_agent_id(task_id: str) -> str:
    return f"{agent_id()}.sub-{task_id[:12]}"


def _lineage_for(task_id: str) -> dict[str, Any]:
    """subject overrides for `task_id`: {} for the top level, else this
    task's own agent_id + parent_agent_id + delegation_chain. Reports an
    `agent_spawn` event the first time a given child task_id is observed."""
    if not task_id:
        return {}
    global _top_level_task_id
    with _lock:
        if _top_level_task_id is None:
            _top_level_task_id = task_id
        if task_id == _top_level_task_id:
            return {}
        is_new = task_id not in _reported_children
        _reported_children.add(task_id)
    child_id = _child_agent_id(task_id)
    if is_new:
        _report_spawn(child_id)
    return {
        "agent_id": child_id,
        "parent_agent_id": agent_id(),
        "delegation_chain": [agent_id(), child_id],
    }


# --------------------------------------------------------------------------- #
# turn numbering (OGR runtime-ext `turn` field, guardEventExtSchema)
# --------------------------------------------------------------------------- #
# The console's definition of a Turn is one agent<->model round-trip. Hermes'
# own api_request_id already identifies exactly that (one pre/post_api_request
# pair = one model call), just not as a small sequential int — so the first
# api_request_id seen for a turn_id is turn 0, the next is turn 1, etc., in
# first-observation order (pre_api_request always fires before the tool calls
# its response triggers, so ordering is safe without a timestamp sort).
#
# Actions (tool_call/tool_result/exec) carry the api_request_id of the model
# round that ASKED for them, but per the console's story-telling model they
# belong with the round that CONSUMES their result, i.e. one turn later — the
# call sites below pass offset=1 for those three kinds, offset=0 for the
# transcript kinds (user_input/model_output) themselves.
_turn_seq: dict[str, dict[str, int]] = {}


def _turn_number(turn_id: str, api_request_id: str, offset: int = 0) -> int | None:
    if not turn_id or not api_request_id:
        return None
    with _lock:
        seqs = _turn_seq.setdefault(turn_id, {})
        if api_request_id not in seqs:
            seqs[api_request_id] = len(seqs)
        return seqs[api_request_id] + offset


def _wire(ev: GuardEvent, turn_id: str = "", turn: int | None = None) -> dict[str, Any]:
    """Serialize a GuardEvent for the wire, stamping the runtime-only `run_id`/
    `turn` extension fields (guardEventExtSchema) from Hermes' own turn_id/
    api_request_id when known — explicit, rather than relying on the
    runtime's timestamp-order fallback ("a new run starts at each user_input
    in a session"), which is fragile once events from concurrent subagents
    interleave in one batch.

    run_id is opaque everywhere it's consumed (never parsed/split), but the
    console DOES route on it (a Run detail page's URL segment) — Hermes'
    turn_id is `<session_id>:<task_id>:<uuid8>`, and a raw colon there was
    observed surviving a Link href unescaped, then getting double
    percent-encoded somewhere in the batched tRPC client fetch (literal
    "%3A" landing in the query value instead of a decoded ":"), so the run
    404'd from its own "click here" link. Dashes are already the console's
    id-display delimiter (see shortId()) and need no URL escaping at all.

    Also collapses a repeated segment: task_id defaults to session_id for a
    top-level turn (no delegation), so the raw turn_id there is literally
    `<session_id>:<session_id>:<uuid8>` — confusing to read as a run id.
    """
    wire = event_to_wire(ev)
    # The mechanism axis, stamped centrally because it is the same for every
    # altitude this bridge reports: all three hooks (and the execute wrapper)
    # are Python running INSIDE the agent process, so an agent that stops
    # calling them stops being seen. The execution altitude here is therefore
    # NOT the adversary-proof one — pair it with the eBPF sensor for that.
    wire.setdefault("sensor_id", "openguardrails-hermes")
    wire.setdefault("sensor_type", "in_process")
    if turn_id:
        wire["run_id"] = _run_id(turn_id)
    if turn is not None:
        wire["turn"] = turn
    return wire


def _report(ev: GuardEvent, turn_id: str = "", turn: int | None = None) -> None:
    """Queue one GuardEvent for the platform (fire-and-forget)."""
    get_reporter().report(_wire(ev, turn_id, turn))




# The wire caps run_id at 64 characters (guardEventExtSchema). Hermes' turn_id is
# `<session>:<task>:<uuid8>`, and whenever task_id is a UUID rather than the session
# id that comes to 68 — so ingest 400'd the event with `run_id: Too big`, per event,
# and the only trace was a warning in Hermes' errors.log. `user_input` vanished from
# the console that way while `model_output` survived, because the latter also rides
# the synchronous /evaluate call, which is sent WITHOUT the run_id stamp.
_RUN_ID_MAX = 64


def _run_id(turn_id: str) -> str:
    """A stable, wire-legal run id from Hermes' turn_id.

    Collapses the repeated segment first (task_id defaults to session_id for a
    top-level turn, so the raw id reads `<session>:<session>:<uuid8>`) and swaps
    colons for dashes — the console routes on this value and a raw colon was once
    double-encoded into a 404. When the result still does not fit, the tail is
    replaced by a digest of the WHOLE turn_id: truncation alone would let two
    different runs of one session collapse into the same id, which is worse than a
    less readable one.
    """
    segments = turn_id.split(":")
    deduped = [s for i, s in enumerate(segments) if i == 0 or s != segments[i - 1]]
    joined = "-".join(deduped)
    if len(joined) <= _RUN_ID_MAX:
        return joined
    digest = hashlib.sha1(turn_id.encode("utf-8")).hexdigest()[:10]
    return f"{joined[: _RUN_ID_MAX - len(digest) - 1]}-{digest}"


def _report_spawn(child_id: str) -> None:
    try:
        ev = GuardEvent(
            kind="agent_spawn", observation_point="invocation",
            **subject_for(),
            payload={"child_agent_id": child_id, "child_agent_type": "hermes.subagent"},
            timestamp=_now(),
        )
        _report(ev)
    except Exception as exc:  # noqa: BLE001
        _audit("invocation", f"agent_spawn report failed: {exc}")

# tools whose *results* introduce untrusted content into the agent's context
_UNTRUSTED_RESULT_TOOLS = {"web_search", "web_extract", "web_fetch", "fetch_url",
                           "browser", "mcp", "read_url"}
# tools that actually run code/commands -> candidates for execution-altitude exec
_EXEC_TOOLS = {"terminal", "shell", "shell.exec", "execute_code", "run_code", "bash"}
# env-var name fragments that suggest a credential...
_SECRET_MARKERS = ("SECRET", "TOKEN", "KEY", "PASSWORD", "AWS_", "PRIVATE", "CREDENTIAL")
# ...but skip control/config flags whose *names* merely contain those fragments
# (e.g. HERMES_REDACT_SECRETS is a boolean, not a credential).
_SECRET_NAME_EXCLUDE = ("REDACT", "ENABLE", "DISABLE", "VERBOSE", "DEBUG", "MODE",
                        "ALLOW", "FORMAT", "STYLE", "KEYRING", "KEYMAP")
_NON_SECRET_VALUES = {"", "0", "1", "true", "false", "yes", "no", "on", "off", "none"}


def _is_secret_env(name: str, value: str) -> bool:
    """A real leaked credential is a secret-named var holding a high-entropy
    value — not a boolean control flag. The bridge reads values locally so it
    can tell the difference; only the *key name* ever leaves in a GuardEvent."""
    up = name.upper()
    if not any(m in up for m in _SECRET_MARKERS):
        return False
    if any(x in up for x in _SECRET_NAME_EXCLUDE):
        return False
    v = (value or "").strip()
    if v.lower() in _NON_SECRET_VALUES or v.isdigit():
        return False
    return len(v) >= 12  # credentials are long; flags/short tokens are not

# Verdicts that let content through untouched. `redact` is NOT one of them: it
# carries `modifications` the enforcement point is supposed to APPLY, and treating
# it as allowing ships the very value it names (it did, until 2026-07-26). Each
# caller handles it explicitly — the answer and tool results are rewritten, a tool
# CALL is blocked, because Hermes' pre_tool_call directive can only block or
# escalate, never rewrite the arguments (`resolve_pre_tool_block`).
# `modify` stays here: our runtime never emits it (policy.ts) and no adapter has a
# rewrite to apply, so it would be a decision with nothing behind it.
_ALLOW_DECISIONS = {"allow", "modify"}


def _now() -> str:
    # Millisecond precision, not just seconds: the console picks a run's
    # `instruction`/`final_response` as the first/last event of a kind ORDER
    # BY ts — same-second events (a fast tool-call loop, or a scripted burst)
    # tie under whole-second timestamps and the DB breaks the tie arbitrarily.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _id(prefix: str) -> str:
    with _lock:
        return f"{prefix}-{_proc_tag}-{next(_seq):04d}"


# --------------------------------------------------------------------------- #
# Runtime singleton (one Runtime + one policy for ALL altitudes)
# --------------------------------------------------------------------------- #
_runtime: Runtime | None = None
_policy: dict | None = None


def _policy_path() -> Path:
    env = os.environ.get("OGR_POLICY")
    if env:
        return Path(env)
    # the default Hermes-tuned policy ships inside the package, next to this module.
    return Path(__file__).resolve().parent / "policy.json"


def get_runtime() -> Runtime:
    global _runtime, _policy
    if _runtime is None:
        _policy = json.loads(_policy_path().read_text())
        _runtime = Runtime(
            detectors=[
                ConfigRulesDetector(_policy["config_rules"]),
                LLMJudgeDetector(),  # offline heuristic backend by default
            ],
            policy=_policy,
        )
    return _runtime


def get_runtime_policy() -> dict:
    """The active OGR policy dict (also configures the sandbox backend)."""
    get_runtime()
    return _policy or {}


# Short and deliberately not the runtime's own OGR_MODEL_TIMEOUT_MS budget
# (which can be tens of seconds on a cold model-gateway request): this call
# sits in the hot path of a real tool invocation, so a stalled runtime must
# fail open fast rather than freeze the agent. Override via env if needed.
_EVALUATE_TIMEOUT = float(os.environ.get("OGR_EVALUATE_TIMEOUT", "4.0"))


def _verdict_from_wire(ev: GuardEvent, data: dict[str, Any]) -> Verdict:
    """Runtime /evaluate JSON response -> the same Verdict shape the local
    reference Runtime returns, so downstream code (_verdict_brief, decision
    checks) doesn't care which altitude decided."""
    categories = [
        Category(id=c.get("id", ""), domain=c.get("domain", ""), score=float(c.get("score", 0)))
        for c in (data.get("categories") or [])
    ]
    return Verdict(
        event_id=data.get("event_id", ev.event_id),
        guard_id=data.get("guard_id", ev.guard_id),
        provider=data.get("provider", "runtime"),
        decision=data.get("decision", "allow"),
        categories=categories,
        reasons=list(data.get("reasons") or []),
        evidence=list(data.get("evidence") or []),
        confidence=data.get("confidence"),
        latency_ms=data.get("latency_ms"),
        # Carrying this is what makes `redact` enforceable rather than a decision
        # the PEP can only round to allow or block.
        modifications=data.get("modifications"),
    )


def _evaluate(ev: GuardEvent, turn_id: str = "", turn: int | None = None) -> Verdict:
    """The one decision path both enforcement altitudes call.

    A configured runtime (OGR_RUNTIME_URL + OGR_API_KEY) is authoritative and
    does NOT fall back to the offline PoC detectors on a failed/slow call —
    that would silently swap in a much coarser rule set (see config_rules.py:
    it blocks on secret-shaped env vars existing at all, not on the command
    actually touching them) and make the same action's decision depend on
    network luck. A runtime hiccup fails OPEN instead: a real PDP that's
    unreachable degrades to "unenforced for this action", never to "PoC's
    stricter demo rules". The PoC only runs when NO runtime is configured at
    all — that's its actual job, an offline/demo fallback.
    """
    if get_reporter().enabled:
        # Same wire shape as the report — including run_id/turn. /evaluate enqueues
        # the event for analytics itself, so an unstamped call makes the runtime
        # derive a fresh run and the turn's two halves land in different runs.
        data = _evaluate_via_runtime(_wire(ev, turn_id, turn), timeout=_EVALUATE_TIMEOUT)
        if data is not None:
            # v0.6: /evaluate RECORDED the event, and with runtime-born ids
            # there is no eval-once marker to absorb a duplicate — so the
            # decision path must never be followed by a report of the same
            # event. Recording happened; only the verdict comes back.
            return _verdict_from_wire(ev, data)
        # Unreachable runtime: the fail-open verdict decides locally, and the
        # fire-and-forget report below is the event's ONLY chance to exist on
        # the platform (delivered when the reporter's queue reconnects).
        _audit("evaluate", "runtime /evaluate unreachable — failing open")
        _report(ev, turn_id, turn)
        return Verdict.allow(ev, "ogr.runtime", "runtime /evaluate unreachable — failed open")
    return get_runtime().evaluate(ev)


# --------------------------------------------------------------------------- #
# guard-context propagation (spec: provenance-and-context.md)
# --------------------------------------------------------------------------- #
def _set_guardcontext(
    guard_id: str, session_id: str, provenance: list[Provenance],
    task_id: str = "", turn_id: str = "", api_request_id: str = "",
) -> None:
    _tls.guard_id = guard_id
    _tls.session_id = session_id
    _tls.provenance = provenance
    _tls.task_id = task_id
    _tls.turn_id = turn_id
    _tls.api_request_id = api_request_id


def _take_guardcontext() -> tuple[str, str, list[Provenance], str, str, str]:
    return (
        getattr(_tls, "guard_id", "") or _id("ga"),
        getattr(_tls, "session_id", "") or "unknown",
        getattr(_tls, "provenance", []) or [],
        getattr(_tls, "task_id", "") or "",
        getattr(_tls, "turn_id", "") or "",
        getattr(_tls, "api_request_id", "") or "",
    )


# --------------------------------------------------------------------------- #
# provenance / taint
# --------------------------------------------------------------------------- #
def _user_provenance() -> list[Provenance]:
    return [Provenance("user", "trusted")]


def _provenance_for(session_id: str) -> list[Provenance]:
    """Provenance to attach to an action: the user's own input, PLUS any
    untrusted content the session has ingested (which is what makes injection
    dangerous).
    """
    prov = _user_provenance()
    prov.extend(_session_taint.get(session_id, []))
    return prov


def _taint_session(session_id: str, source: str) -> None:
    # build the Provenance (which mints an id under _lock) BEFORE taking _lock
    # here — _lock is non-reentrant, so nesting would deadlock.
    prov = Provenance(
        source if source in {"web", "mcp", "tool_result", "file"} else "tool_result",
        "untrusted", ref=_id("evt"),
        taint_tags=["external_content", "executable_intent"],
    )
    with _lock:
        _session_taint.setdefault(session_id, []).append(prov)


# --------------------------------------------------------------------------- #
# argv extraction (Hermes tool args -> a command line)
# --------------------------------------------------------------------------- #
def _argv_from_args(tool_name: str, args: dict) -> list[str]:
    if not isinstance(args, dict):
        return []
    cmd = args.get("command") or args.get("cmd") or args.get("script")
    if isinstance(cmd, str) and cmd:
        return ["bash", "-c", cmd]
    code = args.get("code")
    if isinstance(code, str) and code:
        lang = args.get("language", "python")
        return [lang, "-c", code]
    return []


def _verdict_brief(v) -> str:
    cats = ", ".join(f"{c.id}({c.score:.2f})" for c in v.categories) or "—"
    reasons = "; ".join(v.reasons) if v.reasons else ""
    return f"[OGR:{v.decision}] {cats}" + (f" — {reasons}" if reasons else "")


# audit trail — proves, from inside the real Hermes process, which altitude fired
_AUDIT = Path(os.environ.get("OGR_AUDIT_LOG",
              str(Path.home() / ".hermes" / "logs" / "ogr-guard.log")))


def _audit(altitude: str, line: str) -> None:
    try:
        _AUDIT.parent.mkdir(parents=True, exist_ok=True)
        with _AUDIT.open("a") as fh:
            fh.write(f"{_now()} [{altitude}] {line}\n")
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# hook handlers
# --------------------------------------------------------------------------- #
# turn_ids (Hermes' own per-user-turn identifier, `<session>:<task>:<uuid8>`)
# whose `user_input` has already been reported — pre_api_request fires once
# per model round-trip within a turn (e.g. every step of a tool-call loop),
# but the turn has exactly ONE triggering user message, so we report it once.
_reported_turns: set[str] = set()


# task_ids whose system prompt has already ridden on a user_input payload —
# it's static for the whole conversation, so send it once, not on every turn.
_reported_system_prompts: set[str] = set()


# session_id -> the blocking verdict for that session's latest assistant message,
# parked by post_api_request for transform_llm_output to act on.
#
# WHY a hand-off instead of one hook doing both: Hermes splits them. Its
# `post_api_request` is where the assistant message exists (so where a content
# verdict can be had) but its return value is DISCARDED by the agent loop
# (agent/conversation_loop.py — `_invoke_hook(...)` with no assignment), and
# `pre_api_request` is the same. `transform_llm_output` is the one hook that can
# change what the user sees — the finalizer swaps in whatever string a plugin
# returns — but it is handed only the text: no event, no verdict, nothing to ask.
# So the verdict is computed where the content is and consumed where enforcement is
# possible. Cleared when consumed and when a new user turn starts, so a stale block
# can never land on a later answer.
_pending_content_block: dict[str, Any] = {}

# tool_call_key(session, tool_call_id) -> (verdict, judged text) for a tool result
# that must be rewritten or withheld before it re-enters the model's context.
# Keyed per CALL, not per session: tool calls run concurrently.
_pending_result_action: dict[str, Any] = {}


def _visible_text(content: Any) -> str:
    """The user-visible text of a message, whatever shape Hermes hands over.

    `user_message` is NOT always a string: a multimodal or decorated turn arrives as
    a list of content parts, and Hermes flattens it with
    `agent.message_content.flatten_message_text` wherever it needs the text. This
    bridge required a `str` and reported nothing otherwise — so those turns were
    dropped from the transcript entirely, which is invisible until someone notices a
    run whose user_input is missing.

    Mirrored rather than imported: the plugin must not depend on Hermes' internals
    (a moved helper would break the hook), and the shape is small.
    """
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                # {"type":"text","text":…} and the Responses {"input_text":…} shape.
                value = part.get("text") or part.get("input_text") or ""
                if isinstance(value, str):
                    parts.append(value)
            else:
                value = getattr(part, "text", "")
                if isinstance(value, str):
                    parts.append(value)
        return "\n".join(p for p in parts if p).strip()
    value = getattr(content, "text", "")
    return value.strip() if isinstance(value, str) else ""


def _extract_system_prompt(messages) -> str:
    """First system-role message's text in a request_messages/
    conversation_history list — defensive against both plain dicts and SDK
    message objects (same shape Hermes hands pre_api_request)."""
    if not messages:
        return ""
    for m in messages:
        role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
        if role != "system":
            continue
        content = m.get("content") if isinstance(m, dict) else getattr(m, "content", None)
        if isinstance(content, str) and content:
            return content
    return ""


def on_pre_api_request(session_id="", task_id="", turn_id="", api_request_id="",
                        user_message=None, conversation_history=None,
                        request_messages=None, **_):
    """conversation altitude: reports the OGR v0.4 `user_input` transcript kind —
    the runtime derives Run boundaries server-side from it ("a new run starts
    at each user_input in a session"); without it a hermes session was only
    ever visible as isolated tool_call/exec actions, never a Run. Observe-only
    (Hermes can't block here). Also carries the system prompt, once per
    task_id (see _reported_system_prompts) — it's static for the whole
    conversation, so every later user_input omits it rather than resend an
    unchanged multi-KB blob on every turn."""
    text = _visible_text(user_message)
    if turn_id in _reported_turns:
        return None
    if not text:
        # Say so. A user turn that never reaches the console is invisible from both
        # ends — the transcript looks like the agent answered nobody — and the two
        # ways it happened were both silent.
        _audit("conversation", f"user_input SKIPPED (no text) turn={turn_id}")
        return None
    _reported_turns.add(turn_id)
    # A new user turn: last turn's block (if it was never consumed — an interrupted
    # turn skips transform_llm_output entirely) must not apply to this one.
    _pending_content_block.pop(session_id, None)
    turn = _turn_number(turn_id, api_request_id)
    payload: dict[str, Any] = {"text": text}
    if task_id and task_id not in _reported_system_prompts:
        system_text = (
            _extract_system_prompt(conversation_history)
            or _extract_system_prompt(request_messages)
        )
        if system_text:
            payload["system"] = system_text
            _reported_system_prompts.add(task_id)
    try:
        _report(GuardEvent(
            kind="user_input", observation_point="conversation",
            **subject_for(**_lineage_for(task_id)),
            payload=payload,
            timestamp=_now(),
            session_id=session_id,
        ), turn_id, turn)
    except Exception as exc:  # noqa: BLE001
        _audit("conversation", f"user_input report failed: {exc}")
    return None


def on_post_api_request(session_id="", task_id="", turn_id="", api_request_id="",
                         assistant_message=None, **_):
    """conversation altitude: reports the OGR v0.4 `model_output` transcript kind
    (the completion's text + any planned tool calls, plus the model's
    reasoning_content when the underlying provider returned one — Hermes
    surfaces it on assistant_message the same way nemo_relay's observability
    plugin does) — completes the transcript pre_api_request starts.

    DECIDES but cannot act: this hook's return value is discarded by the agent
    loop, so a blocking verdict is parked in `_pending_content_block` and applied
    by `on_transform_llm_output`. Until 2026-07-26 this hook was observe-only
    (fire-and-forget report), which is why a content guardrail — moderation,
    off-topic — would show "Blocked" in the console while the answer reached the
    user anyway: the runtime had judged it, nobody enforced it."""
    text = getattr(assistant_message, "content", "") or ""
    reasoning = getattr(assistant_message, "reasoning_content", "") or ""
    raw_tool_calls = getattr(assistant_message, "tool_calls", None) or []
    tool_calls = []
    for tc in raw_tool_calls:
        try:
            fn = getattr(tc, "function", None)
            tool_calls.append({
                "name": getattr(fn, "name", "") if fn else "",
                "arguments": getattr(fn, "arguments", "") if fn else "",
            })
        except Exception:  # noqa: BLE001
            continue
    if not text and not tool_calls and not reasoning:
        return None
    turn = _turn_number(turn_id, api_request_id)
    payload: dict[str, Any] = {"text": text, "tool_calls": tool_calls}
    if reasoning:
        payload["reasoning"] = reasoning
    try:
        ev = GuardEvent(
            kind="model_output", observation_point="conversation",
            **subject_for(**_lineage_for(task_id)),
            payload=payload,
            timestamp=_now(),
            session_id=session_id,
        )
        # Same order as on_pre_tool_call: decide first, then report. Both carry the
        # SAME event_id, and the runtime evaluates an event_id exactly once (its
        # eval-once marker), so this is one judgement reaching the console once —
        # not a second model call, and not a duplicate row.
        verdict = _evaluate(ev, turn_id, turn)
        _audit("conversation", f"model_output {_verdict_brief(verdict)}")
        if verdict.decision not in _ALLOW_DECISIONS:
            # The judged text rides along: redact spans index into THIS string, and
            # the finalizer may hand transform_llm_output a different one.
            _pending_content_block[session_id] = (verdict, text)
    except Exception as exc:  # noqa: BLE001
        _audit("conversation", f"model_output report failed: {exc}")
    return None


def on_transform_llm_output(response_text="", session_id="", **_):
    """conversation altitude: ENFORCE a blocking content verdict on what the user
    sees — the only hook Hermes lets a plugin change the answer from.

    Returns the refusal text to substitute, or None to leave the answer alone.
    The verdict was already obtained by post_api_request for this same assistant
    message (see `_pending_content_block`); nothing is evaluated here, so this hook
    adds no latency and cannot fail open by accident — no verdict parked means
    nothing to enforce.

    A runtime that could not be reached fails OPEN upstream in `_evaluate`, which is
    deliberate and unchanged: an unreachable PDP degrades to unenforced, never to
    the offline PoC's coarser rules.

    `redact` is carried out here rather than refused: the answer goes out with the
    detected spans replaced by their placeholders. A redact the spans cannot be
    applied to becomes a refusal — never a pass-through."""
    parked = _pending_content_block.pop(session_id, None)
    if parked is None:
        return None
    verdict, judged = parked
    if verdict.decision == "redact":
        redacted = _apply_redactions(response_text, judged, verdict)
        if redacted is not None:
            _audit("conversation", f"model_output REDACTED {_verdict_brief(verdict)}")
            return redacted
        _audit("conversation",
               f"model_output redact UNFULFILLABLE — withheld {_verdict_brief(verdict)}")
    else:
        _audit("conversation", f"model_output SUBSTITUTED {_verdict_brief(verdict)}")
    return _refusal_text(verdict)


def _apply_redactions(text: str, judged: str, verdict) -> str | None:
    """The redacted form of `text`, or None when the verdict cannot be carried out.

    `judged` is the exact string the runtime scored — span offsets index into THAT,
    which is the whole difficulty. Two paths, in order:

    1. `text is judged` → slice by offsets, applied right-to-left so replacing one
       span never shifts the next one's start.
    2. otherwise → recover each value from `judged[start:end]` and replace the value
       wherever it appears in `text`, longest first so a value that is a substring of
       another cannot corrupt it. This is the runtime's own reasoning for masking by
       value rather than offset (policy-engine/redact.ts): the moment the string is
       not byte-identical to what the detector saw, offsets are meaningless — and
       here they routinely are not, because Hermes' finalizer can append to an
       answer between post_api_request and transform_llm_output.

    Returns None — meaning FAIL CLOSED, the caller withholds the content — when
    there are no spans, when an offset does not fit `judged`, or when a recovered
    value is absent from `text`. A redact that silently applies to nothing is the
    one outcome that must not happen: it would read as "redacted" while shipping the
    value verbatim. The runtime degrades an unfulfillable redact to `block` for the
    same reason (policy-engine/evaluate.ts).
    """
    spans = ((verdict.modifications or {}) if hasattr(verdict, "modifications") else {}) \
        .get("spans") or []
    if not spans:
        return None

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
    """What goes in place of a span.

    Defaults to the verdict's own `replacement` — the `${OGR_PHONE_1}` placeholder,
    which is worth keeping: it is stable per `ref`, so two occurrences of one value
    read as one value, and the console can correlate the finding with what the user
    saw. `OGR_REDACT_MASK` swaps in a flat string for deployments that would rather
    show `[已隐去]` than a variable reference — at the cost of that distinction, which
    is a fair trade at the end of the line, where nobody restores anything.
    """
    mask = os.environ.get("OGR_REDACT_MASK", "").strip()
    if mask:
        return mask
    replacement = span.get("replacement")
    if isinstance(replacement, str) and replacement:
        return replacement
    ref = span.get("ref")
    return f"${{{ref}}}" if ref else "[redacted]"


def _refusal_text(verdict) -> str:
    """What the user gets instead of the blocked answer.

    Deliberately says NOTHING about why. The person on the other end of a blocked
    answer is an end user — a bank's customer, in the case this was first tested
    against — and everything the verdict carries is written for someone else: the
    tenant's rule text is instructions for the judge ("因为这是招商银行的智能客服…"),
    and the categories are taxonomy ids (`x.ogr.off_topic`). Leaking either turns a
    refusal into an internals dump, and the rule text also tells an adversary
    exactly what to route around. Both are already in the audit log and the console,
    where the operator can see them.

    Set `OGR_REFUSAL_TEXT` to the sentence this deployment should say — the tenant
    owns this copy (voice, language, whether to name a support channel), and no
    default is right for every deployment.
    """
    custom = os.environ.get("OGR_REFUSAL_TEXT", "").strip()
    if custom:
        return custom
    if verdict.decision == "require_approval":
        return ("This response needs to be reviewed by a person before it can be "
                "shown. Please try again later or contact support.")
    return "Sorry — I can't help with that here."


def on_pre_tool_call(tool_name="", args=None, session_id="", tool_call_id="",
                      task_id="", turn_id="", api_request_id="", **_):
    """invocation altitude: DETECT + BLOCK before the tool runs."""
    args = args if isinstance(args, dict) else {}
    guard_id = _id("ga")
    provenance = _provenance_for(session_id)
    # Belongs with the round that CONSUMES this call's result, one turn after
    # the round that asked for it (see _turn_number's docstring).
    turn = _turn_number(turn_id, api_request_id, offset=1)

    ev = GuardEvent(
        kind="tool_call", observation_point="invocation",
        # Per-instance identity assertion (platform.py): hermes-<OGR_INSTANCE>,
        # attestation claim client_key — the runtime clamps to enrollment scope.
        # Overridden with the subagent's own lineage-linked identity when this
        # task_id isn't the top-level conversation's (see _lineage_for).
        **subject_for(**_lineage_for(task_id)),
        payload={"name": tool_name, "arguments": args},
        event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
        session_id=session_id, provenance=provenance,
    )
    verdict = _evaluate(ev, turn_id, turn)  # /evaluate records; no re-report (v0.6)

    # hand the guard-context to the execution wrapper for the SAME logical action
    _set_guardcontext(guard_id, session_id, provenance, task_id, turn_id, api_request_id)

    untrusted = any(p.trust == "untrusted" for p in provenance)
    _audit("invocation", f"tool={tool_name} untrusted_ctx={untrusted} "
                         f"{_verdict_brief(verdict)} :: {args}")
    if verdict.decision not in _ALLOW_DECISIONS:
        # Including `redact`: the arguments are what would have to change, and this
        # hook cannot change them, so the decision degrades to the denial it was a
        # softer form of. Saying so in the message matters — the agent can strip the
        # value and retry, which is exactly what the runtime intends a redact on an
        # action to achieve.
        message = _verdict_brief(verdict)
        if verdict.decision == "redact":
            message = (f"{message} — arguments must be redacted before this call can "
                       f"run; remove the flagged value and retry")
        return {"action": "block", "message": message}
    return None


def on_post_tool_call(tool_name="", args=None, result=None, session_id="",
                       task_id="", turn_id="", api_request_id="", tool_call_id="",
                       status="", error_type="", error_message="", **_):
    """provenance tracking (a tool that pulls in external content taints the
    session, so subsequent exec actions inherit untrusted provenance) AND
    transcript observability: reports the OGR v0.4 `tool_result` kind so the
    runtime's Run/Turn view has the result, not just the call. Carries
    Hermes' own status/error_type/error_message (already computed by
    model_tools.py's _tool_result_observer_fields before this hook fires) so
    the console can show a failed call as an error, not a generic result."""
    if tool_name in _UNTRUSTED_RESULT_TOOLS and result:
        _taint_session(session_id, "web")
        _audit("provenance", f"tainted session={session_id} via {tool_name} "
                             f"-> subsequent actions inherit untrusted provenance")
    turn = _turn_number(turn_id, api_request_id, offset=1)
    text = result if isinstance(result, str) else json.dumps(result)
    payload: dict[str, Any] = {"name": tool_name, "result": text}
    if status:
        payload["status"] = status
    if error_type:
        payload["error_type"] = error_type
    if error_message:
        payload["error_message"] = error_message
    try:
        ev = GuardEvent(
            kind="tool_result", observation_point="invocation",
            **subject_for(**_lineage_for(task_id)),
            payload=payload,
            timestamp=_now(),
            session_id=session_id,
        )
        # Same decide-here / act-there split as the answer: this hook is
        # observational (model_tools.py says so where it fires), and
        # transform_tool_result is what can replace the string before it re-enters
        # the model's context. That is the point of redacting a tool result at all —
        # a page full of personal data should not become context just because the
        # agent fetched it.
        verdict = _evaluate(ev, turn_id, turn)
        if verdict.decision not in _ALLOW_DECISIONS:
            _audit("invocation", f"tool_result {tool_name} {_verdict_brief(verdict)}")
            _pending_result_action[tool_call_key(session_id, tool_call_id)] = (verdict, text)
    except Exception as exc:  # noqa: BLE001
        _audit("invocation", f"tool_result report failed: {exc}")
    return None


def tool_call_key(session_id: str, tool_call_id: str) -> str:
    """Hand-off key between post_tool_call and transform_tool_result.

    Keyed by tool_call_id, not session: several tools can be in flight
    concurrently (model_tools.py dispatches them in parallel), so a per-session slot
    would let one call's verdict land on another's result.
    """
    return f"{session_id}\x00{tool_call_id}"


def on_transform_tool_result(tool_name="", result=None, session_id="",
                             tool_call_id="", **_):
    """invocation altitude: ENFORCE on a tool result before it becomes context.

    Redact rewrites the result; block/require_approval replace it with an error the
    agent can read (the same shape a blocked call returns), because handing the model
    the content anyway would defeat the decision. Nothing parked = nothing to do."""
    parked = _pending_result_action.pop(tool_call_key(session_id, tool_call_id), None)
    if parked is None:
        return None
    verdict, judged = parked
    text = result if isinstance(result, str) else json.dumps(result)
    if verdict.decision == "redact":
        redacted = _apply_redactions(text, judged, verdict)
        if redacted is not None:
            _audit("invocation", f"tool_result {tool_name} REDACTED")
            return redacted
        _audit("invocation", f"tool_result {tool_name} redact UNFULFILLABLE — withheld")
    else:
        _audit("invocation", f"tool_result {tool_name} WITHHELD")
    return json.dumps(
        {"error": f"tool result withheld by OpenGuardrails: {_verdict_brief(verdict)}"},
        ensure_ascii=False,
    )


# --------------------------------------------------------------------------- #
# execution altitude: evaluate a real exec just before it runs
# --------------------------------------------------------------------------- #
def guard_exec(command: str, cwd: str = "/workspace") -> tuple[bool, str]:
    """Called by the BaseEnvironment.execute wrapper. Returns (allowed, brief).

    Sees the REAL argv + resolved secret-bearing env keys — which the agent_hook
    (working from tool args) may not. Inherits guard_id + provenance via the
    thread-local guard-context, so it decides on the same logical action and can
    only TIGHTEN the hook's decision.
    """
    guard_id, session_id, provenance, task_id, turn_id, api_request_id = _take_guardcontext()
    env_keys = sorted(k for k, v in os.environ.items() if _is_secret_env(k, v))
    turn = _turn_number(turn_id, api_request_id, offset=1)
    ev = GuardEvent(
        kind="exec", observation_point="execution",
        **subject_for(sandbox_id="sbx", **_lineage_for(task_id)),
        payload={"argv": ["bash", "-c", command], "cwd": cwd, "env_keys": env_keys},
        event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
        session_id=session_id, provenance=provenance,
    )
    verdict = _evaluate(ev)  # /evaluate records; no re-report (v0.6)
    allowed = verdict.decision in _ALLOW_DECISIONS
    _audit("execution", f"argv={['bash', '-c', command]} secret_env={env_keys} "
                      f"{_verdict_brief(verdict)}")
    return allowed, _verdict_brief(verdict)
