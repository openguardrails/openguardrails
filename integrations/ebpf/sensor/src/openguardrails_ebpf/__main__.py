"""CLI — the OGR eBPF PEP over the kernel sensor stream.

    # tail the sensor's NDJSON (from the loader, a file, or stdin) and judge
    ogr-ebpf run --loader ./bpf/ogr-sensor -- claude -p "review this repo"
    ogr-ebpf run --records .ogr/sensor.jsonl --follow
    ./bpf/ogr-sensor -- npm test | ogr-ebpf run --records -

By default the PEP observes and audits (no enforcement). `--enforce` kills a
process the runtime judges `block`; `--fail-closed` also kills on
require_approval or when the runtime is unreachable.

The embedded reference runtime is used unless `--runtime-url` points at a
remote OGR PDP. Policy defaults to the bundled `openguardrails:base`.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import Iterable

from openguardrails import load_policy, resolve_policy

from .pep import PEP, PEPConfig, EmbeddedPDP, RemotePDP


def _load_policy(path: str | None) -> dict:
    if path is None:
        return resolve_policy({"$extends": "openguardrails:base"})
    return load_policy(path)


def _follow(path: str, poll: float = 0.2) -> Iterable[str]:
    with open(path, encoding="utf-8") as f:
        f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if line:
                yield line
            else:
                import time
                time.sleep(poll)


def _lines_from_loader(loader_argv: list[str]) -> Iterable[str]:
    proc = subprocess.Popen(loader_argv, stdout=subprocess.PIPE, text=True, bufsize=1)
    try:
        assert proc.stdout is not None
        yield from proc.stdout
    finally:
        if proc.poll() is None:
            proc.terminate()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ogr-ebpf", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    r = sub.add_parser("run", help="judge the sensor stream against an OGR runtime")
    src = r.add_argument_group("event source (one of)")
    src.add_argument("--records", help="sensor NDJSON file, or '-' for stdin")
    src.add_argument("--loader", help="path to the ogr-sensor loader binary")
    r.add_argument("--follow", action="store_true", help="tail --records instead of reading once")
    r.add_argument("--policy", help="OGR policy JSON (default: bundled openguardrails:base)")
    r.add_argument("--runtime-url", help="remote OGR PDP base URL")
    r.add_argument("--api-key", help="bearer token for --runtime-url")
    r.add_argument("--agent-id", default="ogr-ebpf-agent")
    r.add_argument("--agent-type", default="ogr-ebpf.sandbox")
    r.add_argument("--principal")
    r.add_argument("--session")
    r.add_argument("--guardcontext", help="file the harness writes `ogr-guardcontext` to")
    r.add_argument("--guardcontext-ttl", type=float, default=30.0)
    r.add_argument("--enforce", action="store_true", help="kill a pid judged 'block'")
    r.add_argument("--fail-closed", action="store_true",
                   help="also kill on require_approval or when the runtime is unreachable")
    r.set_defaults(func=_cmd_run)

    # everything after a literal `--` is the command to launch under --loader;
    # split it out before argparse so its own flags are not parsed as ours.
    source_argv = sys.argv[1:] if argv is None else argv
    cmd: list[str] = []
    if "--" in source_argv:
        idx = source_argv.index("--")
        cmd = source_argv[idx + 1:]
        source_argv = source_argv[:idx]

    args = parser.parse_args(source_argv)
    args.cmd = cmd
    return args.func(args)


def _cmd_run(args: argparse.Namespace) -> int:
    cmd: list[str] = args.cmd

    if args.runtime_url:
        pdp = RemotePDP(args.runtime_url, args.api_key or "")
    else:
        pdp = EmbeddedPDP(_load_policy(args.policy))

    pep = PEP(pdp, PEPConfig(
        agent_id=args.agent_id, agent_type=args.agent_type, principal=args.principal,
        session_id=args.session, guardcontext_path=args.guardcontext,
        guardcontext_ttl=args.guardcontext_ttl, enforce=args.enforce,
        fail_closed=args.fail_closed, protect_pids=frozenset({os.getpid()})))

    if args.loader:
        loader_argv = [args.loader] + (["--"] + cmd if cmd else [])
        lines: Iterable[str] = _lines_from_loader(loader_argv)
    elif args.records == "-":
        lines = sys.stdin
    elif args.records and args.follow:
        lines = _follow(args.records)
    elif args.records:
        with open(args.records, encoding="utf-8") as f:
            pep.run(f, sys.stdout)
        return 0
    else:
        print("ogr-ebpf run: need --records or --loader", file=sys.stderr)
        return 2

    pep.run(lines, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
