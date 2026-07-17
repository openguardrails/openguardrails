"""OpenGuardrails eBPF sensor — a native OGR reference implementation.

A kernel eBPF program observes the three sandbox-altitude actions the OGR spec
assigns to real kernel behavior (exec, file open, network connect) for one
agent process tree, and a userspace PEP maps each to an OGR `GuardEvent`
(`observation_point: "sandbox"`), asks an OGR runtime for a `Verdict`, and
enforces it. Developers and security vendors can:

- run it as-is to guard any process tree with any OGR runtime;
- keep the userspace half and swap the kernel sensor for their own technology,
  as long as it emits the `ogr.ebpf.sensor/1` records (see `sensor.py`);
- keep the sensor and point the PEP at their own runtime / detectors.

Kernel program + loader live under `bpf/`; this package is the userspace half.
"""
from .sensor import SCHEMA, SensorRecord, normalize_record, parse_line
from .events import GuardContext, new_id, parse_guardcontext, to_guard_event
from .detector import SandboxPathDetector
from .pep import PEP, PEPConfig, Decision, EmbeddedPDP, RemotePDP

__all__ = [
    "SCHEMA", "SensorRecord", "normalize_record", "parse_line",
    "GuardContext", "new_id", "parse_guardcontext", "to_guard_event",
    "SandboxPathDetector",
    "PEP", "PEPConfig", "Decision", "EmbeddedPDP", "RemotePDP",
]
