"""Local secrets redaction — the secret never leaves the host (OGR 1.4).

The reversible half of redaction: mask every secret in the OUTBOUND model request
into an ``OGRKP0000001`` token before it leaves the machine, restore the value
into a tool's arguments on the way INTO the tool — after every judgement and
approval — and never anywhere else. Stdlib only, like the rest of this
package: `re`, `json`, `urllib`, `os`, `threading`.

Four pieces, each small:

  Ruleset      — the org's secret rules as `GET /v1/rules` serves them,
                 compiled with CPython `re`, SELF-VERIFIED through each rule's
                 `examples` (a rule that fails in this engine is DISABLED and
                 logged by id, never run wrong). Cached on disk (0600), the id
                 is the ETag. A rule is its patterns MINUS its `reject_value`
                 filters — the closed predicate vocabulary below, served with
                 the patterns since OGR 1.4.
  SessionMap   — value <-> token, per session, IN MEMORY ONLY. Persisting it
                 would write the secrets to the disk hermes keeps them off.
  mask()       — known values first (longest first), then the rules in served
                 order, overlaps longest-wins, never inside an existing token.
  restore()    — whole-token exact match, with the markdown-escape tolerance
                 the higress `Restorer` defines; never fuzzy, never prefix. A
                 `${OGR_…}` shape with no map entry is reported UNRESOLVED and
                 the caller blocks the call: a shell expands it to nothing.

The plugin ships NO patterns — they are the org's asset, fetched with the
org's key (design D4). Design: openguardrails-airs
docs/local-secrets-redaction-design.md §3, §4, §8.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from typing import Any, Callable

logger = logging.getLogger("ogr-guard.redaction")

DIALECT = "ogr-re-1"
TOKEN_TYPE = "SECRET"

#: A placeholder as minted — by this plugin, by the runtime for the gateway
#: path, or by pii masking. `X` is the fixed non-restorable placeholder a
#: full map mints (§4.5): it matches the shape and can never be restored.
#: Either shape: the secrets shape ``OGRKP0000001`` — the fifth character names the
#: MINTER (``P`` this plugin, ``F`` openafw, ``R`` the runtime), which is what keeps
#: two allocators from handing one number to two values (minted since 2026-09-14 — a
#: value shape a model copies verbatim, where ``${OGR_SECRET_n}`` was rewritten as a
#: shell variable) and the ``${OGR_<TYPE>_n}`` shape (pii, and older tokens).
TOKEN_RE = re.compile(r"OGRK[0-9A-Z][0-9X]{7,}|\$\{OGR_[A-Z_]+_[0-9A-Z]+\}")

#: The same shape with markdown escapes tolerated, for reporting an escaped
#: token that no map entry matched (`${OGR\_SECRET\_9}`).
_ESCAPED_TOKEN_RE = re.compile(r"OGRK[0-9A-Z][0-9X]{7,}|\\?\$\\?\{OGR(?:\\?_[A-Z]+)+\\?_[0-9A-Z]+\\?\}")

#: Zero-width / control characters, stripped for MATCHING only — a token or a
#: value split by a ZWSP is still that token or value. hermes's own
#: `_CONTROL_CHARS_RE` MINUS the whitespace controls (`\t \n \r \v \f`, U+2028/9,
#: U+202F): those are STRUCTURE, and removing one for matching lets a value
#: run into the next line — measured: `Bearer pk_…8848\nok` matched as
#: `pk_…8848ok`. hermes can afford the wider set because its token-body
#: check re-validates each character; a rule's own character class is ours.
CONTROL_CHARS_RE = re.compile(
    r"[\x00-\x08\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060\ufeff]"
)

#: The fixed non-restorable placeholder for a value seen after the map filled.
#: One letter per allocator that can write into one model context; see the TS
#: library's `SECRET_TOKEN_MINTER` for the collision it closes.
TOKEN_MINTER = "P"

FULL_TOKEN = "OGRK%sXXXXXXX" % TOKEN_MINTER

#: Bound per session (§3, the `maxTokens` figure).
MAX_VALUES = 256

#: What the model is told when it used a token this session never issued
#: (§4.3). `%s` is the token.
UNRESOLVED_NOTICE = (
    "%s could not be restored: it is not a placeholder this session issued. "
    "Placeholders must be used exactly as they appear in your context; if the "
    "value was shown in an earlier session, ask the user to provide it again."
)

#: Punctuation a markdown renderer escapes — a fixed list on purpose (higress
#: `isEscapable`): a backslash before anything else stays literal, so
#: `C:\name` can never be read as an escape inside a token.
_ESCAPABLE = set("_*${}[]()#+-.!`~|<>\\")

_FLAG_MAP = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


# --------------------------------------------------------------------------- #
# reject_value — what a rule refuses to CALL a credential (OGR 1.4 §4.6)
# --------------------------------------------------------------------------- #
#
# A RULE IS ITS PATTERNS MINUS WHAT ITS FILTERS THROW AWAY. A reader that applies
# only the patterns runs a DIFFERENT rule from the one the runtime runs — and it
# finds that out by failing that rule's own `nomatch` examples, whose consequence
# under D9 is to DISABLE the rule by id. That happened: between 2026-09-01 and
# 2026-09-06 the filters lived only inside AIRS, eight examples across
# `password_assignment`, `url_credential` and `db_connection` were unsatisfiable
# from the patterns alone, and those three rules — the ones most likely to carry a
# real credential — were switching themselves off on every host, silently, because
# a rule that never fires looks exactly like a host with no secrets in its traffic.
#
# The vocabulary is CLOSED so it can be ported: seven predicate kinds, two part
# selectors, each one bounded pass over the matched span, none backtracking. The
# normative reference is AIRS's `scripts/secret-rules-conformance.py`; this and the
# TypeScript `predicates.ts` are its two ports. Every constant below is a
# TRANSCRIPTION of AIRS's `policy-engine/valuePredicates.ts` — the examples corpus
# is what catches one that drifted.
#
# ⚠️ AN UNKNOWN PREDICATE KIND DISABLES THE RULE and is never read as "no filter":
# filters only ever make a rule match LESS, so skipping one masks far more than the
# runtime calls a credential, and the plugin would then hand the tool back a value
# under a token nobody minted for it.

_PLACEHOLDER_SHAPES = [
    r"\*{3,}", r"x{3,}", r"\$\{", r"<", r">", r"%[sd]", r"\.{3,}", "\u2026",
    r"changeme", r"placeholder", r"redacted", r"your[_\-]?password", r"your[_\-]",
    r"example", r"\$",
]
_PLACEHOLDER_RE = re.compile("^(?:" + "|".join(_PLACEHOLDER_SHAPES) + ")", re.IGNORECASE)
_PLACEHOLDER_ANYWHERE_RE = re.compile("(?:" + "|".join(_PLACEHOLDER_SHAPES) + ")", re.IGNORECASE)

_SECRET_NOUNS = (
    r"password|passwd|pwd|secret|api[_\-]?key|access[_\-]?token|auth[_\-]?token|"
    r"client[_\-]?secret|refresh[_\-]?token|id[_\-]?token|session[_\-]?token|"
    r"private[_\-]?key|key[_\-]?material|raw[_\-]?secret|bearer|token"
)
_SECRET_NOUN_RE = re.compile("^(?:" + _SECRET_NOUNS + r")(?:[^A-Za-z0-9_]|$)", re.IGNORECASE)
_CONTAINS_SECRET_NOUN_RE = re.compile("(?:" + _SECRET_NOUNS + ")", re.IGNORECASE)
_VARIABLE_REF_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+|\[[^\]]*\])+$")
_IDENT_ONLY_RE = re.compile(r"^[A-Za-z0-9_$.\[\]\"']+$")
_IDENT_PATH_MARK_RE = re.compile(r"[._\[]")
_STRUCTURAL_RE = re.compile(r"[(){}]")

_SIMPLE_PREDICATES = {"placeholder", "secret_noun", "variable_reference", "names_secret", "structural"}
_MAX_VALUE_CHARS = 4096


def _shannon_bits(value: str) -> float:
    """Bits per character — the one predicate no regex can express at all."""
    if not value:
        return 0.0
    counts: dict[str, int] = {}
    for ch in value:
        counts[ch] = counts.get(ch, 0) + 1
    bits = 0.0
    for n in counts.values():
        p = n / len(value)
        bits -= p * math.log2(p)
    return bits


def _part_of(value: str, part: Any) -> str:
    if not isinstance(part, dict) or part.get("of") == "whole":
        return value
    sep = part.get("sep") or ""
    i = value.find(sep)
    if i < 0:
        return value
    return value[i + len(sep):] if part.get("of") == "after" else value[:i]


def compile_rejects(raw: Any, rule_id: str) -> tuple[list[dict[str, Any]] | None, str]:
    """Validate a served rule's `reject_value`, compiling any `matches` pattern.

    Returns (filters, "") or (None, reason). The caller disables the rule on a
    reason — see the note above on why an unknown kind is not "no filter".

    ⚠️ A `matches` flag outside the dialect is a reason, not a silent drop: `i`/`m`/`s`
    are the whole of it, and a rule asking for something else was written against an
    engine this is not.
    """
    if raw is None:
        return [], ""
    if not isinstance(raw, list):
        return None, "reject_value is not a list"
    out: list[dict[str, Any]] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            return None, f"reject_value[{i}] is not an object"
        pred = entry.get("predicate")
        if not isinstance(pred, dict) or not isinstance(pred.get("kind"), str):
            return None, f"reject_value[{i}] has no predicate"
        part = entry.get("part")
        if part is not None:
            if not isinstance(part, dict) or part.get("of") not in ("whole", "after", "before"):
                return None, f"reject_value[{i}]: unknown part"
            if part.get("of") != "whole" and not isinstance(part.get("sep"), str):
                return None, f"reject_value[{i}]: part without a sep"
        kind = pred["kind"]
        compiled: dict[str, Any] = {"part": part, "predicate": pred}
        if kind in _SIMPLE_PREDICATES:
            pass
        elif kind == "low_entropy":
            if not isinstance(pred.get("min"), (int, float)):
                return None, f"reject_value[{i}]: low_entropy without a numeric min"
        elif kind == "matches":
            source = pred.get("pattern")
            if not isinstance(source, str) or not source:
                return None, f"reject_value[{i}]: matches without a pattern"
            flags = 0
            for ch in str(pred.get("flags") or ""):
                if ch not in _FLAG_MAP:
                    return None, f"reject_value[{i}]: matches flag {ch!r} is outside the dialect"
                flags |= _FLAG_MAP[ch]
            try:
                compiled["re"] = re.compile(source, flags)
            except re.error as exc:
                return None, f"reject_value[{i}]: matches does not compile: {exc}"
        else:
            return None, f"reject_value[{i}]: unknown predicate {kind!r} (rule {rule_id})"
        out.append(compiled)
    return out, ""


def _value_rejected(value: str, rejects: list[dict[str, Any]]) -> bool:
    """Do any of this rule's filters REJECT the span? ANDed as "reject if any fires"."""
    if not rejects:
        return False
    bounded = value[:_MAX_VALUE_CHARS]
    for rule in rejects:
        target = _part_of(bounded, rule.get("part"))
        pred = rule["predicate"]
        kind = pred["kind"]
        if kind == "placeholder":
            if (_PLACEHOLDER_ANYWHERE_RE if pred.get("anywhere") else _PLACEHOLDER_RE).search(target):
                return True
        elif kind == "secret_noun":
            if _SECRET_NOUN_RE.search(target):
                return True
        elif kind == "variable_reference":
            if _VARIABLE_REF_RE.search(target):
                return True
        elif kind == "names_secret":
            if (_IDENT_ONLY_RE.search(target) and _IDENT_PATH_MARK_RE.search(target)
                    and _CONTAINS_SECRET_NOUN_RE.search(target)):
                return True
        elif kind == "structural":
            if _STRUCTURAL_RE.search(target):
                return True
        elif kind == "low_entropy":
            if _shannon_bits(target) < float(pred["min"]):
                return True
        elif kind == "matches":
            if rule["re"].search(target):
                return True
    return False


