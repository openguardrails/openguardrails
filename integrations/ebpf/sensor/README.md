# OGR eBPF sensor — a native OGR implementation at the kernel altitude

A reference implementation of the OpenGuardrails protocol for eBPF. A small
CO-RE kernel program observes the three sandbox-altitude actions the OGR spec
assigns to real kernel behavior — **exec, file open, network connect** — for
one agent process tree, and a userspace **PEP** maps each to an OGR
`GuardEvent` (`observation_point: "sandbox"`), asks an OGR **runtime** for a
`Verdict`, and enforces it. No dependency on any particular agent framework or
vendor: point it at any process tree and any OGR runtime.

This is the "verify side effects" altitude of the OGR model — the layer that
sees what actually ran, below the harness and any tool-layer guard, so an agent
cannot bypass it by shelling out, linking an SDK, or spawning a subprocess.

```
  ┌ kernel ─────────────────────────────┐        ┌ userspace ────────────────────────┐
  │ ogr_sensor.bpf.c   (tracepoints)     │        │ openguardrails_ebpf (this package)  │
  │  fork/exit → track one process tree  │        │                                     │
  │  exec / open / connect → ring buffer │        │  sensor.py  parse ogr.ebpf.sensor/1 │
  └───────────────┬──────────────────────┘        │  events.py  → GuardEvent (sandbox)  │
                  │ ring buffer                     │  pep.py     → OGR runtime → Verdict │
  ┌───────────────▼──────────────────────┐  NDJSON │             → enforce (kill/contain)│
  │ loader.c  → ogr.ebpf.sensor/1 lines   │ ───────▶│  detector.py  file-path judgments   │
  └──────────────────────────────────────┘  stdout └─────────────────────────────────────┘
```

## Three ways to adopt it

The two halves meet at one stable seam — the `ogr.ebpf.sensor/1` NDJSON line
format (see [`bpf/README.md`](bpf/README.md) and `sensor.py`). So a developer
or security vendor can:

1. **Run it whole** — kernel sensor + PEP + the bundled OGR base policy.
2. **Keep the kernel sensor, swap the runtime** — point the PEP at your own OGR
   PDP (`--runtime-url`) and your own detectors.
3. **Keep the PEP, swap the kernel** — emit the same `ogr.ebpf.sensor/1`
   records from your own kernel technology (an LSM sensor, Tetragon, a tracer)
   and reuse the entire GuardEvent-mapping / decision / enforcement path.

## Quickstart

```bash
pip install -e packages/python -e integrations/ebpf/sensor

# build the kernel sensor (needs clang, bpftool, libbpf-dev; Linux 5.8+ / BTF)
make -C integrations/ebpf/sensor/bpf

# observe + judge a command's whole process tree (no enforcement yet)
sudo integrations/ebpf/sensor/bpf/ogr-sensor -- bash -c 'cat ~/.ssh/id_rsa' \
  | ogr-ebpf run --records -

# enforce: kill any process the runtime judges `block`
sudo integrations/ebpf/sensor/bpf/ogr-sensor -- claude -p "…" \
  | ogr-ebpf run --records - --enforce
```

The PEP writes one audit record per event to stdout
(`{"event": <GuardEvent>, "verdict": <Verdict>, "action": …}`). You can also
tail a file the loader writes (`--records file --follow`) or let the PEP launch
the loader for you (`ogr-ebpf run --loader ./bpf/ogr-sensor -- <cmd>`).

## Event mapping

Kernel ops map 1:1 to the spec's sandbox kinds
([guard-event.md](../../../specification/guard-event.md)):

| Sensor `kind` | OGR `kind` | payload |
|---|---|---|
| `exec` | `exec` | `{argv, comm, path, process}` |
| `file` | `file` | `{op: read\|write, path, process}` |
| `network` | `network` | `{host, port, direction: egress, process}` |

Every event is `observation_point: "sandbox"` and carries a `sensor` block
(`engine`, `root_pid`) plus the acting `process` (pid/ppid/comm/uid).

