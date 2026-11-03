import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { applyAttach, detach, planAttach, readManifest } from "../src/attach.js";
import { loadConfig } from "../src/config.js";
import { startGateway } from "../src/gateway.js";
import { scan } from "../src/scan/index.js";
import type { ScanContext } from "../src/scan/types.js";

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

function fixture(files: Record<string, string>): ScanContext {
  const root = mkdtempSync(join(tmpdir(), "ogr-attach-"));
  process.env.OPENGUARDRAILS_HOME = join(root, ".openguardrails");
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { home: root, platform: "linux", env: { PATH: "" }, gatewayPort: 4180 };
}

const HERMES = `# my Hermes config
model:
  default: big-model
  provider: custom
  base_url: https://api.example.com/v1   # the lab gateway
  api_key: \${LAB_KEY}
custom_providers:
  - name: local
    base_url: "http://10.0.0.5:8000/v1"
`;
const OPENCLAW = `{
  // JSON5, as OpenClaw writes it
  "models": { "providers": { "vllm": { "baseUrl": "http://10.0.0.5:8000/v1", "apiKey": "local-no-auth", }, }, },
  "notes": "see https://api.example.com/v1 for docs",
}`;
const CODEX = `model_provider = "lab"
[model_providers.lab]
base_url = "https://api.example.com/v1"
env_key = "LAB_KEY"
`;
const DSH = `- id: llm-pi-ai
  config:
    providers:
      main:
        baseURL: https://api.example.com/v1
`;

test("attach rewrites only base URL values, keeps everything else, and detach restores the files exactly", () => {
  const ctx = fixture({
    ".hermes/config.yaml": HERMES,
    ".openclaw/openclaw.json": OPENCLAW,
    ".codex/config.toml": CODEX,
    ".dsh/profiles/headless/cordis.patch.yml": DSH,
    ".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }),
  });
  const agents = scan(ctx).agents;
  const plan = planAttach(agents, 4180, loadConfig(), new Date(0));
  assert.deepEqual([...new Set(plan.changes.map((c) => c.agent))].sort(), ["codex", "deepseek-harness", "hermes", "openclaw"]);
  // Claude Code is listed only, so it is never rewritten.
  assert.ok(plan.skipped.some((s) => s.agent === "claude-code" && /does not protect/.test(s.reason)));
  // One name per origin, whichever agent uses it.
  assert.deepEqual([...new Set(plan.changes.map((c) => `${c.name} ${new URL(c.from).origin}`))].sort(), ["10.0.0.5-8000 http://10.0.0.5:8000", "api.example.com https://api.example.com"]);

  applyAttach(plan, loadConfig());
  const hermes = readFileSync(join(ctx.home, ".hermes/config.yaml"), "utf8");
  assert.equal(hermes, HERMES.replace("https://api.example.com/v1", "http://127.0.0.1:4180/u/api.example.com/v1").replace('"http://10.0.0.5:8000/v1"', '"http://127.0.0.1:4180/u/10.0.0.5-8000/v1"'));
  const claw = readFileSync(join(ctx.home, ".openclaw/openclaw.json"), "utf8");
  assert.ok(claw.includes('"baseUrl": "http://127.0.0.1:4180/u/10.0.0.5-8000/v1"'));
  assert.ok(claw.includes("see https://api.example.com/v1 for docs"), "a URL inside prose is not a value");
  assert.ok(claw.includes("// JSON5, as OpenClaw writes it"));
  assert.ok(readFileSync(join(ctx.home, ".codex/config.toml"), "utf8").includes('base_url = "http://127.0.0.1:4180/u/api.example.com/v1"'));
  assert.ok(readFileSync(join(ctx.home, ".dsh/profiles/headless/cordis.patch.yml"), "utf8").includes("baseURL: http://127.0.0.1:4180/u/api.example.com/v1"));

  const config = loadConfig();
  assert.deepEqual(config.gateway!.attached!["api.example.com"]!.origin, "https://api.example.com");
  assert.deepEqual(config.gateway!.attached!["api.example.com"]!.agents.sort(), ["codex", "deepseek-harness", "hermes"]);
  assert.ok(plan.changes.every((change) => existsSync(change.backup)));

  // A second scan sees the agents behind the gateway, and a second attach has nothing to do.
  const again = scan(ctx);
  assert.ok(again.agents.filter((a) => a.protectable && a.models.some((m) => m.base_url)).every((a) => a.models.filter((m) => m.base_url).every((m) => m.through_gateway)));
  assert.equal(planAttach(again.agents, 4180, loadConfig()).changes.length, 0);

  // Detaching one agent keeps a name another agent still uses.
  detach(["hermes"], loadConfig());
  assert.equal(readFileSync(join(ctx.home, ".hermes/config.yaml"), "utf8"), HERMES);
  assert.ok(loadConfig().gateway!.attached!["api.example.com"]);
  detach("all", loadConfig());
  assert.equal(readFileSync(join(ctx.home, ".openclaw/openclaw.json"), "utf8"), OPENCLAW);
  assert.equal(readFileSync(join(ctx.home, ".codex/config.toml"), "utf8"), CODEX);
  assert.equal(readFileSync(join(ctx.home, ".dsh/profiles/headless/cordis.patch.yml"), "utf8"), DSH);
  assert.deepEqual(loadConfig().gateway!.attached, {});
  assert.deepEqual(readManifest(), []);
});

