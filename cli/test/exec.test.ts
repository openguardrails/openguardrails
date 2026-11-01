import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecTracker, fileObservation } from "../src/exec.js";
import { toolCallsInReply } from "../src/model.js";

test("an observation belongs to the call open at that moment", () => {
  const e = new ExecTracker();
  e.open([{ id: "x", hosts: ["raw.githubusercontent.com"] }], 100);
  e.observe({ t: 150, kind: "network", target: "raw.githubusercontent.com:443", action: "GET" });
  e.observe({ t: 160, kind: "network", target: "collector.evil.test:443", action: "POST", bytes: 40000 });
  e.close(["x"], 200);
  e.observe({ t: 300, kind: "network", target: "later.test:443", action: "GET" });
  const { items } = e.drain()!;
  const by = (target: string) => items.find((item) => item.target.startsWith(target))!;
  assert.deepEqual(by("raw").call_ids, ["x"]);
  assert.equal(by("raw").undeclared, undefined);
  assert.deepEqual(by("collector").call_ids, ["x"]);
  assert.equal(by("collector").undeclared, true);
  assert.equal(by("collector").bytes_up, 40000);
  assert.deepEqual(by("later").call_ids, []);
  assert.equal(by("later").undeclared, undefined);
});

test("a report that arrives late still lands on the call it happened under", () => {
  const e = new ExecTracker();
  e.open([{ id: "x", hosts: [] }], 100);
  e.close(["x"], 200);
  e.open([{ id: "y", hosts: [] }], 210);
  assert.deepEqual(e.observe({ t: 150, kind: "file", target: "/k", action: "read", denied: true }).call_ids, ["x"]);
});

test("parallel calls share what happened, rather than guessing", () => {
  const e = new ExecTracker();
  e.open([{ id: "b", hosts: [] }, { id: "a", hosts: ["h.test"] }], 100);
  const item = e.observe({ t: 150, kind: "network", target: "h.test:443" });
  assert.deepEqual(item.call_ids, ["a", "b"]);
  assert.equal(item.undeclared, undefined);
});

test("repeats are counted, and draining empties", () => {
  const e = new ExecTracker();
  e.observe({ t: 1, kind: "network", target: "a:443", action: "GET", bytes: 1 });
  e.observe({ t: 2, kind: "network", target: "a:443", action: "GET", bytes: 2 });
  const { items } = e.drain()!;
  assert.equal(items[0]!.count, 2);
  assert.equal(items[0]!.bytes_up, 3);
  assert.equal(e.drain(), undefined);
});

test("the cap keeps denials and says how much it dropped", () => {
  const e = new ExecTracker(2);
  e.observe({ t: 1, kind: "network", target: "a:1" });
  e.observe({ t: 1, kind: "network", target: "b:1" });
  e.observe({ t: 1, kind: "file", target: "/secret", denied: true });
  const report = e.drain()!;
  assert.equal(report.items[0]!.target, "/secret");
  assert.equal(report.dropped, 1);
});

test("an abandoned call stops collecting", () => {
  const e = new ExecTracker(200, 1000, 1000);
  e.open([{ id: "x", hosts: [] }], 0);
  assert.deepEqual(e.observe({ t: 5000, kind: "network", target: "a:1" }).call_ids, []);
});

test("reads a macOS sandbox line, and ignores what is not file work", () => {
  assert.deepEqual(fileObservation("cat(5) deny(1) file-read-data /u/.ssh/config", 9), { t: 9, kind: "file", target: "/u/.ssh/config", action: "read", denied: true, process: "cat" });
  assert.equal(fileObservation("bash(5) deny(1) file-write-create /x", 9)?.action, "write");
  assert.equal(fileObservation("bash(5) deny(1) file-read-metadata /x", 9), null);
  assert.equal(fileObservation("deny network-outbound h:1", 9), null);
});

test("tool calls are read from each reply shape", () => {
  const sse = (...frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  const chat = sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "sh", arguments: '{"c":"cu' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'rl"}' } }] } }] },
  );
  assert.deepEqual(toolCallsInReply("openai.chat", chat, true), [{ id: "c1", name: "sh", args: '{"c":"curl"}' }]);
  const anthropic = sse(
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
  );
  assert.deepEqual(toolCallsInReply("anthropic.messages", anthropic, true), [{ id: "t1", name: "Bash", args: "{}" }]);
  const responses = sse({ type: "response.output_item.done", item: { type: "function_call", call_id: "r1", name: "exec", arguments: "{}" } });
  assert.deepEqual(toolCallsInReply("openai.responses", responses, true), [{ id: "r1", name: "exec", args: "{}" }]);
  assert.equal(toolCallsInReply("openai.chat", JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "w", function: { name: "n", arguments: "{}" } }] } }] }), false)[0]!.id, "w");
  assert.deepEqual(toolCallsInReply("openai.chat", "not json", false), []);
});
