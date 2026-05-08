// Integration test for the proxy's cloud-forward path.
//
// When `thomas cloud connect <agent>` runs, the agent's route is set to the
// THOMAS_CLOUD_PROVIDER_ID sentinel and a gatewayApiKey is stashed on
// cloud.json. Subsequent agent traffic flows: agent → local proxy → cloud
// gateway → real upstream. The local proxy must:
//   - skip decideForAgent (cloud picks)
//   - inject Authorization: Bearer <gatewayApiKey> + X-Thomas-Agent-Id
//   - forward inbound body verbatim
//   - pass response (stream or non-stream) through bytes-for-bytes
//   - log a Run row with outboundProvider=thomas-cloud
//
// We mimic thomas-cloud with a local HTTP server.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeIdentity } from "../src/cloud/identity.js";
import { THOMAS_CLOUD_PROVIDER_ID } from "../src/cloud/types.js";
import { recordConnect } from "../src/config/agents.js";
import { setRoute } from "../src/config/routes.js";
import { startServer } from "../src/proxy/server.js";
import { readRuns } from "../src/runs/store.js";
import type { RunRecord } from "../src/runs/types.js";

async function waitForRuns(expected: number, timeoutMs = 2000): Promise<RunRecord[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const records = await readRuns();
    if (records.length >= expected) return records;
    await new Promise((r) => setTimeout(r, 20));
  }
  return readRuns();
}

let dir: string;
const ORIG_THOMAS_HOME = process.env.THOMAS_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "thomas-cloud-fwd-"));
  process.env.THOMAS_HOME = dir;
});

