"""Exec-vantage enforcement for Hermes.

Hermes has NO environment-level plugin hook, so to see the *real* exec — the
actual argv, after any script indirection the tool arguments hid — we wrap
the single exec chokepoint: ``tools.environments.base.BaseEnvironment
.execute``. Every backend (local subprocess, docker exec, modal, ssh) routes
through it.

This is the one place the integration patches Hermes internals; it is
optional and fails open (logs + runs normally) if Hermes' layout differs.
The guard itself is one evaluate: bridge.guard_exec sends the command as a
canonical step/response fragment and the configured fail mode governs an
unanswered call, exactly as at every other seam.

(v0.6 note: this module used to also compile OGR policy into srt/OpenShell
sandbox settings and correlate the exec with its pre_tool_call via a
thread-local guard-context. Both were built on wire fields v0.8 removed —
policy lives runtime-side and there is no cross-event correlation to
declare — so they were deleted, not ported. See the README.)
"""
from __future__ import annotations

import logging

from . import bridge

logger = logging.getLogger("ogr-guard.sandbox")

_installed = False


def install_sandbox_guard() -> bool:
    """Wrap BaseEnvironment.execute with an OGR exec check. Idempotent."""
    global _installed
    if _installed:
        return True
    try:
        from tools.environments.base import BaseEnvironment  # type: ignore
    except Exception as exc:  # pragma: no cover - layout/version drift
        logger.warning("OGR exec guard not installed (Hermes env layout): %s", exc)
        return False

    original_execute = BaseEnvironment.execute

    def guarded_execute(self, command, *args, **kwargs):
        cwd = kwargs.get("cwd") or (args[0] if args else "") or "/workspace"
        try:
            allowed, brief = bridge.guard_exec(str(command), cwd=str(cwd))
        except Exception as exc:  # never break the agent on a guard error
            logger.warning("OGR exec check errored, failing open: %s", exc)
            allowed, brief = True, ""
        if not allowed:
            return {"output": f"{brief}\n(execution blocked by OpenGuardrails)",
                    "returncode": 126}
        return original_execute(self, command, *args, **kwargs)

    BaseEnvironment.execute = guarded_execute  # type: ignore[assignment]
    _installed = True
    logger.info("OGR exec guard installed on BaseEnvironment.execute")
    return True
