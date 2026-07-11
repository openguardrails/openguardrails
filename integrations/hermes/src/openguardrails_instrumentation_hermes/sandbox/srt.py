"""OGR -> Anthropic Sandbox Runtime (srt) adapter — the PERSONAL scenario.

srt (`@anthropic-ai/sandbox-runtime`) is a containerless, OS-level sandbox
(macOS `sandbox-exec` / Linux `bubblewrap`) that enforces filesystem + network
restrictions on a single process. It maps perfectly onto Hermes' default `local`
backend on a developer laptop.

This adapter makes the OGR policy the single source of truth for the sandbox:
the `sandbox` block of `policy.json` is compiled into an srt settings file, and a
command is wrapped as `srt --settings <file> "<command>"`. The OGR decision
(allow/block) still happens first at the agent_hook altitude; srt then enforces
the *resource* boundary at the OS level — closing the argv-regex blind spot
(e.g. a `python3` heredoc that open()s a credential file is stopped because the
path is in srt's `filesystem.denyRead`).

srt does not need to be installed to *generate* settings — only to *run*.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path


def policy_to_srt_settings(policy: dict) -> dict:
    """Compile the OGR policy's `sandbox` block into an srt settings dict
    (the `~/.srt-settings.json` schema)."""
    sb = policy.get("sandbox", {})
    egress = sb.get("egress_allowlist") or policy.get("config_rules", {}).get("egress_allowlist", [])
    return {
        "network": {
            "allowedDomains": list(egress),
            "deniedDomains": list(sb.get("deny_egress", [])),
            "allowLocalBinding": False,
        },
        "filesystem": {
            # all reads allowed by default; deny the sensitive regions OGR names
            "denyRead": list(sb.get("deny_read", [])),
            "allowRead": [],
            # all writes denied by default; allow only the workspace
            "allowWrite": list(sb.get("workspace_write", [".", "/tmp"])),
            "denyWrite": list(sb.get("deny_write", [])),
        },
    }


def write_srt_settings(policy: dict, dest: str | None = None) -> str:
    """Write the compiled settings to a temp file; return its path."""
    settings = policy_to_srt_settings(policy)
    if dest is None:
        fd, dest = tempfile.mkstemp(prefix="ogr-srt-", suffix=".json")
        os.close(fd)
    Path(dest).write_text(json.dumps(settings, indent=2))
    return dest


def srt_available() -> bool:
    return shutil.which("srt") is not None


def wrap_command(command: str, settings_path: str) -> list[str]:
    """Return the argv that runs `command` under srt with the given settings.

    srt's `-c <command>` runs the string like `sh -c` (no escaping applied),
    which is what we want for an arbitrary shell command. A bare positional
    would be treated as a single program name.
    """
    return ["srt", "--settings", settings_path, "-c", command]


# --- convenience used by the Hermes plugin's sandbox_guard ------------------
_settings_cache: dict[int, str] = {}


def settings_path_for(policy: dict) -> str:
    """Memoize one settings file per policy object for the process lifetime."""
    key = id(policy)
    path = _settings_cache.get(key)
    if path and Path(path).exists():
        return path
    path = write_srt_settings(policy)
    _settings_cache[key] = path
    return path
