import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { readVerdict, startGateway } from "../src/gateway.js";

const home = mkdtempSync(join(tmpdir(), "openguardrails-enforce-"));
process.env.OPENGUARDRAILS_HOME = home;

type Airs = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let airs: Airs;
let events: Array<{ headers: http.IncomingHttpHeaders; url: string; body: string }> = [];
let upstreamBodies: string[] = [];
let upstreamReply: (res: http.ServerResponse) => void;
const servers: Server[] = [];
const listen = (handler: http.RequestListener) =>
  new Promise<number>((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
const collect = (req: http.IncomingMessage, done: (body: string) => void) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => done(body));
};
const verdict = (res: http.ServerResponse, value: object, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
/** A runtime that allows everything, and echoes a streamed reply back with its verdict. */
const allowAll: Airs = (req, body, res) => {
  if (String(req.headers["content-type"]).includes("event-stream")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`${body}: ogr {"decision":"allow"}\n\n`);
  } else verdict(res, { decision: "allow", payload: "unchanged", findings: [] });
};
const SSE = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"sh","arguments":"{\\"c\\":\\"curl https://named.test\\"}"}}]}}]}\n\ndata: [DONE]\n\n';

let port = 0;
let closedPort = 0;
const post = (target: number, extra: object = {}) =>
  fetch(`http://127.0.0.1:${target}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], ...extra }),
  });
const token = () => readFileSync(join(home, "gateway.token"), "utf8");

before(async () => {
  const airsPort = await listen((req, res) =>
    collect(req, (body) => {
      events.push({ headers: req.headers, url: req.url ?? "", body });
      airs(req, body, res);
    }),
  );
  const upstreamPort = await listen((req, res) =>
    collect(req, (body) => {
      upstreamBodies.push(body);
      upstreamReply(res);
    }),
  );
  const upstreams = { a: { baseURL: `http://127.0.0.1:${upstreamPort}/v1`, model: "model-a" } };
  const closed = await startGateway({
    gateway: { port: 0, upstreams, routes: { auto: ["a"] } },
    airs: { url: `http://127.0.0.1:${airsPort}`, apiKey: "k", failMode: "closed", requestTimeoutMs: 400 },
  });
  closedPort = (closed.address() as { port: number }).port;
  const open = await startGateway({
    gateway: { port: 0, upstreams, routes: { auto: ["a"] } },
    airs: { url: `http://127.0.0.1:${airsPort}`, apiKey: "k", requestTimeoutMs: 400 },
  });
  port = (open.address() as { port: number }).port;
  servers.push(closed, open);
});
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});
beforeEach(() => {
  airs = allowAll;
  events = [];
  upstreamBodies = [];
  upstreamReply = (res) => verdict(res, { id: "x", choices: [{ message: { role: "assistant", content: "real reply" } }] });
});

test("a refused request never reaches the model, and the client gets the rendered refusal", async () => {
  airs = (_q, _b, res) => verdict(res, { decision: "block", payload: { id: "refusal", choices: [] } });
  const response = await post(port);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-openguardrails-verdict"), "blocked");
  assert.equal((await response.json() as { id: string }).id, "refusal");
  assert.equal(upstreamBodies.length, 0);
});

test("a refusal rendered as a stream is sent as a stream", async () => {
  airs = (_q, _b, res) => verdict(res, { decision: "block", payload: "data: no\n\n", payload_stream: true });
  const response = await post(port, { stream: true });
  assert.match(String(response.headers.get("content-type")), /event-stream/);
  assert.equal(await response.text(), "data: no\n\n");
  assert.equal(upstreamBodies.length, 0);
});

test("a block with a continuation carries on with the body AIRS returned", async () => {
  airs = (_q, _b, res) => verdict(res, { decision: "block", continuation: { style: "withhold" }, payload: { model: "m", messages: [{ role: "tool", content: "withheld" }] } });
  await post(port);
  assert.match(upstreamBodies[0]!, /withheld/);
  assert.equal(JSON.parse(upstreamBodies[0]!).model, "model-a");
});

test("an allow with a body forwards that body, so a mask takes effect", async () => {
  airs = (req, body, res) =>
    JSON.parse(body).kind === "step/request" ? verdict(res, { decision: "allow", payload: { model: "m", messages: [{ role: "user", content: "OGRKR0000001" }] } }) : allowAll(req, body, res);
  await post(port);
  assert.match(upstreamBodies[0]!, /OGRKR0000001/);
});

test("the whole-reply half can replace or refuse what the client receives", async () => {
  airs = (req, body, res) => (JSON.parse(body).kind === "step/response" ? verdict(res, { decision: "block", payload: { id: "refused-reply" } }) : allowAll(req, body, res));
  const response = await post(port);
  const text = await response.text();
  assert.match(text, /refused-reply/);
  assert.doesNotMatch(text, /real reply/);
  assert.equal(events.map((e) => JSON.parse(e.body).kind).join(), "step/request,step/response");
  assert.equal(JSON.parse(events[0]!.body).step_id, JSON.parse(events[1]!.body).step_id);
  assert.match(events[0]!.url, /payload=true/);
});

test("a stream goes up to AIRS, and the client receives what AIRS returns", async () => {
  upstreamReply = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(SSE);
  };
  airs = (req, body, res) => {
    if (!String(req.headers["content-type"]).includes("event-stream")) return allowAll(req, body, res);
    assert.equal(req.headers["ogr-llm-protocol"], "openai.chat");
    assert.equal(req.headers["ogr-kind"], "step/response");
    assert.ok(body.includes("call1"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"from":"airs"}\n\n: ogr {"decision":"block"}\n\n');
  };
  const text = await (await post(port, { stream: true })).text();
  assert.match(text, /from.*airs/);
  assert.doesNotMatch(text, /call1/);
});

