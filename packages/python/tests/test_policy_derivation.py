"""Tests for load-by-derivation (openguardrails.policy).

Self-contained (tmp fixtures) for the merge/extends/circular semantics, plus a
real check against the canonical base.policy.json + gateway overlay when the
sibling spec repo is reachable.
"""
import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve()
CORE_SRC = HERE.parents[1] / "src"
sys.path.insert(0, str(CORE_SRC))

from openguardrails import merge_policy, resolve_policy, load_policy  # noqa: E402

checks = []


def expect(name, cond):
    checks.append((name, bool(cond)))


# 1) merge: objects merge, scalars/arrays replace
base = {"composition": {"default": {"strategy": "deny-wins"}},
        "config_rules": {"egress_allowlist": ["a", "b"], "secret_env_markers": ["X"]}}
overlay = {"config_rules": {"egress_allowlist": ["c"]}}
m = merge_policy(base, overlay)
expect("object merges (secret_env_markers kept)", m["config_rules"]["secret_env_markers"] == ["X"])
expect("array replaces (egress_allowlist=[c])", m["config_rules"]["egress_allowlist"] == ["c"])
expect("untouched branch kept (composition)", m["composition"]["default"]["strategy"] == "deny-wins")
expect("base not mutated", base["config_rules"]["egress_allowlist"] == ["a", "b"])

# 2) $extends resolves from disk + deep-merges
with tempfile.TemporaryDirectory() as d:
    dp = pathlib.Path(d)
    (dp / "base.json").write_text(json.dumps({
        "composition": {"security.*": {"strategy": "deny-wins"}},
        "config_rules": {"egress_allowlist": ["api.github.com"], "command_rules": [{"id": "x"}]},
    }))
    (dp / "overlay.json").write_text(json.dumps({
        "$extends": "base.json",
        "$source": "derived",
        "config_rules": {"egress_allowlist": ["pypi.org"]},
    }))
    eff = load_policy(dp / "overlay.json")
    expect("$extends inherits base command_rules", eff["config_rules"]["command_rules"] == [{"id": "x"}])
    expect("$extends overlay overrides egress", eff["config_rules"]["egress_allowlist"] == ["pypi.org"])
    expect("$extends consumed (not in effective)", "$extends" not in eff)
    expect("non-extends meta passes through", eff.get("$source") == "derived")

    # 3) circular $extends raises
    (dp / "a.json").write_text(json.dumps({"$extends": "b.json"}))
    (dp / "b.json").write_text(json.dumps({"$extends": "a.json"}))
    try:
        load_policy(dp / "a.json")
        expect("circular $extends raises", False)
    except ValueError:
        expect("circular $extends raises", True)

# 4a) bundled-base scheme: `$extends: "openguardrails:base"` ships with the core
eff = resolve_policy({"$extends": "openguardrails:base"})
expect("openguardrails:base resolves (has sandbox)", "sandbox" in eff)
expect("openguardrails:base resolves (has command_rules)", "command_rules" in eff.get("config_rules", {}))

# 4b) sync-guard: the core-bundled base matches the authored spec source
ROOT = HERE.parents[3]  # workspace root
spec_base = ROOT / "openguardrails" / "policy" / "base.policy.json"
if spec_base.exists():
    import openguardrails.policy as _p

    def _strip_comments(x):
        """Drop comment meta (`$comment`, `//`, `_comment`) recursively, so the
        guard compares functional content, not documentation."""
        if isinstance(x, dict):
            return {k: _strip_comments(v) for k, v in x.items()
                    if k not in ("$comment", "//", "_comment")}
        if isinstance(x, list):
            return [_strip_comments(v) for v in x]
        return x

    core_base = json.loads(_p._BUNDLED["openguardrails:base"].read_text())
    src_base = json.loads(spec_base.read_text())
    keys = ["composition", "config_rules", "content_rules", "sandbox"]
    expect("core-bundled base in sync with spec source",
           all(_strip_comments(core_base.get(k)) == _strip_comments(src_base.get(k)) for k in keys))
else:
    print("(skipped base sync-guard — spec repo not a sibling)")

# 4c) real gateway overlay (if the spec repo is a sibling)
overlay_path = ROOT / "openguardrails" / "policy" / "overlays" / "gateway.overlay.json"
if overlay_path.exists():
    eff = load_policy(overlay_path)
    expect("real overlay inherits base config_rules", "command_rules" in eff.get("config_rules", {}))
    expect("real overlay inherits base sandbox block", "resource_limits" in eff.get("sandbox", {}))
    expect("real overlay overrides injection_from_unverified=block",
           eff["content_rules"]["injection_from_unverified"] == "block")
    expect("real overlay keeps base redact_secrets", eff["content_rules"]["redact_secrets"] is True)
else:
    print("(skipped real-overlay check — spec repo not a sibling)")


def main() -> int:
    ok = all(c for _, c in checks)
    for name, c in checks:
        print(f"{'✓' if c else '✗'} {name}")
    print("\nall passed" if ok else "\nFAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
