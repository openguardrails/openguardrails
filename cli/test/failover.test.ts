import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { rewriteBody, Slots, startGateway } from "../src/gateway.js";

process.env.OPENGUARDRAILS_HOME = mkdtempSync(join(tmpdir(), "openguardrails-failover-"));

const servers: http.Server[] = [];
after(() => servers.forEach((server) => server.close()));

const listen = (handler: http.RequestListener) =>
  new Promise<number>((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
  });

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const free = (probe.address() as any).port;
      probe.close(() => resolve(free));
    });
  });

test("a slot is held until released, a waiter gets the next one, and a timed-out waiter gets none", async () => {
  const slots = new Slots();
  const first = await slots.acquire("a", 1);
  assert.ok(first);
  assert.equal(await slots.acquire("a", 1), null, "no wait: busy is null at once");
  const waiting = slots.acquire("a", 1, 1_000);
  assert.deepEqual(slots.busy().a, { active: 1, waiting: 1 });
  first!();
  first!(); // releasing twice frees one slot, not two
  const second = await waiting;
  assert.ok(second);
  assert.deepEqual(slots.busy().a, { active: 1, waiting: 0 });
  assert.equal(await slots.acquire("a", 1, 20), null, "a wait that runs out gets nothing");
  second!();
  assert.deepEqual(slots.busy().a, { active: 0, waiting: 0 });
  assert.ok(await slots.acquire("b", undefined), "no limit, no slot to take");
});

test("sampling follows thinking, which is on when the client does not say", () => {
  const upstream = {
    baseURL: "http://x/v1",
    model: "qwen3.8-27b",
    renameTemplateKwargs: { thinking: "enable_thinking" },
    thinkingParams: { on: { temperature: 1.0, top_p: 0.95 }, off: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5 } },
  };
  const off = rewriteBody({ model: "dsv41-flash", chat_template_kwargs: { thinking: false }, temperature: 0.2 }, upstream);
  assert.deepEqual(off, { model: "qwen3.8-27b", chat_template_kwargs: { enable_thinking: false }, temperature: 0.7, top_p: 0.8, presence_penalty: 1.5 });
  const unsaid = rewriteBody({ model: "dsv41-flash" }, upstream);
  assert.deepEqual(unsaid, { model: "qwen3.8-27b", chat_template_kwargs: { enable_thinking: true }, temperature: 1.0, top_p: 0.95 });
  // An upstream without thinkingParams is left as it was.
  assert.deepEqual(rewriteBody({ model: "a", temperature: 0.2 }, { baseURL: "http://x", model: "b" }), { model: "b", temperature: 0.2 });
});

test("a busy preferred upstream sends the overflow to the next one, and frees its slot when the reply ends", async () => {
  let release: (() => void) | null = null;
  const seen: string[] = [];
  const answer = (res: http.ServerResponse, who: string) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: who, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: who }, finish_reason: "stop" }] }));
  };
  const read = (req: http.IncomingMessage) => new Promise<any>((resolve) => { let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => resolve(JSON.parse(raw))); });
  const primary = await listen(async (req, res) => {
    const body = await read(req);
    seen.push(`primary ${body.model}`);
    if (!release) await new Promise<void>((resolve) => (release = resolve));
    answer(res, "primary");
  });
  const backup = await listen(async (req, res) => {
    const body = await read(req);
    seen.push(`backup ${body.model} thinking=${body.chat_template_kwargs?.enable_thinking} t=${body.temperature}`);
    answer(res, "backup");
  });
  const port = await freePort();
  servers.push(await startGateway({
    gateway: {
      port,
      upstreams: {
        dsv41: { baseURL: `http://127.0.0.1:${primary}/v1`, model: "dsv41-flash", maxConcurrent: 1 },
        qwen: { baseURL: `http://127.0.0.1:${backup}/v1`, model: "qwen3.8-27b", renameTemplateKwargs: { thinking: "enable_thinking" }, thinkingParams: { on: { temperature: 1 }, off: { temperature: 0.7 } } },
      },
      routes: { "dsv41-flash": ["dsv41", "qwen"] },
    },
  }));
  const ask = (thinking?: boolean) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "dsv41-flash", messages: [{ role: "user", content: "hi" }], ...(thinking === undefined ? {} : { chat_template_kwargs: { thinking } }) }),
    }).then(async (reply) => ((await reply.json()) as any).choices[0].message.content as string);

  const held = ask();
  while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  // The primary's one slot is taken, so this one goes to the backup, with its sampling.
  assert.equal(await ask(false), "backup");
  (release as unknown as () => void)();
  assert.equal(await held, "primary");
  // Its reply ended, so the slot is free again.
  assert.equal(await ask(), "primary");
  assert.deepEqual(seen, ["primary dsv41-flash", "backup qwen3.8-27b thinking=false t=0.7", "primary dsv41-flash"]);
});
