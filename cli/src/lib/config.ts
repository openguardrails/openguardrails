import fs from "node:fs";
import { paths } from "./paths.js";

export interface CliConfig {
  dashboardPort: number;
  webPort: number;
  gatewayPort: number;
  ogCoreUrl?: string;
}

const DEFAULTS: CliConfig = {
  dashboardPort: 53667,
  webPort: 53668,
  gatewayPort: 8900,
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

export function saveConfig(updates: Partial<CliConfig>): void {
  const current = loadConfig();
  const merged = { ...current, ...updates };
  fs.mkdirSync(paths.base, { recursive: true });
  fs.writeFileSync(paths.config, JSON.stringify(merged, null, 2), "utf-8");
}
