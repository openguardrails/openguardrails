# eBPF integrations

eBPF-based OGR integrations observe (and, with an LSM sensor, enforce) process,
filesystem, and network activity at the kernel boundary — below the agent
harness and any tool-layer guard, so an agent cannot bypass them by shelling
out, linking an SDK, or spawning a subprocess. They map kernel events to OGR
`GuardEvent`s at the `sandbox` observation point — the altitude the spec
assigns to real `execve` / network / filesystem behavior — and preserve
`guard_id` correlation with the agent, gateway, and sandbox layers. An eBPF
adapter never invents a separate wire contract.

| Integration | Directory | What it is |
|---|---|---|
| OGR reference sensor | [`sensor/`](sensor/) | A native OGR eBPF implementation: a small CO-RE kernel program that observes exec/file/connect for one process tree, and a userspace PEP that maps each event to a `GuardEvent`, judges it against any OGR runtime, and enforces by containment. |

The reference sensor is deliberately built in two halves with a stable seam
between them (the `ogr.ebpf.sensor/1` line format), so a security vendor can
adopt it three ways: run it whole; keep the kernel sensor and point the PEP at
their own runtime/detectors; or keep the userspace PEP and emit the same
records from their own kernel technology. See [`sensor/README.md`](sensor/README.md).