test("no verdict, fail open: the request and the stream still go through", async () => {
  airs = (_q, _b, res) => verdict(res, { error: "down" }, 500);
  upstreamReply = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: 1\n\n");
  };
  assert.equal(await (await post(port, { stream: true })).text(), "data: 1\n\n");
  assert.equal(upstreamBodies.length, 1);
});

test("a 200 without a decision is not a verdict", async () => {
  airs = (_q, _b, res) => verdict(res, { ok: true });
  assert.equal((await post(closedPort)).status, 503);
  assert.equal(upstreamBodies.length, 0);
});

test("no verdict, fail closed: refused, and it says so rather than looking like policy", async () => {
  airs = (_q, _b, res) => verdict(res, {}, 500);
  const response = await post(closedPort);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-openguardrails-verdict"), "fail-closed");
  assert.equal(upstreamBodies.length, 0);
});

test("a silent AIRS costs a bounded wait after the reply ends, then fails open", async () => {
  airs = (req, body, res) => {
    if (String(req.headers["content-type"]).includes("event-stream")) return; // never answers
    allowAll(req, body, res);
  };
  upstreamReply = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: 1\n\n");
  };
  assert.equal(await (await post(port, { stream: true })).text(), "data: 1\n\n");
});

test("a reply slower than the budget is still judged, because AIRS answers only once it has it all", async () => {
  upstreamReply = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: dangerous-part\n\n");
    // Several times the 400 ms budget.
    setTimeout(() => res.end("data: [DONE]\n\n"), 1300);
  };
  airs = (req, body, res) => {
    if (!String(req.headers["content-type"]).includes("event-stream")) return allowAll(req, body, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"refused":true}\n\n: ogr {"decision":"block"}\n\n');
  };
  const text = await (await post(port, { stream: true })).text();
  assert.match(text, /refused/);
  assert.doesNotMatch(text, /dangerous-part/);
});

test("what the sandbox saw rides the next request, tied to the call", async () => {
  upstreamReply = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(SSE);
  };
  await (await post(port, { stream: true })).text();
  // Runs with the open gateway's token: the two gateways in this test share a home, so the last start wins.
  const observe = (target: number) =>
    fetch(`http://127.0.0.1:${target}/__ogr/observe`, {
      method: "POST",
      headers: { "x-openguardrails-token": token() },
      body: JSON.stringify([
        { t: Date.now(), kind: "network", target: "named.test:443", action: "GET" },
        { t: Date.now(), kind: "network", target: "collector.evil.test:443", action: "POST", bytes: 40000 },
        { t: Date.now(), kind: "file", target: "/u/.ssh/id", action: "read", denied: true },
      ]),
    });
  assert.equal((await observe(port)).status, 200);
  events = [];
  await (await post(port, { messages: [{ role: "assistant", tool_calls: [{ id: "call1", function: { name: "sh", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call1", content: "ok" }] })).text();
  const event = JSON.parse(events[0]!.body);
  assert.equal(event.kind, "step/request");
  const by = (t: string) => event.exec.items.find((i: { target: string }) => i.target.startsWith(t));
  assert.deepEqual(by("collector").call_ids, ["call1"]);
  assert.equal(by("collector").undeclared, true);
  assert.equal(by("named").undeclared, undefined);
  assert.equal(by("/u/.ssh").denied, true);
  assert.equal(event.exec.items[0].target, "/u/.ssh/id");
});

test("an AIRS that refuses the exec field still judges, and is not asked again", async () => {
  await fetch(`http://127.0.0.1:${port}/__ogr/observe`, { method: "POST", headers: { "x-openguardrails-token": token() }, body: JSON.stringify([{ t: Date.now(), kind: "network", target: "a.test:1" }]) });
  airs = (req, body, res) => (JSON.parse(body).exec ? verdict(res, { error: "invalid_event", details: "unrecognized key: exec" }, 400) : allowAll(req, body, res));
  const response = await post(port);
  assert.equal(response.status, 200);
  assert.equal(upstreamBodies.length, 1);
  assert.equal(JSON.parse(events.at(-2)!.body).exec, undefined);
});

test("internal paths refuse a caller without the token, and the keys never reach the log", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/__ogr/observe`, { method: "POST", body: "[]" })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/__ogr/activity`)).status, 403);
  assert.ok(!readFileSync(join(home, "gateway.ndjson"), "utf8").includes('"k"'));
});

test("readVerdict covers every case of the payload", () => {
  assert.deepEqual(readVerdict({ decision: "allow", payload: "unchanged" }), { kind: "forward" });
  assert.deepEqual(readVerdict({ decision: "allow" }), { kind: "forward" });
  assert.deepEqual(readVerdict({ decision: "allow", payload: { a: 1 } }), { kind: "forward", body: { a: 1 } });
  assert.deepEqual(readVerdict({ decision: "block", continuation: { style: "drop_calls" }, payload: { a: 1 } }), { kind: "forward", body: { a: 1 } });
  assert.equal(readVerdict({ decision: "block", continuation: { style: "answer" }, payload: { a: 1 } }).kind, "answer");
  assert.equal(readVerdict({ decision: "block", payload: { a: 1 } }).kind, "answer");
  // A block with nothing rendered refuses; it must never read as an allow.
  const bare = readVerdict({ decision: "block" });
  assert.equal(bare.kind === "answer" && bare.status, 403);
});
