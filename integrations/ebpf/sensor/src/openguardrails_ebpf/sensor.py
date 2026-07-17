"""Parse the OGR eBPF sensor wire format (`ogr.ebpf.sensor/1`).

The kernel loader (`bpf/loader.c`) emits one NDJSON line per observed action.
This module is the thin, dependency-free reader for that stable boundary — the
same records a *different* kernel technology could emit to reuse the rest of
this package. One normalized `SensorRecord` per line; unrecognized or malformed
lines return None so a caller can tail a noisy stream safely.

    {"schema":"ogr.ebpf.sensor/1","kind":"exec","ts_ns":…,"pid":…,"ppid":…,
     "root_pid":…,"uid":…,"comm":"bash","path":"/bin/bash","argv":["bash","-c","…"]}
    {"…","kind":"file","access":"read","path":"/home/u/.ssh/id_rsa"}
    {"…","kind":"network","ip":"1.2.3.4","port":443,"direction":"egress"}
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

SCHEMA = "ogr.ebpf.sensor/1"
KINDS = ("exec", "file", "network")


@dataclass
class SensorRecord:
    kind: str                       # exec | file | network
    pid: int
    ppid: int
    root_pid: int                   # tracked-tree root — the session key
    comm: str
    uid: int | None = None
    ts_ns: int | None = None
    path: str = ""                  # exec: program path; file: opened path
    argv: list[str] = field(default_factory=list)   # exec
    access: str = ""                # file: read | write
    ip: str = ""                    # network
    port: int | None = None         # network
    direction: str = "egress"       # network

    @property
    def command(self) -> str:
        """Best-effort command string for exec records (argv joined)."""
        return " ".join(self.argv) if self.argv else self.path


def normalize_record(raw: Any) -> SensorRecord | None:
    if not isinstance(raw, dict):
        return None
    if raw.get("schema") not in (SCHEMA, None):  # tolerate schema-less records
        return None
    kind = raw.get("kind")
    if kind not in KINDS:
        return None
    try:
        rec = SensorRecord(
            kind=kind,
            pid=int(raw["pid"]),
            ppid=int(raw.get("ppid", 0)),
            root_pid=int(raw.get("root_pid", raw["pid"])),
            comm=str(raw.get("comm", "")),
            uid=_maybe_int(raw.get("uid")),
            ts_ns=_maybe_int(raw.get("ts_ns")),
        )
    except (KeyError, TypeError, ValueError):
        return None
    if kind == "exec":
        rec.path = str(raw.get("path", ""))
        argv = raw.get("argv") or []
        rec.argv = [str(a) for a in argv] if isinstance(argv, list) else []
    elif kind == "file":
        rec.path = str(raw.get("path", ""))
        rec.access = "write" if raw.get("access") == "write" else "read"
    else:  # network
        rec.ip = str(raw.get("ip", ""))
        rec.port = _maybe_int(raw.get("port"))
        rec.direction = str(raw.get("direction", "egress"))
    return rec


def parse_line(line: str) -> SensorRecord | None:
    line = line.strip()
    if not line:
        return None
    try:
        raw = json.loads(line)
    except ValueError:
        return None
    return normalize_record(raw)


def _maybe_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
