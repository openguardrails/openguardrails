/**
 * `openguardrails connect`: the one thing that turns on sending context to the model. It is a command a
 * person runs, so that nothing leaves this machine because a package was installed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, homeDir, type Config } from "./config.js";
import { DEFAULT_MODEL_URL, mintKey } from "./model-api.js";

export async function connect(url: string = process.env.OPENGUARDRAILS_MODEL_URL ?? DEFAULT_MODEL_URL): Promise<number> {
  const config: Config = existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), "utf8")) : {};
  if (config.model?.apiKey || config.model?.apiKeyEnv) {
    console.log(`already connected to ${config.model.url ?? DEFAULT_MODEL_URL}. To start over, remove "model" from ${configPath()}`);
    return 0;
  }
  const minted = await mintKey(url);
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  config.model = { ...config.model, url, apiKey: minted.api_key };
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath(), 0o600);
  console.log(`connected to ${url}: ${minted.limit_per_day} judgements a day
raise your quota at ${minted.claim_url}

What the local rules cannot decide now goes to the model, with the conversation so far. Secrets are masked
first and tool output is not sent. Every request is copied to ${homeDir()}/model-requests.ndjson so you can check.
Restart the local service: openguardrails stop`);
  return 0;
}
