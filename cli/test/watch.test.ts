import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cpuSeconds, isBusy, newestChange, StallWatch, treeCpuSeconds, type Activity } from "../src/watch.js";

const quiet: Activity = { cpuPercent: 0, networkEvents: 0, openConnections: 0, modelCalls: 0, modelWaiting: 0 };
const working: Activity = { ...quiet, cpuPercent: 90 };
const rule = { name: "translating or publishing gets stuck", progress: [], idleMinutes: 10, notify: ["email"] };
const min = 60_000;

test("busy without new output for the whole window is stuck, once, until output moves again", () => {
  const watch = new StallWatch(rule, 0);
  const results = [];
  for (let t = 1; t <= 14; t += 1) results.push(watch.step({ t: t * min, busy: true, activity: working }, 0)?.kind ?? null);
  assert.deepEqual(results.filter(Boolean), ["stalled"]);
  assert.equal(results.indexOf("stalled"), 9);
  assert.equal(watch.step({ t: 15 * min, busy: true, activity: working }, 14.5 * min)?.kind, "recovered");
  assert.equal(watch.stalled, false);
});

test("a command that finished and sits idle is not stuck", () => {
  const watch = new StallWatch(rule, 0);
  for (let t = 1; t <= 60; t += 1) assert.equal(watch.step({ t: t * min, busy: false, activity: quiet }, 0), null);
});

test("a moment of activity in a quiet window, such as a health check, is not stuck", () => {
  const watch = new StallWatch(rule, 0);
  for (let t = 1; t <= 30; t += 1) assert.equal(watch.step({ t: t * min, busy: t % 5 === 0, activity: t % 5 === 0 ? working : quiet }, 0), null);
});

test("output that keeps appearing is progress, however busy the command is", () => {
  const watch = new StallWatch(rule, 0);
  for (let t = 1; t <= 60; t += 1) assert.equal(watch.step({ t: t * min, busy: true, activity: working }, (t - 3) * min), null);
});

test("waiting on a model or a connection counts as busy, with no CPU", () => {
  assert.equal(isBusy({ ...quiet, modelWaiting: 1 }), true);
  assert.equal(isBusy({ ...quiet, openConnections: 2 }), true);
  assert.equal(isBusy({ ...quiet, cpuPercent: 3 }), false);
});

test("the newest change under the output directories is found, and where", () => {
  const root = mkdtempSync(join(tmpdir(), "ogr-watch-"));
  mkdirSync(join(root, "ep1", "dub"), { recursive: true });
  writeFileSync(join(root, "ep1", "notes.json"), "{}");
  writeFileSync(join(root, "ep1", "dub", "translation.json"), "{}");
  const old = new Date(Date.now() - 3600_000);
  for (const path of [join(root, "ep1", "notes.json"), join(root, "ep1", "dub"), join(root, "ep1"), root]) utimesSync(path, old, old);
  const found = newestChange([root]);
  assert.equal(found.path, join(root, "ep1", "dub", "translation.json"));
  assert.equal(newestChange([join(root, "missing")]).path, null);
  // Ahead of every earlier file by whole seconds: the file system keeps nanoseconds, utimes takes
  // milliseconds, and a file written a moment before could otherwise look newer.
  const now = new Date(Date.now() + 5000);
  writeFileSync(join(root, "ep1", "dub", "windows.json"), "{}");
  utimesSync(join(root, "ep1", "dub"), now, now);
  utimesSync(join(root, "ep1", "dub", "windows.json"), now, now);
  assert.equal(newestChange([root]).path, join(root, "ep1", "dub", "windows.json"));
});

test("CPU time is read from ps on Linux and macOS, and summed over the process tree", () => {
  assert.equal(cpuSeconds("00:01:05"), 65);
  assert.equal(cpuSeconds("1-00:00:01"), 86_401);
  assert.equal(cpuSeconds("2:03.50"), 123.5);
  const ps = " 10 1 00:00:10\n 11 10 00:00:05\n 12 11 00:01:00\n 13 1 00:09:00\n";
  assert.equal(treeCpuSeconds(ps, 10), 75);
});