# --------------------------------------------------------------------------- #
# the ruleset
# --------------------------------------------------------------------------- #
class Rule:
    """One compiled rule. `patterns` is [(pattern_id, compiled)]."""

    __slots__ = ("id", "category", "severity", "tier", "group", "patterns", "rejects")

    def __init__(self, id: str, category: str, severity: str, tier: str,
                 group: int | None, patterns: list[tuple[str, re.Pattern[str]]],
                 rejects: list[dict[str, Any]] | None = None) -> None:
        self.id = id
        self.category = category
        self.severity = severity
        self.tier = tier
        self.group = group
        self.patterns = patterns
        self.rejects = rejects or []

    def spans(self, text: str) -> list[tuple[int, int, str]]:
        """Every (start, end, pattern_id) this rule claims in `text`.

        ⚠️ The filters run on the SPAN — the group where the rule declares one — and
        never on the whole match: they ask about the VALUE, and `Authorization: bearer`
        is not the value. Same position as the runtime's own `EntityDetector`.
        """
        out: list[tuple[int, int, str]] = []
        for pid, rx in self.patterns:
            for m in rx.finditer(text):
                start, end = _span(m, self.group)
                if start < 0 or end <= start:
                    continue
                if self.rejects and _value_rejected(text[start:end], self.rejects):
                    continue
                out.append((start, end, pid))
        return out


