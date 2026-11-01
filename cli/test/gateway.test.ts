import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway, Health, isFailoverStatus, rewriteBody, upstreamHeaders, upstreamUrl } from "../src/gateway.js";
import { resolveRoute, validate, type Config } from "../src/config.js";

process.env.OPENGUARDRAILS_HOME = mkdtempSync(join(tmpdir(), "openguardrails-gw-"));

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let primary: Handler;
let backup: Handler;
let primaryBodies: string[] = [];
let backupBodies: string[] = [];
let primaryAuth: string[] = [];
const servers: Server[] = [];
const serve = (handler: () => Handler, bodies: () => string[], auth?: () => string[]) =>
  new Promise<number>((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        bodies().push(body);
        auth?.().push(String(req.headers.authorization));
        handler()(req, body, res);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

let gatewayPort = 0;
const post = async (model: string, extra: object = {}) =>
  fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-placeholder" },
    body: JSON.stringify({ model, messages: [], ...extra }),
  });
const ok: Handler = (_q, _b, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"from":"up"}');
};

before(async () => {
  const p1 = await serve(() => primary, () => primaryBodies, () => primaryAuth);
  const p2 = await serve(() => backup, () => backupBodies);
  const config: Config = {
    gateway: {
      port: 0,
      cooldownMs: 300,
      upstreams: {
        a: { baseURL: `http://127.0.0.1:${p1}/v1`, model: "model-a", apiKey: "key-a" },
        b: { baseURL: `http://127.0.0.1:${p2}/v1`, model: "model-b", renameTemplateKwargs: { thinking: "enable_thinking" } },
        dead: { baseURL: "http://127.0.0.1:9/v1", model: "x" },
      },
      routes: { auto: ["a", "b"], chain: ["dead", "b"] },
    },
  };
  const server = await startGateway(config);
  servers.push(server);
  gatewayPort = (server.address() as { port: number }).port;
});
after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});
beforeEach(async () => {
  primary = ok;
  backup = ok;
  primaryBodies = [];
  backupBodies = [];
  primaryAuth = [];
  await new Promise((r) => setTimeout(r, 320));
});

test("the first upstream serves when it is healthy, with its own model and key", async () => {
  const response = await post("auto");
  assert.equal(response.headers.get("x-openguardrails-upstream"), "a");
  assert.equal(JSON.parse(primaryBodies[0]!).model, "model-a");
  assert.deepEqual(primaryAuth, ["Bearer key-a"]);
  assert.equal(backupBodies.length, 0);
});

test("an unreachable upstream fails over", async () => {
  const response = await post("chain");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-openguardrails-upstream"), "b");
});

test("a 503 fails over, and template kwargs follow the upstream's spelling", async () => {
  primary = (_q, _b, res) => {
    res.writeHead(503);
    res.end("busy");
  };
  const response = await post("auto", { chat_template_kwargs: { thinking: false } });
  assert.equal(response.headers.get("x-openguardrails-upstream"), "b");
  assert.deepEqual(JSON.parse(backupBodies[0]!).chat_template_kwargs, { enable_thinking: false });
});

test("a stream that dies before its first byte fails over", async () => {
  primary = (_q, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    setTimeout(() => res.destroy(), 20);
  };
  const response = await post("auto");
  assert.equal(response.headers.get("x-openguardrails-upstream"), "b");
  assert.equal(await response.text(), '{"from":"up"}');
});

test("a 400 is the request's fault and goes back to the client", async () => {
  primary = (_q, _b, res) => {
    res.writeHead(400);
    res.end("bad");
  };
  const response = await post("auto");
  assert.equal(response.status, 400);
  assert.equal(backupBodies.length, 0);
});

test("a cut mid-stream is not retried: bytes are out, and the next request skips that upstream", async () => {
  primary = (_q, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: partial\n\n");
    setTimeout(() => res.destroy(), 20);
  };
  const response = await post("auto");
  await assert.rejects(response.text());
  assert.equal(backupBodies.length, 0);
  primary = ok;
  assert.equal((await post("auto")).headers.get("x-openguardrails-upstream"), "b");
  await new Promise((r) => setTimeout(r, 320));
  assert.equal((await post("auto")).headers.get("x-openguardrails-upstream"), "a");
});

test("a client that hangs up mid-stream does not mark the upstream as failed", async () => {
  primary = (_q, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: [DONE]\n\n");
    setTimeout(() => res.end(), 200);
  };
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [] }),
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await new Promise((r) => setTimeout(r, 60));
  primary = ok;
  assert.equal((await post("auto")).headers.get("x-openguardrails-upstream"), "a");
  assert.equal(backupBodies.length, 0);
});

test("a client that leaves before the first byte does not mark the upstream as failed", async () => {
  primary = (_q, _b, res) => {
    setTimeout(() => {
      if (!res.destroyed) res.end("late");
    }, 200);
  };
  await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [] }),
    signal: AbortSignal.timeout(40),
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 60));
  primary = ok;
  assert.equal((await post("auto")).headers.get("x-openguardrails-upstream"), "a");
});

test("every upstream failing answers 502 and names each failure", async () => {
  const fail: Handler = (_q, _b, res) => {
    res.writeHead(500);
    res.end();
  };
  primary = fail;
  backup = fail;
  const response = await post("auto");
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /a: HTTP 500/);
  assert.match(text, /b: HTTP 500/);
});

test("an unknown model is refused and the known ones are named", async () => {
  const response = await post("nope");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /auto/);
});

test("a stream passes through chunk by chunk and in full", async () => {
  primary = (_q, _b, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    setTimeout(() => res.end("data: 2\n\n"), 30);
  };
  assert.equal(await (await post("auto")).text(), "data: 1\n\ndata: 2\n\n");
});

test("the log holds no key", () => {
  const log = readFileSync(join(process.env.OPENGUARDRAILS_HOME!, "gateway.ndjson"), "utf8");
  assert.ok(!log.includes("key-a"));
  assert.match(log, /"failover"/);
});

test("pure helpers", () => {
  assert.equal(upstreamUrl("http://h:1/v1", "/v1/chat/completions").href, "http://h:1/v1/chat/completions");
  assert.equal(upstreamUrl("https://openrouter.ai/api/v1/", "/v1/messages").href, "https://openrouter.ai/api/v1/messages");
  for (const status of [500, 503, 429, 401, 403, 404, 408]) assert.equal(isFailoverStatus(status), true);
  for (const status of [200, 400, 413, 422]) assert.equal(isFailoverStatus(status), false);
  assert.deepEqual(rewriteBody({ model: "auto", a: 1 }, { baseURL: "", model: "m" }), { model: "m", a: 1 });
  const anthropic = upstreamHeaders({ authorization: "Bearer x", "content-length": "9", accept: "*/*" }, "anthropic.messages", "k");
  assert.deepEqual(anthropic, { accept: "*/*", "x-api-key": "k" });
  assert.equal(upstreamHeaders({ authorization: "Bearer mine" }, "openai.chat", undefined).authorization, "Bearer mine");
  const health = new Health(100);
  health.fail("a", 0);
  assert.deepEqual(health.order(["a", "b"], 50), ["b", "a"]);
  assert.deepEqual(health.order(["a", "b"], 200), ["a", "b"]);
  assert.deepEqual(resolveRoute({ upstreams: { u: { baseURL: "", model: "" } }, routes: { r: ["u"] } }, "r"), ["u"]);
  assert.equal(resolveRoute({ upstreams: {} }, "x"), null);
  assert.throws(() => validate({ gateway: { upstreams: {}, routes: { r: ["missing"] } } }), /unknown upstream/);
});