afterEach(async () => {
  if (ORIG_THOMAS_HOME !== undefined) process.env.THOMAS_HOME = ORIG_THOMAS_HOME;
  else delete process.env.THOMAS_HOME;
  await rm(dir, { recursive: true, force: true });
});

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readReqBody(
  req: Parameters<Parameters<typeof createServer>[0]>[0],
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function setupCloudConnected(opts: {
  agent: "claude-code" | "openclaw";
  cloudPort: number;
  apiKey: string;
}): Promise<{ token: string }> {
  const token = `thomas-test-${opts.agent}-${Math.random().toString(36).slice(2)}`;
  await recordConnect(opts.agent, {
    shimPath: join(dir, "bin", opts.agent),
    originalBinary: `/usr/bin/${opts.agent}`,
    connectedAt: new Date().toISOString(),
    token,
  });
  await setRoute(opts.agent, {
    provider: THOMAS_CLOUD_PROVIDER_ID,
    model: "via-binding",
  });
  await writeIdentity({
    baseUrl: `http://127.0.0.1:${opts.cloudPort}`,
    deviceToken: "device-token-not-used-on-this-path",
    deviceId: "01TEST_DEVICE",
    workspaceId: "01TEST_WORKSPACE",
    loggedInAt: new Date().toISOString(),
    gatewayApiKey: opts.apiKey,
  });
  return { token };
}

describe("proxy cloud-forward", () => {
  it("forwards anthropic traffic to the cloud gateway with bearer + agent-id headers", async () => {
    const captured = {
      url: "",
      method: "",
      authorization: "",
      agentIdHeader: "",
      runIdHeader: "",
      body: "",
    };

    const cloud = createServer(async (req, res) => {
      captured.url = req.url ?? "";
      captured.method = req.method ?? "";
      captured.authorization = (req.headers.authorization as string) ?? "";
      captured.agentIdHeader = (req.headers["x-thomas-agent-id"] as string) ?? "";
      captured.runIdHeader = (req.headers["x-thomas-run-id"] as string) ?? "";
      captured.body = await readReqBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_cloud_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "hello from cloud-routed binding" }],
          usage: { input_tokens: 4, output_tokens: 5 },
        }),
      );
    });
    const cloudPort = await listenEphemeral(cloud);

    const apiKey = "tc_gw_" + "a".repeat(64);
    const { token } = await setupCloudConnected({
      agent: "claude-code",
      cloudPort,
      apiKey,
    });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyPort = (proxy.address() as { port: number }).port;

    let resp: Response;
    let body: { content: Array<{ text: string }> };
    try {
      resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": token,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "ignored-locally",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      body = (await resp.json()) as typeof body;
    } finally {
      await closeServer(proxy);
      await closeServer(cloud);
    }

    expect(resp.status).toBe(200);
    expect(body.content[0]?.text).toBe("hello from cloud-routed binding");

    // Outbound shape.
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/v1/messages");
    expect(captured.authorization).toBe(`Bearer ${apiKey}`);
    expect(captured.agentIdHeader).toBe("claude-code");
    expect(captured.runIdHeader.length).toBeGreaterThan(0);
    // Body forwarded verbatim — model not rewritten on the cloud-forward path.
    const sent = JSON.parse(captured.body);
    expect(sent.model).toBe("ignored-locally");

    const runs = await waitForRuns(1);
    expect(runs.length).toBe(1);
    expect(runs[0]?.outboundProvider).toBe(THOMAS_CLOUD_PROVIDER_ID);
    expect(runs[0]?.outboundModel).toBe("via-binding");
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.httpStatus).toBe(200);
  });

  it("503s with a remediation when cloud-routed but no gatewayApiKey is stored", async () => {
    const token = "thomas-test-no-gateway-token";
    await recordConnect("claude-code", {
      shimPath: join(dir, "bin", "claude-code"),
      originalBinary: "/usr/bin/claude-code",
      connectedAt: new Date().toISOString(),
      token,
    });
    await setRoute("claude-code", {
      provider: THOMAS_CLOUD_PROVIDER_ID,
      model: "via-binding",
    });
    // identity present but missing gatewayApiKey
    await writeIdentity({
      baseUrl: "http://127.0.0.1:65535",
      deviceToken: "x",
      deviceId: "d",
      workspaceId: "w",
      loggedInAt: new Date().toISOString(),
    });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyPort = (proxy.address() as { port: number }).port;
    let resp: Response;
    let text: string;
    try {
      resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      text = await resp.text();
    } finally {
      await closeServer(proxy);
    }
    expect(resp.status).toBe(503);
    expect(text).toContain("thomas cloud connect");
  });

  it("propagates upstream 429 verbatim and logs status=error", async () => {
    const cloud = createServer(async (req, res) => {
      await readReqBody(req);
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited" }));
    });
    const cloudPort = await listenEphemeral(cloud);

    const apiKey = "tc_gw_" + "b".repeat(64);
    const { token } = await setupCloudConnected({
      agent: "claude-code",
      cloudPort,
      apiKey,
    });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyPort = (proxy.address() as { port: number }).port;
    let resp: Response;
    try {
      resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
    } finally {
      await closeServer(proxy);
      await closeServer(cloud);
    }
    expect(resp.status).toBe(429);

    const runs = await waitForRuns(1);
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.httpStatus).toBe(429);
    expect(runs[0]?.outboundProvider).toBe(THOMAS_CLOUD_PROVIDER_ID);
  });

  it("streams SSE bytes-for-bytes back to the agent", async () => {
    const sseChunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"delta","text":"hi"}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const cloud = createServer(async (req, res) => {
      await readReqBody(req);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const c of sseChunks) res.write(c);
      res.end();
    });
    const cloudPort = await listenEphemeral(cloud);

    const apiKey = "tc_gw_" + "c".repeat(64);
    const { token } = await setupCloudConnected({
      agent: "claude-code",
      cloudPort,
      apiKey,
    });

    const proxy = await startServer(0, "127.0.0.1");
    const proxyPort = (proxy.address() as { port: number }).port;
    let resp: Response;
    let text: string;
    try {
      resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [] }),
      });
      text = await resp.text();
    } finally {
      await closeServer(proxy);
      await closeServer(cloud);
    }
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(sseChunks.join(""));
  });
});

describe("cloudConnect preflight", () => {
  it("rejects when not logged in to cloud", async () => {
    const { cloudConnect } = await import("../src/commands/cloud/connect.js");
    const exitCode = await cloudConnect({
      agentId: "claude-code",
      apiKey: "tc_gw_" + "x".repeat(64),
      json: true,
    });
    // ThomasError → non-zero exit; runJson serializes the error to stdout.
    expect(exitCode).not.toBe(0);
  });

  it("rejects keys that don't start with tc_gw_", async () => {
    await writeIdentity({
      baseUrl: "http://127.0.0.1",
      deviceToken: "x",
      deviceId: "d",
      workspaceId: "w",
      loggedInAt: new Date().toISOString(),
    });
    const { cloudConnect } = await import("../src/commands/cloud/connect.js");
    const exitCode = await cloudConnect({
      agentId: "claude-code",
      apiKey: "sk-something-else-entirely",
      json: true,
    });
    expect(exitCode).not.toBe(0);
  });
});