def _span(m: re.Match[str], group: int | None) -> tuple[int, int]:
    """The span a rule claims: the named capture group when it declares one,
    else the whole match. A declared group that did not participate is no
    span (start = -1), never a zero-width hit at the match start."""
    if not group:
        return m.span(0)
    try:
        return m.span(group)
    except (IndexError, re.error):
        return (-1, -1)


def _compile_flags(flags: str) -> int:
    out = 0
    for ch in (flags or ""):
        out |= _FLAG_MAP.get(ch, 0)
    return out


def compile_rule(raw: dict[str, Any]) -> tuple[Rule | None, str]:
    """Compile one served rule and RUN ITS EXAMPLES. Returns (rule, "") or
    (None, reason) — a rule that cannot compile or fails its own corpus in
    this engine is disabled, by id, rather than run wrong (design D9).

    Dialects drift silently: CPython `re` rejects a variable-width lookbehind
    at compile time, and a V8-only construct that DOES compile here can match
    something else entirely. The examples are the only thing that proves the
    rule means the same thing in this engine.

    ⚠️ And the examples test the WHOLE rule — patterns MINUS `reject_value` — so the
    filters are compiled and applied BEFORE they run. A reader that skipped them
    would fail examples it was never able to satisfy and disable itself; see the
    reject_value section above.
    """
    rid = str(raw.get("id") or "")
    if not rid:
        return None, "rule without an id"
    flags = _compile_flags(str(raw.get("flags") or ""))
    group = raw.get("group")
    group = int(group) if isinstance(group, int) and group > 0 else None
    patterns: list[tuple[str, re.Pattern[str]]] = []
    for i, p in enumerate(raw.get("patterns") or []):
        if not isinstance(p, dict):
            return None, f"pattern {i}: not an object"
        source = p.get("source")
        if not isinstance(source, str) or not source:
            return None, f"pattern {i}: empty source"
        try:
            rx = re.compile(source, flags)
        except re.error as exc:
            return None, f"pattern {p.get('id', i)!r} does not compile: {exc}"
        if group and rx.groups < group:
            return None, f"pattern {p.get('id', i)!r} has no group {group}"
        patterns.append((str(p.get("id") or f"p{i}"), rx))
    if not patterns:
        return None, "no patterns"
    # A filter this engine cannot evaluate is a rule it must not run — see the
    # reject_value section above for why "no filter" is the dangerous reading.
    rejects, reject_err = compile_rejects(raw.get("reject_value"), rid)
    if rejects is None:
        return None, reject_err
    rule = Rule(
        rid,
        str(raw.get("category") or ""),
        str(raw.get("severity") or ""),
        str(raw.get("tier") or "strong"),
        group,
        patterns,
        rejects,
    )
    examples = raw.get("examples") or {}
    for sample in examples.get("match") or []:
        if not isinstance(sample, str) or not rule.spans(sample):
            return None, f"example must match but did not: {sample!r}"
    for sample in examples.get("nomatch") or []:
        if isinstance(sample, str) and rule.spans(sample):
            return None, f"example must not match but did: {sample!r}"
    return rule, ""


