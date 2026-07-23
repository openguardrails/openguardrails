"""OGR <-> Hermes bridge: turns Hermes plugin-hook callbacks into OGR
GuardEvents, runs them through one Runtime, and enforces the verdict.

This is the real-integration counterpart to the mocked ``adapters/hermes.py``
demo. It reuses the same ``ogr`` reference runtime + ``policy.json``.

Altitude mapping (see README):
    pre_api_request / post_api_request  -> observation_point="gateway"   (detect + taint)
    pre_tool_call                       -> observation_point="agent_hook" (DETECT + BLOCK)
    post_tool_call                      -> provenance/taint tracking
    BaseEnvironment.execute (wrapped)   -> observation_point="sandbox"    (DETECT + BLOCK)

Correlation: pre_tool_call mints a guard_id and stashes a guard-context on a
thread-local; the sandbox wrapper reads it so both altitudes decide on ONE
logical action. Provenance tainted at the gateway/post_tool_call flows into the
agent_hook + sandbox events, so the SAME command gets a different verdict
depending on where it came from.
"""
from __future__ import annotations

import itertools
import json
import os
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openguardrails import GuardEvent, Provenance, Runtime
from openguardrails.detectors.config_rules import ConfigRulesDetector
from openguardrails.detectors.llm_judge import LLMJudgeDetector

from .platform import agent_id, event_to_wire, get_reporter, subject_for

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

# guard-context handed from pre_tool_call -> sandbox wrapper, per OS thread
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


def _report(ev: GuardEvent, turn_id: str = "") -> None:
    """Serialize + report a GuardEvent, stamping the runtime-only `run_id`
    extension field (guardEventExtSchema) from Hermes' own turn_id when
    known — explicit, rather than relying on the runtime's timestamp-order
    fallback ("a new run starts at each user_input in a session"), which is
    fragile once events from concurrent subagents interleave in one batch."""
    wire = event_to_wire(ev)
    if turn_id:
        wire["run_id"] = turn_id
    get_reporter().report(wire)


def _report_spawn(child_id: str) -> None:
    try:
        ev = GuardEvent(
            kind="agent_spawn", observation_point="agent_hook",
            subject=subject_for(),
            payload={"child_agent_id": child_id, "child_agent_type": "hermes.subagent"},
            event_id=_id("evt"), guard_id=_id("ga"), timestamp=_now(),
        )
        _report(ev)
    except Exception as exc:  # noqa: BLE001
        _audit("agent_hook", f"agent_spawn report failed: {exc}")

# tools whose *results* introduce untrusted content into the agent's context
_UNTRUSTED_RESULT_TOOLS = {"web_search", "web_extract", "web_fetch", "fetch_url",
                           "browser", "mcp", "read_url"}
# tools that actually run code/commands -> candidates for sandbox-altitude exec
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

_ALLOW_DECISIONS = {"allow", "modify", "redact"}  # non-blocking verdicts


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


# --------------------------------------------------------------------------- #
# guard-context propagation (spec: provenance-and-context.md)
# --------------------------------------------------------------------------- #
def _set_guardcontext(
    guard_id: str, session_id: str, provenance: list[Provenance],
    task_id: str = "", turn_id: str = "",
) -> None:
    _tls.guard_id = guard_id
    _tls.session_id = session_id
    _tls.provenance = provenance
    _tls.task_id = task_id
    _tls.turn_id = turn_id


def _take_guardcontext() -> tuple[str, str, list[Provenance], str, str]:
    return (
        getattr(_tls, "guard_id", "") or _id("ga"),
        getattr(_tls, "session_id", "") or "unknown",
        getattr(_tls, "provenance", []) or [],
        getattr(_tls, "task_id", "") or "",
        getattr(_tls, "turn_id", "") or "",
    )


# --------------------------------------------------------------------------- #
# provenance / taint
# --------------------------------------------------------------------------- #
def _principal_provenance() -> list[Provenance]:
    return [Provenance("user", "trusted")]


def _provenance_for(session_id: str) -> list[Provenance]:
    """Provenance to attach to an action: the principal, PLUS any untrusted
    content the session has ingested (which is what makes injection dangerous).
    """
    prov = _principal_provenance()
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


def on_pre_api_request(session_id="", task_id="", turn_id="", user_message=None, **_):
    """gateway altitude: reports the OGR v0.4 `user_input` transcript kind —
    the runtime derives Run boundaries server-side from it ("a new run starts
    at each user_input in a session"); without it a hermes session was only
    ever visible as isolated tool_call/exec actions, never a Run. Observe-only
    (Hermes can't block here)."""
    text = user_message if isinstance(user_message, str) else ""
    if not text or turn_id in _reported_turns:
        return None
    _reported_turns.add(turn_id)
    try:
        _report(GuardEvent(
            kind="user_input", observation_point="gateway",
            subject=subject_for(**_lineage_for(task_id)),
            payload={"text": text},
            event_id=_id("evt"), guard_id=_id("ga"), timestamp=_now(),
            session_id=session_id,
        ), turn_id)
    except Exception as exc:  # noqa: BLE001
        _audit("gateway", f"user_input report failed: {exc}")
    return None


