import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findDescendant, joinBinary, parseEnv, sandboxCpu, sandboxEnv } from "../src/sandbox.js";

test("the holder's environment is read, and only what the sandbox set is carried to joined commands", () => {
  const holder = parseEnv("HTTP_PROXY=http://u:t@localhost:3128\0PATH=/usr/bin\0LD_PRELOAD=/x.so\0PWD=/tmp\0SHLVL=2\0NO_PROXY=\0EQ=a=b\0");
  assert.equal(holder.EQ, "a=b");
  assert.deepEqual(sandboxEnv(holder, { PATH: "/usr/bin", NO_PROXY: "localhost" }), { HTTP_PROXY: "http://u:t@localhost:3128", LD_PRELOAD: "/x.so", NO_PROXY: "", EQ: "a=b" });
});

function fakeProc(entries: Array<{ pid: number; ppid: number; argv0: string; ns?: string; ticks?: number[] }>): string {
  const root = mkdtempSync(join(tmpdir(), "ogr-proc-"));
  for (const e of entries) {
    mkdirSync(join(root, String(e.pid), "ns"), { recursive: true });
    const [u, s, cu, cs] = e.ticks ?? [0, 0, 0, 0];
    writeFileSync(join(root, String(e.pid), "stat"), `${e.pid} (a b) S ${e.ppid} 0 0 0 0 0 0 0 0 0 ${u} ${s} ${cu} ${cs} 20 0`);
    writeFileSync(join(root, String(e.pid), "cmdline"), `${e.argv0}\0arg\0`);
  }
  return root;
}

test("the holder is found among the run's descendants, not elsewhere", () => {
  const proc = fakeProc([
    { pid: 100, ppid: 1, argv0: "bwrap" },
    { pid: 101, ppid: 100, argv0: "bash" },
    { pid: 102, ppid: 101, argv0: "ogr-holder-voicego" },
    { pid: 200, ppid: 1, argv0: "ogr-holder-voicego" },
  ]);
  assert.equal(findDescendant(100, "ogr-holder-voicego", proc), 102);
  assert.equal(findDescendant(300, "ogr-holder-voicego", proc), null);
});

test("the sandbox's CPU is that of every process in its PID namespace, with their waited-for children", async () => {
  const { symlinkSync } = await import("node:fs");
  const proc = fakeProc([
    { pid: 10, ppid: 1, argv0: "ogr-holder-x", ticks: [1, 1, 0, 0] },
    { pid: 11, ppid: 1, argv0: "worker", ticks: [100, 50, 40, 10] },
    { pid: 12, ppid: 1, argv0: "outside", ticks: [999, 999, 0, 0] },
  ]);
  for (const [pid, ns] of [[10, "pid:[7]"], [11, "pid:[7]"], [12, "pid:[1]"]] as const) symlinkSync(ns, join(proc, String(pid), "ns", "pid"));
  assert.equal(sandboxCpu(10, proc), 2.02);
  assert.equal(sandboxCpu(99, proc), 0);
});

test("joining is offered only on Linux", () => {
  assert.equal(joinBinary("darwin", "arm64"), null);
});