class Ruleset:
    """A served ruleset, compiled. `rules` are the ENABLED ones in served
    order (order is content: it is the overlap tie-break); `disabled` is
    [(id, reason)] for the log and for an operator asking why a value
    reached the provider."""

    def __init__(self, data: dict[str, Any], tiers: set[str] | None = None) -> None:
        self.id: str = str(data.get("id") or "")
        self.generated_at: str = str(data.get("generated_at") or "")
        self.dialect: str = str(data.get("dialect") or "")
        self.family: str = str(data.get("family") or "")
        self.rules: list[Rule] = []
        self.disabled: list[tuple[str, str]] = []
        self.skipped_tiers: list[str] = []
        want = tiers if tiers is not None else {"strong", "heuristic"}
        if self.dialect and self.dialect != DIALECT:
            logger.warning("OGR ruleset %s speaks dialect %r, this plugin %r — "
                           "examples decide, rule by rule", self.id, self.dialect, DIALECT)
        for raw in data.get("rules") or []:
            if not isinstance(raw, dict):
                continue
            tier = str(raw.get("tier") or "strong")
            if tier not in want:
                self.skipped_tiers.append(str(raw.get("id") or "?"))
                continue
            rule, reason = compile_rule(raw)
            if rule is None:
                self.disabled.append((str(raw.get("id") or "?"), reason))
                logger.warning("OGR rule %s disabled: %s", raw.get("id"), reason)
                continue
            self.rules.append(rule)

    def __len__(self) -> int:
        return len(self.rules)


def _default_cache_path(runtime_url: str) -> str:
    digest = hashlib.sha256((runtime_url or "").encode("utf-8")).hexdigest()[:8]
    return os.path.join(os.path.expanduser("~"), ".openguardrails", f"rules-{digest}.json")