test("a built-in provider and a URL with credentials are skipped, with the reason", () => {
  const ctx = fixture({
    ".config/opencode/opencode.json": JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
    ".hermes/config.yaml": "model:\n  base_url: https://user:pw@api.example.com/v1\n",
  });
  const plan = planAttach(scan(ctx).agents, 4180, loadConfig());
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.skipped.map((s) => s.agent).sort(), ["hermes", "opencode"]);
  assert.match(plan.skipped.find((s) => s.agent === "opencode")!.reason, /built-in provider/);
  assert.match(plan.skipped.find((s) => s.agent === "hermes")!.reason, /credentials/);
});

test("the gateway sends an attached agent's call to its own origin, with its path, model and key", async () => {
  fixture({});
  const seen: Array<{ url: string; auth?: string; body: string }> = [];
  const upstreamPort = await listen((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ url: req.url!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") return void res.end(JSON.stringify({ data: [{ id: "their-model" }] }));
      res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }));
    });
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${upstreamPort}`;
  // Written to the config file too: the gateway re-reads attached names when the file changes.
  mkdirSync(process.env.OPENGUARDRAILS_HOME!, { recursive: true });
  const config = { gateway: { port, upstreams: {}, attached: { lab: { origin, agents: ["hermes"] } } } };
  writeFileSync(join(process.env.OPENGUARDRAILS_HOME!, "config.json"), JSON.stringify(config));
  servers.push(await startGateway(config));

  const reply = await fetch(`http://127.0.0.1:${port}/u/lab/api/v1/chat/completions?tenant=a`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer agent-own-key" },
    body: JSON.stringify({ model: "their-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(reply.status, 200);
  assert.equal(((await reply.json()) as any).choices[0].message.content, "hello");
  assert.equal(seen[0]!.url, "/api/v1/chat/completions?tenant=a");
  assert.equal(seen[0]!.auth, "Bearer agent-own-key");
  assert.equal(JSON.parse(seen[0]!.body).model, "their-model");

  const models = await fetch(`http://127.0.0.1:${port}/u/lab/api/v1/models`, { headers: { authorization: "Bearer agent-own-key" } });
  assert.deepEqual(((await models.json()) as any).data, [{ id: "their-model" }]);
  assert.equal(seen[1]!.url, "/api/v1/models");

  const unknown = await fetch(`http://127.0.0.1:${port}/u/nobody/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(unknown.status, 404);

  // Attaching another agent while the gateway runs needs no restart.
  writeFileSync(join(process.env.OPENGUARDRAILS_HOME!, "config.json"), JSON.stringify({ gateway: { ...config.gateway, attached: { ...config.gateway.attached, later: { origin, agents: ["codex"] } } } }));
  const later = await fetch(`http://127.0.0.1:${port}/u/later/v1/models`);
  assert.equal(later.status, 200);
});
