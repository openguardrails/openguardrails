/** Starting, stopping and checking the gateway, a background process every `openguardrails run` shares. */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, DEFAULT_PORT, loadConfig, looseConfigWarning, homeDir, secretOf, type Config } from "./config.js";
import { startGateway } from "./gateway.js";
import { modelTarget } from "./model-api.js";

export const gatewayPort = (config: Config) => config.gateway?.port ?? DEFAULT_PORT;

/** Proves a caller is `openguardrails run`. The file sits where the sandbox cannot read. */
export const gatewayToken = (): string => {
  try {
    return readFileSync(join(homeDir(), "gateway.token"), "utf8").trim();
  } catch {
    return "";
  }
};

export async function gatewayHealth(port: number): Promise<Record<string, any> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__ogr/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? ((await response.json()) as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * Agents' shells often skip ~/.zshrc, so a key exported there looks unset. Asking the user's own
 * shell finds it without copying a secret into another file.
 */
export function hydrateEnv(config: Config): void {
  const names = [config.airs?.apiKeyEnv, config.model?.apiKeyEnv, "OPENGUARDRAILS_API_KEY", ...Object.values(config.gateway?.upstreams ?? {}).map((upstream) => upstream.apiKeyEnv)];
  for (const name of new Set(names.filter((value): value is string => Boolean(value)))) {
    if (process.env[name] || !/^\w+$/.test(name)) continue;
    try {
      const shell = process.env.SHELL ?? "/bin/sh";
      const out = execFileSync(shell, ["-ilc", `printf '\\n__OGR__%s' "$${name}"`], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
      const value = out.split("__OGR__").at(-1)?.trim();
      if (value) process.env[name] = value;
    } catch {
      // `openguardrails status` reports the key as missing.
    }
  }
}

export async function serve(): Promise<number> {
  const config = loadConfig();
  hydrateEnv(config);
  const warning = looseConfigWarning(config);
  if (warning) process.stderr.write(`[openguardrails] ${warning}\n`);
  await startGateway(config);
  process.stderr.write(`[openguardrails] listening on http://127.0.0.1:${gatewayPort(config)}\n`);
  return new Promise<number>(() => undefined);
}

/** Starts the gateway if it is not up. It outlives the run, because other runs may be using it. */
export async function ensureGateway(config: Config): Promise<void> {
  const port = gatewayPort(config);
  if (await gatewayHealth(port)) return;
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const logPath = join(homeDir(), "serve.log");
  const logFile = openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [process.argv[1]!, "serve"], { detached: true, stdio: ["ignore", logFile, logFile] });
  child.unref();
  closeSync(logFile);
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await gatewayHealth(port)) return;
  }
  throw new Error(`the gateway did not start on port ${port}. See ${logPath}`);
}

export async function stop(): Promise<number> {
  const health = await gatewayHealth(gatewayPort(loadConfig()));
  if (!health) {
    console.log("gateway: not running");
    return 0;
  }
  process.kill(health.pid as number, "SIGTERM");
  console.log(`gateway: stopped (pid ${health.pid})`);
  return 0;
}

/** Every line answers one question, and the exit code says whether anything needs fixing. */
export async function status(): Promise<number> {
  const config = loadConfig();
  hydrateEnv(config);
  let problems = 0;
  const line = (ok: boolean | null, text: string) => {
    if (ok === false) problems += 1;
    console.log(`${ok === null ? "--  " : ok ? "ok  " : "FAIL"} ${text}`);
  };
  line(null, `config ${configPath()}`);
  const warning = looseConfigWarning(config);
  if (warning) line(false, warning);

  const port = gatewayPort(config);
  const health = await gatewayHealth(port);
  line(null, `local service http://127.0.0.1:${port}${health ? `, running, pid ${health.pid}` : " is not running; `openguardrails serve` starts it"}`);
  if (config.gateway) {
    line(null, `model gateway base URL http://127.0.0.1:${port}/v1, ${health?.served ?? 0} requests served`);
    for (const [route, members] of Object.entries(config.gateway.routes ?? {})) line(null, `model "${route}" tries ${members.join(" -> ")}`);
    if (health?.last_failover) line(null, `last failover ${JSON.stringify(health.last_failover)}`);
    for (const [name, upstream] of Object.entries(config.gateway.upstreams)) {
      if (upstream.apiKeyEnv && !secretOf(upstream)) line(false, `${name}: ${upstream.apiKeyEnv} is not set`);
      try {
        const key = secretOf(upstream);
        const response = await fetch(`${upstream.baseURL.replace(/\/$/, "")}/models`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        // Some APIs have no /models; only unreachable or a server error says the upstream is down.
        line(response.status < 500, `${name} (${upstream.model}) at ${upstream.baseURL}: HTTP ${response.status}`);
      } catch (error) {
        // One dead member is what a route exists for, so this is reported and is not a failure.
        const inRoute = Object.values(config.gateway.routes ?? {}).some((members) => members.includes(name) && members.length > 1);
        line(inRoute ? null : false, `${name} (${upstream.model}) at ${upstream.baseURL}: unreachable${inRoute ? ", its route will fail over" : ""} (${(error as { cause?: { code?: string } }).cause?.code ?? String(error)})`);
      }
    }
  } else {
    line(null, "no gateway configured");
  }

  const model = modelTarget(config);
  line(null, model ? `model API at ${model.url}: what the rules cannot decide is judged` : "model API: no key, so what the rules cannot decide is reported unjudged and left to the agent's own permission check");

  if (config.airs) {
    const key = secretOf(config.airs);
    if (!key) {
      line(false, `AIRS: ${config.airs.apiKeyEnv ?? "apiKey"} is not set, so nothing is being judged`);
    } else {
      try {
        const response = await fetch(`${config.airs.url.replace(/\/$/, "")}/v1/limits`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(8000),
        });
        line(response.ok, `AIRS at ${config.airs.url}: key ${response.ok ? "accepted" : `refused, HTTP ${response.status}`}`);
      } catch (error) {
        line(false, `AIRS at ${config.airs.url}: unreachable (${String(error)})`);
      }
    }
  } else {
    line(null, "AIRS: not connected");
  }
  return problems === 0 ? 0 : 1;
}
