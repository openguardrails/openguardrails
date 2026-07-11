"""Sandbox-altitude enforcement for Hermes.

Hermes has NO environment-level plugin hook, so to observe the *real* exec
(the adversary-proof altitude) we wrap the single exec chokepoint:
``tools.environments.base.BaseEnvironment.execute``. Every backend
(local subprocess, docker exec, modal, ssh) routes through it.

This is the one place the integration patches Hermes internals; it is optional
and fails open (logs + runs normally) if Hermes' layout differs. If you run the
LOCAL backend there is no isolation boundary, but this wrapper still inspects
the real argv/env BEFORE the process starts and can block — i.e. OGR degrades
to intent-level enforcement when no true sandbox exists.
"""
from __future__ import annotations

import logging
import os

from . import bridge

logger = logging.getLogger("ogr-guard.sandbox")

_installed = False

# Which sandbox backend enforces the resource boundary at the sandbox altitude:
#   argv      — (default) OGR's argv-level decision only; no OS isolation
#   srt       — run the real exec under Anthropic Sandbox Runtime (personal)
# Team deployments use OpenShell at the gateway, not this in-process wrapper.
_BACKEND = os.environ.get("OGR_SANDBOX", "argv").lower()


def install_sandbox_guard() -> bool:
    """Wrap BaseEnvironment.execute with an OGR sandbox check. Idempotent."""
    global _installed
    if _installed:
        return True
    try:
        from tools.environments.base import BaseEnvironment  # type: ignore
    except Exception as exc:  # pragma: no cover - layout/version drift
        logger.warning("OGR sandbox guard not installed (Hermes env layout): %s", exc)
        return False

    original_execute = BaseEnvironment.execute

    def guarded_execute(self, command, *args, **kwargs):
        cwd = kwargs.get("cwd") or (args[0] if args else "") or "/workspace"
        try:
            allowed, brief = bridge.guard_exec(str(command), cwd=str(cwd))
        except Exception as exc:  # never break the agent on a guard error
            logger.warning("OGR sandbox check errored, failing open: %s", exc)
            allowed, brief = True, ""
        if not allowed:
            logger.info("OGR sandbox BLOCKED exec: %s", brief)
            return {"output": f"{brief}\n(execution blocked by OpenGuardrails sandbox policy)",
                    "returncode": 126}
        # allowed by the OGR decision — now enforce the OS-level boundary too,
        # if a real sandbox backend is configured.
        run_command = _maybe_wrap_for_backend(str(command))
        if run_command is not command and run_command != command:
            return original_execute(self, run_command, *args, **kwargs)
        return original_execute(self, command, *args, **kwargs)

    BaseEnvironment.execute = guarded_execute  # type: ignore[assignment]
    _installed = True
    logger.info("OGR sandbox guard installed (backend=%s) on BaseEnvironment.execute",
                _BACKEND)
    return True


def _maybe_wrap_for_backend(command: str) -> str:
    """When OGR_SANDBOX=srt, rewrite the command to run under srt with settings
    compiled from the active OGR policy. Returns the command unchanged for the
    default 'argv' backend or if srt isn't installed."""
    if _BACKEND != "srt":
        return command
    try:
        from .sandbox import srt as ogr_srt
        if not ogr_srt.srt_available():
            logger.warning("OGR_SANDBOX=srt but `srt` not on PATH; running unwrapped")
            return command
        policy = bridge.get_runtime_policy()
        settings = ogr_srt.settings_path_for(policy)
        argv = ogr_srt.wrap_command(command, settings)
        bridge._audit("sandbox", f"backend=srt settings={settings} -> {argv[:3]} ...")
        # BaseEnvironment.execute takes a shell string; join the srt invocation.
        import shlex
        return " ".join(shlex.quote(a) for a in argv)
    except Exception as exc:
        logger.warning("srt wrap failed, running unwrapped: %s", exc)
        return command
