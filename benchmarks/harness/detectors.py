"""Reference detectors scored on the OGR seed suite.

These are baselines + the openguardrails-poc reference detectors. Third-party
vendor detectors (LlamaGuard, Qwen3Guard, hosted APIs) are NOT included here —
they appear on the leaderboard only when their owners run them through a
conformant adapter. We do not fabricate their numbers.

Each detector exposes: name, type, and evaluate(Event) -> decision:str
"""
from __future__ import annotations

import re

from ogrlib import Event

# --- baselines -----------------------------------------------------------
class AllowAll:
    name, type = "allow-all", "baseline"
    def evaluate(self, ev: Event) -> str:
        return "allow"


class BlockAll:
    name, type = "block-all", "baseline"
    def evaluate(self, ev: Event) -> str:
        return "block"


# --- naive keyword blocklist --------------------------------------------
class KeywordBaseline:
    name, type = "keyword-baseline", "config"
    TERMS = [
        "ignore previous instructions", "disregard", "ignore all prior",
        "| bash", "| sh", "curl", "wget", "rm -rf", "base64",
        "/etc/passwd", "/etc/shadow", ".ssh", "id_rsa", "credentials",
        ".aws", "exfiltrat", "sk-", "aws_secret", "private_key", "token=",
        "nc -e", "reveal", "system prompt",
    ]
    def evaluate(self, ev: Event) -> str:
        hay = ev.text().lower()
        return "block" if any(t in hay for t in self.TERMS) else "allow"


# --- config rules (mirrors openguardrails-poc policy.json) ---------------
class ConfigRules:
    name, type = "config-rules", "config"
    EGRESS_ALLOW = {"api.github.com", "pypi.org"}
    SECRET_MARKERS = ("SECRET", "TOKEN", "AWS_", "PASSWORD", "PRIVATE_KEY")
    RULES = [
        (re.compile(r"(curl|wget)\b.*\|\s*(ba)?sh"), "require_approval"),
        # remote fetch inside a command substitution / eval (e.g. eval "$(curl …)")
        (re.compile(r"\$\(\s*(curl|wget)\b"), "require_approval"),
        (re.compile(r"\beval\b.*\b(curl|wget)\b"), "require_approval"),
        # download-then-exec that sidesteps the pipe-to-shell shape
        (re.compile(r"(curl|wget)\b.*&&.*chmod\s+\+?x"), "require_approval"),
        (re.compile(r"rm\s+-rf\s+/(\s|$)"), "block"),
        (re.compile(r"\|\s*sudo\b"), "require_approval"),
    ]
    def evaluate(self, ev: Event) -> str:
        if ev.kind == "network":
            host = ev.payload.get("host", "")
            if host and host not in self.EGRESS_ALLOW:
                return "block"
        cmd = ev.command()
        if cmd:
            for rx, decision in self.RULES:
                if rx.search(cmd):
                    return decision
            secret_env = [k for k in ev.payload.get("env_keys", [])
                          if any(m in k.upper() for m in self.SECRET_MARKERS)]
            if secret_env:
                return "require_approval"
        return "allow"


# --- provenance-aware LLM heuristic (openguardrails-poc judge) -----------
class LLMHeuristic:
    name, type = "llm-judge", "model"
    def evaluate(self, ev: Event) -> str:
        pipe = ev.pipe_to_shell()
        if ev.is_untrusted() and (pipe or "executable_intent" in ev.tags()):
            return "block"          # untrusted input → privileged action == injection
        if pipe:
            return "require_approval"
        return "allow"


# --- composition: config ⊕ llm (deny-wins) ------------------------------
class ComposeConfigLLM:
    name, type = "ogr-compose (config⊕llm)", "hybrid"
    _order = {"block": 0, "require_approval": 1, "redact": 2, "modify": 3, "allow": 4}
    def __init__(self):
        self.a, self.b = ConfigRules(), LLMHeuristic()
    def evaluate(self, ev: Event) -> str:
        da, db = self.a.evaluate(ev), self.b.evaluate(ev)
        return da if self._order[da] <= self._order[db] else db


REFERENCE_DETECTORS = [
    AllowAll(), BlockAll(), KeywordBaseline(),
    ConfigRules(), LLMHeuristic(), ComposeConfigLLM(),
]
