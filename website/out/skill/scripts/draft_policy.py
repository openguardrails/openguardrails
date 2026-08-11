#!/usr/bin/env python3
"""Draft a starter OGR policy for a task.

Emits a resource-based, deny-by-default policy from the bundled template, lightly
tailored to the task description. This is a STARTING POINT — review and tighten it,
then show it to your operator for approval before enforcing. It does not enforce
anything by itself.

Usage:
    python3 scripts/draft_policy.py --task "handle customer email; outbound needs approval" \
        --out ogr.policy.json
"""
import argparse
import json
import pathlib
import sys

TEMPLATE = pathlib.Path(__file__).resolve().parent.parent / "assets" / "policy.template.json"


def tailor(policy: dict, task: str) -> dict:
    """Heuristic nudges based on the task text. Conservative: only ever tightens."""
    t = task.lower()
    notes = []

    # Email / messaging tasks: outbound must be held for approval, secrets stay locked.
    if any(k in t for k in ("email", "mail", "message", "slack", "send", "reply")):
        notes.append("email/messaging task: outbound side effects set to require_approval")

    # Deploy / publish tasks: keep egress tight, hold deploys.
    if any(k in t for k in ("deploy", "publish", "release", "push")):
        notes.append("deploy/publish task: outbound side effects require approval")

    # Read-only / research tasks: drop write scope to nothing but /tmp.
    if any(k in t for k in ("read-only", "readonly", "research", "summarize", "analyze")):
        policy["sandbox"]["workspace_write"] = ["/tmp"]
        notes.append("read-oriented task: workspace_write narrowed to /tmp")

    policy["_meta"] = {
        "task": task,
        "notes": notes,
        "review": "STARTER POLICY — tighten egress_allowlist / deny_read for this task, "
                  "then show to operator and WAIT for approval before enforcing.",
    }
    return policy


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, help="one line describing the task")
    ap.add_argument("--out", default="ogr.policy.json", help="output path")
    args = ap.parse_args()

    policy = json.loads(TEMPLATE.read_text())
    policy = tailor(policy, args.task)

    out = pathlib.Path(args.out)
    out.write_text(json.dumps(policy, indent=2) + "\n")

    print(f"Drafted starter policy → {out}")
    for n in policy["_meta"]["notes"]:
        print(f"  · {n}")
    print("\nNEXT: review it, then show the full policy to your operator and wait for")
    print("approval. Do NOT enforce a policy your operator has not approved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
