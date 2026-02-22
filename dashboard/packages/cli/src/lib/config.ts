import fs from "node:fs";
import { paths } from "./paths.js";

export interface CliConfig {
  sessionToken: string;
  port: number;
  webPort: number;
  ogCoreKey?: string;
}

const DEFAULTS: CliConfig = {
  sessionToken: "",
  port: 53667,
  webPort: 53668,
};

export function loadConfig(): CliConfig {
  if (!fs.existsSync(paths.config)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(paths.config, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(updates: Record<string, string | number>): void {
  const current = loadConfig();
  const merged = { ...current, ...updates };
  fs.mkdirSync(paths.base, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(merged, null, 2), "utf-8");
}
