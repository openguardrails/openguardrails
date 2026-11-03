import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { render, scan } from "../src/scan/index.js";
import { packageOf } from "../src/scan/util.js";
import type { ScanContext } from "../src/scan/types.js";

// A value under a secret-looking key, with digits so it is not taken for a placeholder.
const SECRET = "fixture0secret0value0123456789";

function home(files: Record<string, string>): ScanContext {
  const root = mkdtempSync(join(tmpdir(), "ogr-scan-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { home: root, platform: "linux", env: { PATH: "" }, gatewayPort: 4180 };
}

const byAgent = (ctx: ScanContext) => {
  const inventory = scan(ctx, new Date(0));
  return { inventory, agent: (id: string) => inventory.agents.find((agent) => agent.id === id), findings: (id: string) => inventory.findings.filter((finding) => finding.agent === id) };
};

test("nothing installed, nothing reported", () => {
  const { inventory } = byAgent(home({}));
  assert.deepEqual(inventory.agents, []);
  assert.match(render(inventory), /No agent found/);
});

test("Hermes: model, custom providers, MCP servers, grouped skills, and a plaintext key", () => {
  const ctx = home({
    ".hermes/config.yaml": [
      "model:",
      "  provider: custom",
      "  base_url: http://127.0.0.1:4180/v1",
      `  api_key: ${SECRET}`,
      "custom_providers:",
      "  - name: lab",
      "    base_url: https://user:pw@lab.example/v1?x=1",
      "    api_key: local-no-auth",
      "mcp_servers:",
      "  time:",
      "    command: uvx",
      '    args: ["mcp-server-time==1.2.0"]',
      "  github:",
      "    command: npx",
      '    args: ["-y", "@modelcontextprotocol/server-github"]',
      "    env:",
      "      GITHUB_TOKEN: ${GITHUB_TOKEN}",
      "  notion:",
      "    url: https://mcp.notion.com/mcp",
    ].join("\n"),
    ".hermes/skills/apple/apple-notes/SKILL.md": "# notes",
    ".hermes/skills/devops/deploy/SKILL.md": "# deploy",
  });
  const { agent, findings } = byAgent(ctx);
  const hermes = agent("hermes")!;
  assert.equal(hermes.kind, "personal");
  assert.equal(hermes.open_source, true);
  assert.deepEqual(hermes.models.map((model) => [model.provider, model.base_url, model.through_gateway]), [
    ["custom", "http://127.0.0.1:4180/v1", true],
    ["lab", "https://lab.example/v1", false],
  ]);
  const mcp = Object.fromEntries(hermes.components.filter((c) => c.kind === "mcp_server").map((c) => [c.name, c]));
  assert.deepEqual(mcp.time!.package, { ecosystem: "pypi", name: "mcp-server-time", version: "1.2.0", pinned: true });
  assert.deepEqual(mcp.github!.package, { ecosystem: "npm", name: "@modelcontextprotocol/server-github", pinned: false });
  assert.equal(mcp.notion!.transport, "http");
  assert.deepEqual(hermes.components.filter((c) => c.kind === "skill").map((c) => c.name).sort(), ["apple/apple-notes", "devops/deploy"]);
  assert.ok(hermes.components.every((c) => c.kind !== "skill" || /^[0-9a-f]{64}$/.test(c.sha256 ?? "")));
  const ids = findings("hermes").map((f) => `${f.id} ${f.component ?? f.location.split(": ")[1]}`);
  // Through the gateway, so no gateway finding. The env reference and the placeholder are not secrets;
  // the password inside a URL is one.
  assert.deepEqual(ids.sort(), ["config.plaintext_secret custom_providers[0].base_url", "config.plaintext_secret model.api_key", "mcp.unpinned_package github"]);
});

test("OpenClaw: JSON5 config, mcp.servers, workspace skills, plugin entries, nested secrets", () => {
  const ctx = home({
    ".openclaw/openclaw.json": `{
      // OpenClaw writes JSON5
      "models": { "providers": { "vllm": { "baseUrl": "http://10.0.0.5:8000/v1", "apiKey": "local-no-auth", } } },
      "mcp": { "servers": { "docs": { "command": "docker", "args": ["run", "-i", "--rm", "ghcr.io/acme/docs-mcp:latest"] } } },
      "channels": { "telegram": { "botToken": "${SECRET}" } },
      "agents": { "defaults": { "workspace": "~/claw" } },
      "plugins": { "entries": { "acpx": { "enabled": false } } },
    }`,
    "claw/skills/weather/SKILL.md": "# weather",
  });
  const { agent, findings } = byAgent(ctx);
  const claw = agent("openclaw")!;
  assert.deepEqual(claw.models.map((m) => [m.provider, m.through_gateway]), [["vllm", false]]);
  const docs = claw.components.find((c) => c.name === "docs")!;
  assert.deepEqual(docs.package, { ecosystem: "docker", name: "ghcr.io/acme/docs-mcp", version: "latest", pinned: false });
  assert.ok(claw.components.some((c) => c.kind === "skill" && c.name === "weather"));
  assert.ok(claw.components.some((c) => c.kind === "plugin" && c.name === "acpx" && c.enabled === false));
  const ids = findings("openclaw").map((f) => f.id).sort();
  assert.deepEqual(ids, ["config.plaintext_secret", "gateway.not_attached", "mcp.unpinned_package"]);
  assert.match(findings("openclaw").find((f) => f.id === "config.plaintext_secret")!.location, /channels\.telegram\.botToken$/);
});

test("OpenCode: a command array, a remote server, npm plugins, and the built-in provider", () => {
  const ctx = home({
    ".config/opencode/opencode.jsonc": `{
      "$schema": "https://opencode.ai/config.json",
      "mcp": {
        "fs": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem@2025.1.14", "/work"] },
        "remote": { "type": "remote", "url": "https://mcp.example.com/mcp", "enabled": false }
      },
      "plugin": ["opencode-helicone-session@0.3.1", "some-plugin"]
    }`,
  });
  const { agent, findings } = byAgent(ctx);
  const oc = agent("opencode")!;
  assert.equal(oc.kind, "coding");
  assert.deepEqual(oc.models.map((m) => m.provider), ["default"]);
  const fs = oc.components.find((c) => c.name === "fs")!;
  assert.deepEqual(fs.package, { ecosystem: "npm", name: "@modelcontextprotocol/server-filesystem", version: "2025.1.14", pinned: true });
  assert.equal(oc.components.find((c) => c.name === "remote")!.enabled, false);
  assert.deepEqual(oc.components.filter((c) => c.kind === "plugin").map((c) => [c.name, c.package?.pinned]), [["opencode-helicone-session", true], ["some-plugin", false]]);
  assert.deepEqual(findings("opencode").map((f) => f.id), ["gateway.not_attached"]);
});

test("Codex: model_providers, OPENAI_BASE_URL for the built-in one, mcp_servers and plugins", () => {
  const ctx = home({
    ".codex/config.toml": [
      'model_provider = "ogr"',
      "[model_providers.ogr]",
      'base_url = "http://localhost:4180/v1"',
      "[mcp_servers.repl]",
      'command = "node"',
      'args = ["/opt/repl/server.js"]',
      "[mcp_servers.repl.env]",
      `API_KEY = "${SECRET}"`,
      '[plugins."github@openai"]',
      "enabled = true",
    ].join("\n"),
    ".codex/skills/review/SKILL.md": "# review",
  });
  const { agent, findings } = byAgent(ctx);
  const codex = agent("codex")!;
  assert.deepEqual(codex.models.map((m) => [m.provider, m.through_gateway]), [["ogr", true]]);
  const repl = codex.components.find((c) => c.name === "repl")!;
  assert.equal(repl.package, undefined);
  assert.equal(repl.path, "/opt/repl/server.js");
  assert.ok(codex.components.some((c) => c.kind === "plugin" && c.name === "github@openai"));
  assert.ok(codex.components.some((c) => c.kind === "skill" && c.name === "review"));
  assert.deepEqual(findings("codex").map((f) => f.location.split(": ")[1]), ["mcp_servers.repl.env.API_KEY"]);

  const builtIn = home({ ".codex/config.toml": 'model = "gpt-5"\n' });
  builtIn.env.OPENAI_BASE_URL = "http://127.0.0.1:4180/v1";
  assert.deepEqual(byAgent(builtIn).agent("codex")!.models.map((m) => [m.provider, m.through_gateway, m.declared_in]), [["openai", true, "OPENAI_BASE_URL"]]);
});

test("DeepSeek Harness: one profile per directory, providers, an MCP client inside an insert, packages", () => {
  const ctx = home({
    ".dsh/profiles/headless/cordis.patch.yml": [
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      "      main:",
      "        api: openai-completions",
      "        baseURL: https://api.example.com/v1",
      "        headers:",
      `          Authorization: Bearer ${SECRET}`,
      "- insert:",
      "    - id: demo-mcp",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: demo",
      "        transport: streamable-http",
      "        url: http://127.0.0.1:3000/mcp",
    ].join("\n"),
    ".dsh/profiles/headless/package.json": JSON.stringify({ dependencies: { "@openguardrails/dsh": "1.2.3" } }),
  });
  const { agent, findings } = byAgent(ctx);
  const dsh = agent("deepseek-harness")!;
  assert.deepEqual(dsh.models.map((m) => [m.provider, m.base_url]), [["headless/main", "https://api.example.com/v1"]]);
  const demo = dsh.components.find((c) => c.kind === "mcp_server")!;
  assert.equal(demo.name, "headless/demo");
  assert.equal(demo.url, "http://127.0.0.1:3000/mcp");
  assert.ok(dsh.components.some((c) => c.kind === "plugin" && c.name === "@openguardrails/dsh" && c.package?.pinned));
  assert.deepEqual(findings("deepseek-harness").map((f) => f.id).sort(), ["config.plaintext_secret", "gateway.not_attached"]);
});

test("no output carries a secret's value", () => {
  const ctx = home({
    ".hermes/config.yaml": `model:\n  base_url: https://x.example/v1\n  api_key: ${SECRET}\n`,
    ".codex/config.toml": `[mcp_servers.a]\ncommand = "npx"\nargs = ["-y", "pkg"]\n[mcp_servers.a.env]\nTOKEN = "${SECRET}"\n`,
  });
  const inventory = scan(ctx);
  assert.ok(inventory.findings.length >= 2);
  assert.ok(!JSON.stringify(inventory).includes(SECRET));
  assert.ok(!render(inventory, ctx.home).includes(SECRET));
});

test("packageOf reads the launchers that fetch code, and nothing else", () => {
  assert.deepEqual(packageOf("npx", ["-y", "@scope/pkg@1.0.0"]), { ecosystem: "npm", name: "@scope/pkg", version: "1.0.0", pinned: true });
  assert.deepEqual(packageOf("npx", ["-y", "pkg@latest"]), { ecosystem: "npm", name: "pkg", version: "latest", pinned: false });
  assert.deepEqual(packageOf("npx", ["-y", "pkg@^1.2.0"]), { ecosystem: "npm", name: "pkg", version: "^1.2.0", pinned: false });
  assert.deepEqual(packageOf("pnpm", ["dlx", "pkg@2.0.0"]), { ecosystem: "npm", name: "pkg", version: "2.0.0", pinned: true });
  assert.deepEqual(packageOf("uvx", ["--from", "mcp-x>=1.0", "mcp-x"]), { ecosystem: "pypi", name: "mcp-x", version: "1.0", pinned: false });
  assert.deepEqual(packageOf("uv", ["tool", "run", "mcp-y==0.4.1"]), { ecosystem: "pypi", name: "mcp-y", version: "0.4.1", pinned: true });
  assert.equal(packageOf("docker", ["run", "-i", "img@sha256:abc"])?.pinned, true);
  assert.equal(packageOf("node", ["server.js"]), undefined);
  assert.equal(packageOf("C:\\Program Files\\nodejs\\npx.cmd", ["-y", "pkg@1.0.0"])?.pinned, true);
});

test("Claude Code is listed, with its MCP servers, but not something to attach", () => {
  const ctx = home({
    ".claude.json": JSON.stringify({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${SECRET}` } } },
      projects: { "/work/app": { mcpServers: { db: { command: "npx", args: ["-y", "pg-mcp"] } } } },
      oauthAccount: { emailAddress: "someone@example.com" },
    }),
    ".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, enabledPlugins: { "review@official": true } }),
    ".claude/skills/release/SKILL.md": "# release",
  });
  const { agent, findings } = byAgent(ctx);
  const cc = agent("claude-code")!;
  assert.equal(cc.protectable, false);
  assert.equal(cc.open_source, false);
  assert.deepEqual(cc.components.map((c) => `${c.kind} ${c.name}`).sort(), ["mcp_server /work/app: db", "mcp_server linear", "plugin review@official", "skill release"]);
  // Listed only: no gateway finding, but its own secrets and unpinned servers still count.
  assert.deepEqual(findings("claude-code").map((f) => f.id).sort(), ["config.plaintext_secret", "mcp.unpinned_package"]);
  assert.match(render(scan(ctx), ctx.home), /Claude Code .*listed only/);
});

test("Gemini CLI extensions and the MCP-only apps are listed", () => {
  const ctx = home({
    ".gemini/settings.json": JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["-y", "@x/fs@1.0.0"] } } }),
    ".gemini/extensions/search/gemini-extension.json": JSON.stringify({ name: "search", mcpServers: { web: { httpUrl: "https://search.example/mcp" } } }),
    ".cursor/mcp.json": JSON.stringify({ mcpServers: { notes: { url: "https://notes.example/mcp" } } }),
    ".config/Claude/claude_desktop_config.json": JSON.stringify({ mcpServers: { files: { command: "uvx", args: ["mcp-files"] } } }),
    ".config/Code/User/mcp.json": JSON.stringify({ servers: { gh: { type: "http", url: "https://api.githubcopilot.com/mcp/" } } }),
  });
  const { agent } = byAgent(ctx);
  const gem = agent("gemini-cli")!;
  assert.deepEqual(gem.components.map((c) => `${c.kind} ${c.name}`).sort(), ["mcp_server fs", "mcp_server search: web", "plugin search"]);
  assert.equal(agent("cursor")!.components[0]!.url, "https://notes.example/mcp");
  assert.equal(agent("claude-desktop")!.components[0]!.package?.name, "mcp-files");
  assert.equal(agent("vscode")!.components[0]!.transport, "http");
  assert.equal(agent("windsurf"), undefined);
  assert.ok(["gemini-cli", "cursor", "claude-desktop", "vscode"].every((id) => agent(id)!.protectable === false));
});
