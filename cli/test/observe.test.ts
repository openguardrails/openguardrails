import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Deduper, isRoutineRead, ObserveLog, parseLine, preloadLibrary } from "../src/observe.js";

test("a log line is read back, and a malformed one is dropped", () => {
  assert.deepEqual(parseLine("1700000000000\twrite\t42\tpython3\t/work/ep1/dub/translation.json"), {
    t: 1700000000000, action: "write", pid: 42, process: "python3", path: "/work/ep1/dub/translation.json",
  });
  assert.equal(parseLine("1\tdelete\t1\tx\t/a"), null);
  assert.equal(parseLine("garbage"), null);
});

test("lines are read as they are appended, and a half-written line waits for its end", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ogr-observe-")), "observe.log");
  const log = new ObserveLog(path);
  assert.deepEqual(log.read(), []);
  writeFileSync(path, "1\texec\t1\tbash\t/usr/bin/curl\n2\tread\t1\tcur");
  assert.equal(log.read().length, 1);
  appendFileSync(path, "l\t/home/me/.netrc\n");
  assert.deepEqual(log.read().map((e) => e.path), ["/home/me/.netrc"]);
  assert.deepEqual(log.read(), []);
});

test("what every program reads to start is routine; the task's own files are not", () => {
  assert.equal(isRoutineRead("/usr/lib/python3.10/json/__init__.py"), true);
  assert.equal(isRoutineRead("/data/voicego/envs/video/lib/python3.10/site-packages/yt_dlp/YoutubeDL.py"), true);
  assert.equal(isRoutineRead("/etc/ssl/certs/ca-certificates.crt"), true);
  assert.equal(isRoutineRead("/data/voicego/secrets/youtube-cookies.txt"), false);
  assert.equal(isRoutineRead("/etc/shadow"), false);
  assert.equal(isRoutineRead("/home/me/.ssh/id_ed25519"), false);
});

test("a loop over one file is one event per window", () => {
  const deduper = new Deduper(10_000);
  const event = { t: 0, action: "write" as const, pid: 1, process: "x", path: "/a" };
  assert.equal(deduper.fresh(event), true);
  assert.equal(deduper.fresh({ ...event, t: 5_000 }), false);
  assert.equal(deduper.fresh({ ...event, action: "read" }), true);
  assert.equal(deduper.fresh({ ...event, t: 12_000 }), true);
});

test("the library is offered only on Linux", () => {
  assert.equal(preloadLibrary("darwin", "arm64"), null);
});

test("on Linux, the library reports opens and execs of the processes it is loaded into", { skip: process.platform !== "linux" || !preloadLibrary() }, async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ogr-preload-"));
  const log = join(dir, "observe.log");
  writeFileSync(join(dir, "in.txt"), "x");
  // Python's subprocess closes every descriptor before exec, which a kept log descriptor would not survive.
  execFileSync("sh", ["-c", `cat in.txt > out.txt; python3 -c "import subprocess; subprocess.run(['true'])"`], {
    cwd: dir,
    env: { ...process.env, LD_PRELOAD: preloadLibrary()!, OGR_OBSERVE_LOG: log },
    timeout: 20_000,
  });
  const events = readFileSync(log, "utf8").trim().split("\n").map(parseLine);
  const has = (action: string, test: (path: string) => boolean) => events.some((e) => e?.action === action && test(e.path));
  assert.ok(has("exec", (p) => p.endsWith("/cat")));
  assert.ok(has("read", (p) => p === join(dir, "in.txt")));
  assert.ok(has("write", (p) => p === join(dir, "out.txt")));
  assert.ok(has("exec", (p) => p.endsWith("/true")));
  // A PATH search tries directories where the program is not; only the one that ran is reported.
  assert.equal(events.filter((e) => e?.action === "exec" && e.path.endsWith("/true")).length, 1);
});

test("a Seatbelt report of an allowed operation is read as an exec, a read or a write", async () => {
  const { parseSeatbeltReport } = await import("../src/observe.js");
  const tag = "\nCMD64_dHJ1ZQ==_END__x_SBX";
  assert.deepEqual(parseSeatbeltReport(`Sandbox: cat(40462) allow file-read-data /work/in.txt${tag}`, 5), { t: 5, action: "read", pid: 40462, process: "cat", path: "/work/in.txt" });
  assert.equal(parseSeatbeltReport(`Sandbox: bash(1) allow process-exec* /bin/cat${tag}`, 1)?.action, "exec");
  assert.equal(parseSeatbeltReport(`Sandbox: bash(1) allow file-write-create /work/out file.txt${tag}`, 1)?.path, "/work/out file.txt");
  assert.equal(parseSeatbeltReport(`Sandbox: head(2) deny(1) file-read-data /Users/me/.ssh/config${tag}`, 1), null);
  assert.equal(parseSeatbeltReport("5 duplicate reports for Sandbox: mds(373) deny(1) system-info", 1), null);
  assert.equal(isRoutineRead("/System/Library/Frameworks/Foundation.framework/Foundation"), true);
  assert.equal(isRoutineRead("/usr/lib/libSystem.B.dylib"), true);
});