class RulesetStore:
    """Fetch, cache and hold the current Ruleset.

    - `GET {runtime}/v1/rules` with the org key; `If-None-Match: <cached id>`
      and a 304 keeps the cache (the id IS the ETag).
    - The cache file (`OGR_RULES_CACHE`, default
      `~/.openguardrails/rules-<sha256(runtime_url)[:8]>.json`) is written
      atomically at mode 0600. It holds RULES, never values — the customer's
      own machine already holds the runtime's obfuscated image; what the fetch
      hides the rules from is the public repo.
    - Thread-safe: the heartbeat refetches in the background while the hook
      path reads `current`.
    """

    def __init__(self, runtime_url: str, api_key: str, *, cache_path: str | None = None,
                 tiers: set[str] | None = None, timeout: float = 4.0,
                 urlopen: Callable[..., Any] | None = None) -> None:
        self.runtime_url = (runtime_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.cache_path = cache_path or _default_cache_path(self.runtime_url)
        self.tiers = tiers
        self.timeout = timeout
        self._urlopen = urlopen or urllib.request.urlopen
        self._lock = threading.Lock()
        self._current: Ruleset | None = None
        self._fetching = False

    @property
    def current(self) -> Ruleset | None:
        with self._lock:
            return self._current

    @property
    def ruleset_id(self) -> str:
        rs = self.current
        return rs.id if rs else ""

    # -- cache --------------------------------------------------------------
    def load_cache(self) -> bool:
        """Adopt the cached ruleset if there is one. Never raises."""
        try:
            with open(self.cache_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return False
        return self._adopt(data)

    def _write_cache(self, body: dict[str, Any]) -> None:
        directory = os.path.dirname(self.cache_path) or "."
        try:
            os.makedirs(directory, mode=0o700, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".rules-", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(body, fh)
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.cache_path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            logger.warning("OGR ruleset cache not written (%s): %s", self.cache_path, exc)

    def _adopt(self, body: Any) -> bool:
        data = body.get("ruleset") if isinstance(body, dict) else None
        if not isinstance(data, dict) or not data.get("id"):
            return False
        rs = Ruleset(data, self.tiers)
        with self._lock:
            self._current = rs
        logger.info("OGR ruleset %s: %d rules enabled, %d disabled%s", rs.id, len(rs.rules),
                    len(rs.disabled),
                    f" ({', '.join(i for i, _ in rs.disabled)})" if rs.disabled else "")
        return True

    # -- the feed -----------------------------------------------------------
    def fetch(self) -> bool:
        """`GET /v1/rules`. True when a NEW ruleset was adopted; False on 304,
        on any failure, or when unconfigured. Never raises."""
        if not (self.runtime_url and self.api_key):
            return False
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
        current_id = self.ruleset_id
        if current_id:
            headers["If-None-Match"] = f'"{current_id}"'
        req = urllib.request.Request(f"{self.runtime_url}/v1/rules", headers=headers,
                                     method="GET")
        try:
            with self._urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                return False
            logger.warning("OGR rules fetch failed: HTTP %s", exc.code)
            return False
        except Exception as exc:  # noqa: BLE001 — every failure is one outcome: no update
            logger.warning("OGR rules fetch failed: %s", exc)
            return False
        data = body.get("ruleset") if isinstance(body, dict) else None
        if not isinstance(data, dict):
            logger.warning("OGR rules fetch: no ruleset in the response")
            return False
        if data.get("id") == current_id:
            return False
        if not self._adopt(body):
            return False
        self._write_cache(body)
        return True

    def refresh_if(self, served_id: Any) -> None:
        """The heartbeat said which ruleset the runtime holds: if it is not the
        one we run, refetch — in the background, so the hook path never waits
        on the feed."""
        if not isinstance(served_id, str) or not served_id or served_id == self.ruleset_id:
            return
        with self._lock:
            if self._fetching:
                return
            self._fetching = True

        def run() -> None:
            try:
                self.fetch()
            finally:
                with self._lock:
                    self._fetching = False

        threading.Thread(target=run, name="ogr-rules-refetch", daemon=True).start()


# --------------------------------------------------------------------------- #
# the session map
# --------------------------------------------------------------------------- #
class SessionMap:
    """value <-> token for ONE session. In memory, never on disk. Bounded:
    past MAX_VALUES a new value is still masked — with the fixed
    ``OGRKPXXXXXXX``, which restores to nothing — because over the bound,
    refusing to mask is the wrong side to fail on (§4.5)."""

    def __init__(self, limit: int = MAX_VALUES) -> None:
        self.limit = limit
        self.by_value: dict[str, str] = {}
        self.by_token: dict[str, str] = {}
        self.counter = 0
        self._full_warned = False
        self._lock = threading.Lock()

    def token_for(self, value: str) -> tuple[str, bool]:
        """(token, minted) — minted is True only the first time a value is seen."""
        with self._lock:
            tok = self.by_value.get(value)
            if tok is not None:
                return tok, False
            if len(self.by_value) >= self.limit:
                if not self._full_warned:
                    self._full_warned = True
                    logger.warning("OGR session map full (%d values): new secrets are masked "
                                   "with the non-restorable %s", self.limit, FULL_TOKEN)
                return FULL_TOKEN, False
            self.counter += 1
            tok = "OGRK%s%07d" % (TOKEN_MINTER, self.counter)
            self.by_value[value] = tok
            self.by_token[tok] = value
            return tok, True

    def adopt(self, token: str, value: str) -> bool:
        """Bind a token minted ELSEWHERE — an older plugin's ``OGRK00000001`-style`, the
        gateway path — so this map restores it too. A value already bound keeps its
        token; a token already bound to another value is refused, never re-pointed."""
        if not token or not value:
            return False
        held = self.by_token.get(token)
        if held is not None:
            return held == value
        if value in self.by_value:
            return False
        self.by_value[value] = token
        self.by_token[token] = value
        return True

    def known_values(self) -> list[str]:
        """Longest first — a value that is a substring of another can then
        never corrupt it (`MaskString`'s rule)."""
        with self._lock:
            return sorted(self.by_value, key=len, reverse=True)

    def restore_keys(self) -> tuple[list[str], dict[str, str]]:
        with self._lock:
            keys = sorted(self.by_token, key=len, reverse=True)
            return keys, dict(self.by_token)

    def __len__(self) -> int:
        return len(self.by_value)


# --------------------------------------------------------------------------- #
# mask
# --------------------------------------------------------------------------- #
def _normalize(text: str) -> tuple[str, list[int] | None]:
    """The text with zero-width/control characters removed for MATCHING, plus
    the map clean-index -> original-index (None when nothing was removed)."""
    if not CONTROL_CHARS_RE.search(text):
        return text, None
    clean_chars: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(text):
        if CONTROL_CHARS_RE.match(ch):
            continue
        clean_chars.append(ch)
        idx.append(i)
    return "".join(clean_chars), idx


def _overlaps(start: int, end: int, taken: list[tuple[int, int]]) -> bool:
    return any(start < t_end and t_start < end for t_start, t_end in taken)


def mask(text: str, session: SessionMap, ruleset: Ruleset | None,
         extra_known: list[SessionMap] | None = None) -> tuple[str, list[dict[str, str]]]:
    """Mask `text`. Returns (masked, minted) where minted lists the tokens
    NEWLY issued for this text — `[{"token", "rule"}]`, rule =
    `<rule id>/<pattern id>` — never values.

    1. normalise for matching, keeping an index map so the splice removes
       the split characters with the value;
    2. every KNOWN value -> its token, longest value first;
    3. the rules, in served order; overlaps longest-wins, ties on array
       order; never inside an existing `${OGR_…}` token;
    4. splice highest-offset-first; tokens are minted in TEXT order.
    """
    if not isinstance(text, str) or not text:
        return text, []
    clean, idx = _normalize(text)
    if not clean:
        return text, []

    # Existing tokens are untouchable ground.
    taken: list[tuple[int, int]] = [m.span() for m in TOKEN_RE.finditer(clean)]
    # (start, end, token, rule) — token None ⇒ mint at splice time.
    accepted: list[tuple[int, int, str | None, str]] = []

    # Step 2 — known values, longest first, this session's then the others'
    # (the egress mask on a session-less fragment).
    maps = [session] + [m for m in (extra_known or []) if m is not session]
    for smap in maps:
        for value in smap.known_values():
            if not value:
                continue
            tok = smap.by_value.get(value)
            if tok is None:
                continue
            pos = 0
            while True:
                pos = clean.find(value, pos)
                if pos < 0:
                    break
                end = pos + len(value)
                if not _overlaps(pos, end, taken):
                    taken.append((pos, end))
                    accepted.append((pos, end, tok, ""))
                pos = end

    # Step 3 — the rules.
    if ruleset is not None and ruleset.rules:
        candidates: list[tuple[int, int, int, str]] = []
        order = 0
        for rule in ruleset.rules:
            for start, end, pid in rule.spans(clean):
                if _overlaps(start, end, taken):
                    continue
                candidates.append((start, end, order, f"{rule.id}/{pid}"))
                order += 1
        # Longest wins; equal length -> array order (the served order).
        candidates.sort(key=lambda c: (-(c[1] - c[0]), c[2]))
        rule_taken: list[tuple[int, int]] = []
        for start, end, _, label in candidates:
            if _overlaps(start, end, rule_taken):
                continue
            rule_taken.append((start, end))
            accepted.append((start, end, None, label))

    if not accepted:
        return text, []

    # Step 4 — mint in text order, splice in reverse.
    accepted.sort(key=lambda a: a[0])
    minted: list[dict[str, str]] = []
    pieces: list[tuple[int, int, str]] = []
    for start, end, tok, label in accepted:
        if tok is None:
            value = clean[start:end]
            tok, fresh = session.token_for(value)
            if fresh:
                minted.append({"token": tok, "rule": label})
        if idx is None:
            o_start, o_end = start, end
        else:
            o_start, o_end = idx[start], idx[end - 1] + 1
        pieces.append((o_start, o_end, tok))
    out = text
    for o_start, o_end, tok in sorted(pieces, key=lambda p: p[0], reverse=True):
        out = out[:o_start] + tok + out[o_end:]
    return out, minted


def _walk(value: Any, fn: Callable[[str], str], skip_keys: set[str] | None = None) -> Any:
    """Apply `fn` to every string leaf, rebuilding containers. Structure,
    keys, order and indexes are untouched — replace in place, never remove
    (the OGR 1.1 media rule applied to text)."""
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, dict):
        return {k: (v if (skip_keys and k in skip_keys) else _walk(v, fn))
                for k, v in value.items()}
    if isinstance(value, list):
        return [_walk(v, fn) for v in value]
    if isinstance(value, tuple):
        return tuple(_walk(v, fn) for v in value)
    return value


#: Top-level provider kwargs that carry TRANSPORT, not content — a credential
#: the deployment itself put on the request (`extra_headers: {Authorization}`)
#: must reach the provider intact or the call fails with nothing naming why.
_TRANSPORT_KEYS = {"extra_headers", "default_headers", "api_key", "extra_query"}


def mask_request(request: dict[str, Any], session: SessionMap,
                 ruleset: Ruleset | None) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Mask every string leaf of the provider request — `messages[*].content`
    as a string or as content-block lists, `system`, tool results, tool
    definitions, Responses `input` — by walking the whole thing. Returns a new
    dict; the caller's is untouched."""
    minted: list[dict[str, str]] = []

    def fn(s: str) -> str:
        out, new = mask(s, session, ruleset)
        minted.extend(new)
        return out

    return _walk(request, fn, _TRANSPORT_KEYS), minted


def mask_value(value: Any, session: SessionMap, ruleset: Ruleset | None,
               extra_known: list[SessionMap] | None = None) -> tuple[Any, list[dict[str, str]]]:
    """`mask` over an arbitrary JSON-shaped value (the OGR event payload)."""
    minted: list[dict[str, str]] = []

    def fn(s: str) -> str:
        out, new = mask(s, session, ruleset, extra_known)
        minted.extend(new)
        return out

    return _walk(value, fn), minted


# --------------------------------------------------------------------------- #
# restore
# --------------------------------------------------------------------------- #
def _match_key(text: str, i: int, key: str) -> int:
    """The RAW length of `key` matched at `text[i:]` with markdown escapes
    absorbed, or 0. A port of higress `matchKey` (partial = 0 here: there is
    no stream to hold a tail for)."""
    p = i
    n = len(text)
    for kc in key:
        if p >= n:
            return 0
        if text[p] == "\\" and kc != "\\":
            if p + 1 >= n:
                return 0
            if text[p + 1] in _ESCAPABLE:
                p += 1
        if text[p] != kc:
            return 0
        p += 1
    return p - i


def restore(text: str, session: SessionMap) -> tuple[str, list[str]]:
    """Whole-token exact match against this session's map, longest key
    first, with the markdown-escape tolerance (`${OGR\\_SECRET\\_1}` restores).
    NEVER fuzzy, never prefix — a restorer that guesses is an exfiltration
    oracle. Returns (restored, unresolved): every `${OGR_…}`-shaped token left
    in the text with no map entry, unescaped, in order of appearance."""
    if not isinstance(text, str) or not text:
        return text, []
    keys, mapping = session.restore_keys()
    starts = {k[0] for k in keys}
    starts.add("\\")
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in starts:
            for k in keys:
                raw = _match_key(text, i, k)
                if raw:
                    out.append(mapping[k])
                    i += raw
                    break
            else:
                out.append(ch)
                i += 1
            continue
        out.append(ch)
        i += 1
    restored = "".join(out)
    unresolved: list[str] = []
    for m in _ESCAPED_TOKEN_RE.finditer(restored):
        tok = m.group(0).replace("\\", "")
        if tok not in unresolved:
            unresolved.append(tok)
    return restored, unresolved


def restore_args(args: Any, session: SessionMap) -> tuple[Any, list[str]]:
    """`restore` over every string leaf of a tool's arguments (dicts and
    lists, recursively). Returns a new structure."""
    unresolved: list[str] = []

    def fn(s: str) -> str:
        out, missing = restore(s, session)
        for tok in missing:
            if tok not in unresolved:
                unresolved.append(tok)
        return out

    return _walk(args, fn), unresolved


def unresolved_notice(tokens: list[str]) -> str:
    return " ".join(UNRESOLVED_NOTICE % t for t in tokens)


# --------------------------------------------------------------------------- #
# the process-wide redactor: config + store + the session maps
# --------------------------------------------------------------------------- #
def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _truthy(value: str, default: bool) -> bool:
    if value == "":
        return default
    return value.lower() in ("1", "true", "yes", "on")


class Redactor:
    """Everything the bridge and the wire need, in one object:

    OGR_LOCAL_REDACTION        true (default) | false — off ⇒ no middleware,
                               no `redaction` field, everything as 1.x
    OGR_RULES_CACHE            the cache file path
    OGR_RESTORE_OUTPUT         false (default) — restore tokens in the FINAL
                               answer (a local-only harness; hermes gateways
                               deliver to channels, each one an egress)
    OGR_LOCAL_REDACTION_TIERS  strong,heuristic (default) — which tiers to mask
    """

    def __init__(self, runtime_url: str, api_key: str, *, enabled: bool | None = None,
                 cache_path: str | None = None, restore_output: bool | None = None,
                 tiers: str | None = None, timeout: float = 4.0) -> None:
        self.enabled = enabled if enabled is not None \
            else _truthy(_env("OGR_LOCAL_REDACTION"), True)
        self.restore_output = restore_output if restore_output is not None \
            else _truthy(_env("OGR_RESTORE_OUTPUT"), False)
        raw_tiers = tiers if tiers is not None else (_env("OGR_LOCAL_REDACTION_TIERS")
                                                     or "strong,heuristic")
        tier_set = {t.strip() for t in raw_tiers.split(",") if t.strip()} or {"strong", "heuristic"}
        self.store = RulesetStore(runtime_url, api_key,
                                  cache_path=cache_path or _env("OGR_RULES_CACHE") or None,
                                  tiers=tier_set, timeout=timeout)
        self._sessions: dict[str, SessionMap] = {}
        self._lock = threading.Lock()
        self._warned_no_ruleset = 0

    # -- ruleset ------------------------------------------------------------
    def start(self) -> None:
        """Cache first (mask immediately), then the feed in the background."""
        if not self.enabled:
            return
        self.store.load_cache()
        threading.Thread(target=self.store.fetch, name="ogr-rules-fetch", daemon=True).start()

    @property
    def ruleset(self) -> Ruleset | None:
        return self.store.current

    @property
    def ruleset_id(self) -> str:
        return self.store.ruleset_id

    def warn_if_unprotected(self) -> bool:
        """No ruleset at all (no cache, fetch failed): under fail-open the
        request proceeds UNMASKED, and this says so on every request until one
        arrives — a silent fail-open is the one the operator never learns of."""
        if not self.enabled or self.ruleset is not None:
            return False
        self._warned_no_ruleset += 1
        logger.warning("OGR local redaction has NO ruleset (fetch failed, no cache) — "
                       "request %d proceeds unmasked", self._warned_no_ruleset)
        return True

    # -- sessions -----------------------------------------------------------
    def session(self, session_id: str) -> SessionMap:
        key = session_id or ""
        with self._lock:
            smap = self._sessions.get(key)
            if smap is None:
                smap = SessionMap()
                self._sessions[key] = smap
            return smap

    def all_sessions(self) -> list[SessionMap]:
        with self._lock:
            return list(self._sessions.values())

    # -- the operations -----------------------------------------------------
    def mask_request(self, request: dict[str, Any], session_id: str) -> tuple[dict[str, Any], list[dict[str, str]]]:
        return mask_request(request, self.session(session_id), self.ruleset)

    def mask_egress(self, value: Any, session_id: str) -> tuple[Any, list[dict[str, str]]]:
        """D6 — the OGR client is an egress. KNOWN VALUES ONLY (design §4.2):
        every value this session already tokenised is tokenised here too, so
        what leaves for the runtime is what left for the provider. The RULES
        are deliberately NOT run on this pass — the runtime runs the identical
        set on what it receives, and a regex-tier hit there is the `miss` the
        feedback loop exists to observe; masking it here would hide every such
        miss behind the very mechanism it diagnoses. A session-less fragment
        (the exec chokepoint) gets every session's known values, since it
        cannot say which one it belongs to."""
        smap = self.session(session_id)
        extra = self.all_sessions() if not session_id else None
        return mask_value(value, smap, None, extra)

    def mask_text(self, text: str, session_id: str) -> tuple[str, list[dict[str, str]]]:
        return mask(text, self.session(session_id), self.ruleset)

    def restore_args(self, args: Any, session_id: str) -> tuple[Any, list[str]]:
        return restore_args(args, self.session(session_id))

    def restore_text(self, text: str, session_id: str) -> tuple[str, list[str]]:
        return restore(text, self.session(session_id))

    def redaction_field(self, masked: list[dict[str, str]]) -> dict[str, Any]:
        """The optional GuardEvent `redaction` field (§4.4)."""
        return {"ruleset": self.ruleset_id, "masked": list(masked)[:MAX_VALUES]}
