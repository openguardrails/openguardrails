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
import threading
from datetime import datetime, timezone
from pathlib import Path

from openguardrails import GuardEvent, Provenance, Runtime
from openguardrails.detectors.config_rules import ConfigRulesDetector
from openguardrails.detectors.llm_judge import LLMJudgeDetector

_seq = itertools.count(1)
_lock = threading.Lock()

# guard-context handed from pre_tool_call -> sandbox wrapper, per OS thread
# (each Hermes tool call dispatches + execs on one thread).
_tls = threading.local()

# per-session taint picked up from untrusted inputs (web fetches, mcp, etc.)
_session_taint: dict[str, list[Provenance]] = {}

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
        return f"{prefix}-{next(_seq):04d}"


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
def _set_guardcontext(guard_id: str, session_id: str, provenance: list[Provenance]) -> None:
    _tls.guard_id = guard_id
    _tls.session_id = session_id
    _tls.provenance = provenance


def _take_guardcontext() -> tuple[str, str, list[Provenance]]:
    return (
        getattr(_tls, "guard_id", "") or _id("ga"),
        getattr(_tls, "session_id", "") or "unknown",
        getattr(_tls, "provenance", []) or [],
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
def on_pre_api_request(request_messages=None, session_id="", **_):
    """gateway altitude: inspect the outbound prompt. Observe-only (Hermes
    can't block here) — used to TAINT the session if untrusted content rode in
    on tool results, so later tool calls inherit provenance."""
    # The conversation already encodes tool results; we rely on post_tool_call
    # for precise tainting, so this hook is a no-op placeholder for the
    # gateway altitude (kept to show where prompt-level detection would run).
    return None


def on_post_api_request(assistant_message=None, session_id="", **_):
    """gateway altitude: inspect the completion (e.g. the model's planned tool
    calls). Observe-only. Left as an extension point."""
    return None


def on_pre_tool_call(tool_name="", args=None, session_id="", tool_call_id="", **_):
    """agent_hook altitude: DETECT + BLOCK before the tool runs."""
    args = args if isinstance(args, dict) else {}
    guard_id = _id("ga")
    provenance = _provenance_for(session_id)

    ev = GuardEvent(
        kind="tool_call", observation_point="agent_hook",
        subject={"agent_id": "hermes", "agent_type": "hermes", "principal": "user:tom"},
        payload={"name": tool_name, "arguments": args},
        event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
        session_id=session_id, provenance=provenance,
    )
    verdict = get_runtime().evaluate(ev)

    # hand the guard-context to the sandbox wrapper for the SAME logical action
    _set_guardcontext(guard_id, session_id, provenance)

    untrusted = any(p.trust == "untrusted" for p in provenance)
    _audit("agent_hook", f"tool={tool_name} untrusted_ctx={untrusted} "
                         f"{_verdict_brief(verdict)} :: {args}")
    if verdict.decision not in _ALLOW_DECISIONS:
        return {"action": "block", "message": _verdict_brief(verdict)}
    return None


def on_post_tool_call(tool_name="", args=None, result=None, session_id="", **_):
    """provenance tracking: a tool that pulls in external content taints the
    session, so subsequent exec actions inherit untrusted provenance."""
    if tool_name in _UNTRUSTED_RESULT_TOOLS and result:
        _taint_session(session_id, "web")
        _audit("provenance", f"tainted session={session_id} via {tool_name} "
                             f"-> subsequent actions inherit untrusted provenance")
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
    guard_id, session_id, provenance = _take_guardcontext()
    env_keys = sorted(k for k, v in os.environ.items() if _is_secret_env(k, v))
    ev = GuardEvent(
        kind="exec", observation_point="sandbox",
        subject={"agent_id": "hermes", "agent_type": "hermes", "sandbox_id": "sbx"},
        payload={"argv": ["bash", "-c", command], "cwd": cwd, "env_keys": env_keys},
        event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
        session_id=session_id, provenance=provenance,
    )
    verdict = get_runtime().evaluate(ev)
    allowed = verdict.decision in _ALLOW_DECISIONS
    _audit("sandbox", f"argv={['bash', '-c', command]} secret_env={env_keys} "
                      f"{_verdict_brief(verdict)}")
    return allowed, _verdict_brief(verdict)
