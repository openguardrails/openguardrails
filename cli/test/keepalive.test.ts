import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { KEEPALIVE, sseKeepAlive } from "../src/keepalive.js";

async function serve(handler: (res: http.ServerResponse) => Promise<void>): Promise<string> {
  const server = http.createServer((_req, res) => {
    sseKeepAlive(res, 200);
    void handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  server.close();
  return body;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a silent stream gets keep-alive comments between events", async () => {
  const body = await serve(async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"a\":1}\n\n");
    await wait(700);
    res.end("data: [DONE]\n\n");
  });
  assert.ok(body.split(KEEPALIVE).length - 1 >= 2, body);
  assert.match(body, /^data: \{"a":1\}\n\n(: keep-alive\n\n)+data: \[DONE\]\n\n$/);
});

test("no comment is written into the middle of an event", async () => {
  const body = await serve(async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"par");
    await wait(700);
    res.end("t\":1}\n\n");
  });
  assert.equal(body, "data: {\"part\":1}\n\n");
});

test("a reply that is not a stream gets none", async () => {
  const body = await serve(async (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    await wait(500);
    res.end("{}\n\n");
  });
  assert.equal(body, "{}\n\n");
});
