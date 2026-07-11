"""Policy derivation — load-by-derivation for the PAP.

"One policy you own" only holds if there is a single authoritative source and the
per-altitude artifacts are *derived* from it, not independently maintained copies.
This module is the reference mechanism: a policy may declare

    { "$extends": "<relative-path-or-ref>", ...overlay... }

and the loader resolves the base and deep-merges the overlay on top. So a binding
ships a tiny overlay (its diff) instead of a full standalone policy, and a change
to the base propagates everywhere without editing N files.

Merge semantics:
  - objects merge recursively (overlay keys win),
  - scalars and arrays REPLACE (arrays are not concatenated — predictable),
  - `$extends` is consumed; other `$`-meta keys (e.g. `$source`) are passed
    through and ignored by the runtime.
"""
from __future__ import annotations

import json
from pathlib import Path

EXTENDS = "$extends"

# Bases the core package ships, so a binding can resolve them through the
# dependency it already has — no per-repo copy of the base. `$extends:
# "openguardrails:base"` is the canonical PAP source bundled with the runtime.
_BUNDLED = {"openguardrails:base": Path(__file__).resolve().parent / "base.policy.json"}


def _resolve_ref(ref: str, base_dir: str | Path | None) -> Path:
    if ref in _BUNDLED:
        return _BUNDLED[ref]
    return (Path(base_dir or ".") / ref).resolve()


def merge_policy(base: dict, overlay: dict) -> dict:
    """Deep-merge `overlay` onto `base`. Objects merge; scalars/arrays replace."""
    out = dict(base)
    for k, v in overlay.items():
        if k == EXTENDS:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge_policy(out[k], v)
        else:
            out[k] = v
    return out


def resolve_policy(doc: dict, *, base_dir: str | Path | None = None,
                   _seen: set[str] | None = None) -> dict:
    """Return the effective policy: if `doc` has `$extends`, resolve the base
    (recursively) and merge `doc` on top. `base_dir` is where a relative
    `$extends` is resolved from (the document's own directory)."""
    ref = doc.get(EXTENDS)
    if not ref:
        return {k: v for k, v in doc.items() if k != EXTENDS}
    seen = _seen or set()
    base_path = _resolve_ref(ref, base_dir)
    key = str(base_path)
    if key in seen:
        raise ValueError(f"circular $extends through {base_path}")
    seen.add(key)
    base_doc = json.loads(base_path.read_text())
    base = resolve_policy(base_doc, base_dir=base_path.parent, _seen=seen)
    return merge_policy(base, doc)


def load_policy(path: str | Path, *, resolve: bool = True) -> dict:
    """Read a policy file and (by default) resolve its `$extends` chain."""
    p = Path(path)
    doc = json.loads(p.read_text())
    return resolve_policy(doc, base_dir=p.parent) if resolve else doc