## Decision and enforcement

The PEP submits each event to a PDP — the embedded reference `Runtime` (default)
or a remote OGR endpoint (`--runtime-url`). Two detectors compose behind the
embedded runtime:

- the core `ConfigRulesDetector` — exec command regexes + network egress
  allow-list (`security.malicious_command`, `security.ssrf`);
- this package's `SandboxPathDetector` — file reads/writes against
  `sandbox.deny_read` / `sandbox.deny_write` / `config_rules.secret_read_markers`
  (`security.secret_leak`), because file events only exist at this altitude.

Enforcement is **post-hoc containment**, not pre-commit blocking: tracepoints
fire after the syscall, so the sensor cannot deny the operation in-kernel.
Instead the PEP acts on the verdict:

| Verdict | Default | `--enforce` | `--fail-closed` |
|---|---|---|---|
| allow / redact / modify | observe | observe | observe |
| block | observe (recorded) | **kill the pid** | kill |
| require_approval | recorded | recorded | kill |
| runtime unreachable | recorded (degraded) | recorded | kill |

`--enforce` kills a process the runtime judged `block`; `--fail-closed` extends
that to require_approval and to a degraded (runtime-down) state. Pre-commit
denial is a BPF-LSM sensor away and would slot in behind the same PEP — see
[`bpf/README.md`](bpf/README.md). This is why altitudes correlate: the same
action denied at the gateway/agent altitude never reaches the kernel; the eBPF
sensor is the backstop for whatever bypassed those layers.

## Correlation (`guard_id`)

Per [guard-context propagation](../../../specification/provenance-and-context.md),
a sandbox that receives an `ogr-guardcontext` must stamp the inherited
`guard_id` on the events it emits. The kernel cannot carry the header, so an
agent-hook adapter writes it to a file before the tool runs and the PEP reads
it (`--guardcontext .ogr/guardcontext`, format
`02|<guard_id>|<session_id>|<flags>`), stamping events that fall within
`--guardcontext-ttl` seconds. Without a fresh context the sensor is the first
observer and mints its own `guard_id`, with `session_id` derived from the tree
root so one agent run still correlates. Once any observation of a logical
action is blocked, later observations under the same `guard_id` stay tightened
(the runtime's correlation rule).

## Degraded mode

If the PDP is unreachable the event is never dropped
([degraded-mode](../../../specification/degraded-mode.md)): it is recorded with
a local `degraded` verdict and **no process is killed** unless `--fail-closed`
is set — degrade safe, do not fail silently and do not kill on a transient
runtime outage.

## Limitations

- **Event volume.** The sensor reports *every* successful open in the tree,
  including shared-library and locale loads (`libc.so`, `ld.so.cache`, …), so a
  single `cat` produces a handful of file events. That is correct for a
  faithful sandbox-altitude sensor — deciding what matters is the runtime's
  job — but a high-throughput deployment will want the runtime/detector to
  ignore benign reads, or a future in-kernel path prefilter compiled from the
  policy's watched paths.
- Observation only in-kernel; enforcement is userspace kill (see the LSM note).
- Network identity is IPv4 + port from the `connect` sockaddr; hostnames and
  IPv6 are not resolved in-kernel (a hostname egress allow-list is judged at
  the runtime, as for the gateway integrations).
- exec argv is read from the new process image's arg area, length-clamped to
  256 bytes — long command lines are truncated (the head is kept).
- guard-context stamping is a freshness window, not a cryptographic link.

## Tests

```bash
python -m pytest integrations/ebpf/sensor/tests
```

Pure Python against recorded `ogr.ebpf.sensor/1` fixtures — no kernel, no root,
no eBPF toolchain needed. The kernel build is checked separately (`make -C
integrations/ebpf/sensor/bpf`, exercised in CI). Running the full stack needs
Linux 5.8+ with BTF and root (or `CAP_BPF` + `CAP_SYS_ADMIN`).
