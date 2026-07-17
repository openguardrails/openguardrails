# OGR eBPF sensor — kernel program

A minimal CO-RE eBPF sensor for the OGR `sandbox` altitude. It watches one
agent process tree and emits one `ogr_event` per exec / file open / network
connect over a ring buffer; the loader renders those as `ogr.ebpf.sensor/1`
NDJSON on stdout for the userspace PEP.

## Files

| File | Role |
|---|---|
| `ogr_sensor.h` | event ABI, shared byte-for-byte between the BPF program and the loader |
| `ogr_sensor.bpf.c` | the kernel program: fork/exit tree tracking + exec/open/connect hooks |
| `loader.c` | libbpf userspace loader: seed the tree root, drain the ring buffer, print NDJSON |
| `Makefile` | generate `vmlinux.h` from BTF, build `ogr_sensor.bpf.o` and the `ogr-sensor` binary |

## Build

```bash
make            # needs clang, bpftool, libbpf-dev, libelf, zlib
```

`vmlinux.h` is generated from the running kernel's BTF
(`/sys/kernel/btf/vmlinux`), so there is no committed kernel header to drift
and the object is architecture-independent (CO-RE).

## Run

```bash
sudo ./ogr-sensor -- claude -p "review this repo"   # fork/exec under the sensor
sudo ./ogr-sensor --pid 4213                         # attach to a running tree
```

Requires root (or `CAP_BPF` + `CAP_SYS_ADMIN`) and Linux 5.8+ with BTF. NDJSON
goes to stdout; diagnostics to stderr, so pipe it straight into the PEP:

```bash
sudo ./ogr-sensor -- npm test | ogr-ebpf run --records -
```

## Design notes

- **Observation only.** Hooks are tracepoints (`sched_process_*`,
  `sys_enter/exit_*`), which fire after the syscall, so the sensor reports but
  does not deny in-kernel. Enforcement is the PEP's job (kill/contain). A
  BPF-LSM variant that denies pre-commit (`lsm/file_open`, `lsm/socket_connect`)
  is the natural next step and would emit the same events.
- **Tree scoping.** The loader seeds `tracked[root_pid] = root_pid`; `fork`
  propagates membership to children, `exit` removes it. Every event carries
  `root_pid` as the session correlation key. Nothing outside the tree is
  observed.
- **Verifier discipline.** Events are written directly into a
  `bpf_ringbuf_reserve` region (never a large stack struct); user reads
  (`argv`, path, sockaddr) are length-clamped to constant-bounded buffers; and
  the open/connect argument is stashed per-tid from `sys_enter` to `sys_exit`,
  where the path page is resident and the syscall result is known.
- **Fields.** exec carries the program path + argv blob (NUL-separated, read
  from the new `mm`'s arg area); file carries the resolved path + read/write
  access derived from open flags; network carries the IPv4 + port from the
  `connect` sockaddr (AF_INET only — the loader formats the address, no
  in-kernel string work).