def on_post_api_request(session_id="", task_id="", turn_id="", assistant_message=None, **_):
    """gateway altitude: reports the OGR v0.4 `model_output` transcript kind
    (the completion's text + any planned tool calls) — completes the
    transcript pre_api_request starts. Observe-only."""
    text = getattr(assistant_message, "content", "") or ""
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
    if not text and not tool_calls:
        return None
    try:
        _report(GuardEvent(
            kind="model_output", observation_point="gateway",
            subject=subject_for(**_lineage_for(task_id)),
            payload={"text": text, "tool_calls": tool_calls},
            event_id=_id("evt"), guard_id=_id("ga"), timestamp=_now(),
            session_id=session_id,
        ), turn_id)
    except Exception as exc:  # noqa: BLE001
        _audit("gateway", f"model_output report failed: {exc}")
    return None


def on_pre_tool_call(tool_name="", args=None, session_id="", tool_call_id="",
                      task_id="", turn_id="", **_):
    """agent_hook altitude: DETECT + BLOCK before the tool runs."""
    args = args if isinstance(args, dict) else {}
    guard_id = _id("ga")
    provenance = _provenance_for(session_id)

    ev = GuardEvent(
        kind="tool_call", observation_point="agent_hook",
        # Per-instance identity assertion (platform.py): hermes-<OGR_INSTANCE>,
        # attestation claim client_key — the runtime clamps to enrollment scope.
        # Overridden with the subagent's own lineage-linked identity when this
        # task_id isn't the top-level conversation's (see _lineage_for).
        subject=subject_for(**_lineage_for(task_id)),
        payload={"name": tool_name, "arguments": args},
        event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
        session_id=session_id, provenance=provenance,
    )
    verdict = get_runtime().evaluate(ev)
    _report(ev, turn_id)  # fire-and-forget platform observability

    # hand the guard-context to the sandbox wrapper for the SAME logical action
    _set_guardcontext(guard_id, session_id, provenance, task_id, turn_id)

    untrusted = any(p.trust == "untrusted" for p in provenance)
    _audit("agent_hook", f"tool={tool_name} untrusted_ctx={untrusted} "
                         f"{_verdict_brief(verdict)} :: {args}")
    if verdict.decision not in _ALLOW_DECISIONS:
        return {"action": "block", "message": _verdict_brief(verdict)}
    return None


def on_post_tool_call(tool_name="", args=None, result=None, session_id="",
                       task_id="", turn_id="", **_):
    """provenance tracking (a tool that pulls in external content taints the
    session, so subsequent exec actions inherit untrusted provenance) AND
    transcript observability: reports the OGR v0.4 `tool_result` kind so the
    runtime's Run/Turn view has the result, not just the call."""
    if tool_name in _UNTRUSTED_RESULT_TOOLS and result:
        _taint_session(session_id, "web")
        _audit("provenance", f"tainted session={session_id} via {tool_name} "
                             f"-> subsequent actions inherit untrusted provenance")
    try:
        _report(GuardEvent(
            kind="tool_result", observation_point="agent_hook",
            subject=subject_for(**_lineage_for(task_id)),
            payload={"name": tool_name, "result": result if isinstance(result, str) else json.dumps(result)},
            event_id=_id("evt"), guard_id=_id("ga"), timestamp=_now(),
            session_id=session_id,
        ), turn_id)
    except Exception as exc:  # noqa: BLE001
        _audit("agent_hook", f"tool_result report failed: {exc}")
    return None


# --------------------------------------------------------------------------- #
# sandbox altitude: evaluate a real exec just before it runs
# --------------------------------------------------------------------------- #
def guard_exec(command: str, cwd: str = "/workspace") -> tuple[bool, str]:
    """Called by the BaseEnvironment.execute wrapper. Returns (allowed, brief).

    Sees the REAL argv + resolved secret-bearing env keys — which the agent_hook
    (working from tool args) may not. Inherits guard_id + provenance via the
    thread-local guard-context, so it decides on the same logical action and can
    only TIGHTEN the hook's decision.
    """
    guard_id, session_id, provenance, task_id, turn_id = _take_guardcontext()
    env_keys = sorted(k for k, v in os.environ.items() if _is_secret_env(k, v))
    ev = GuardEvent(
        kind="exec", observation_point="sandbox",
        subject=subject_for(sandbox_id="sbx", **_lineage_for(task_id)),
        payload={"argv": ["bash", "-c", command], "cwd": cwd, "env_keys": env_keys},
        event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
        session_id=session_id, provenance=provenance,
    )
    verdict = get_runtime().evaluate(ev)
    _report(ev, turn_id)
    allowed = verdict.decision in _ALLOW_DECISIONS
    _audit("sandbox", f"argv={['bash', '-c', command]} secret_env={env_keys} "
                      f"{_verdict_brief(verdict)}")
    return allowed, _verdict_brief(verdict)
