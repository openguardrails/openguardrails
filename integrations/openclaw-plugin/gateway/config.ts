/**
 * Gateway configuration management
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".moltguard", "gateway.json");

/**
 * Load gateway configuration from file or environment
 */
export function loadConfig(configPath?: string): GatewayConfig {
  const path = configPath || DEFAULT_CONFIG_PATH;

  // Default configuration
  const defaultConfig: GatewayConfig = {
    port: parseInt(process.env.MOLTGUARD_GATEWAY_PORT || "8900", 10),
    backends: {},
  };

  // Try to load from file
  if (existsSync(path)) {
    try {
      const fileContent = readFileSync(path, "utf-8");
      const fileConfig = JSON.parse(fileContent);
      return mergeConfig(defaultConfig, fileConfig);
    } catch (error) {
      console.warn(
        `[moltguard-gateway] Failed to load config from ${path}:`,
        error,
      );
    }
  }

  // Load from environment variables
  return loadFromEnv(defaultConfig);
}

/**
 * Load backend configs from environment variables
 */
function loadFromEnv(config: GatewayConfig): GatewayConfig {
  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    config.backends.anthropic = {
      baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    config.backends.openai = {
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  // Kimi (Moonshot)
  if (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) {
    config.backends.openai = {
      baseUrl:
        process.env.KIMI_BASE_URL || "https://api.moonshot.cn",
      apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "",
    };
  }

  // Gemini
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    config.backends.gemini = {
      baseUrl:
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
    };
  }

  return config;
}

/**
 * Merge file config with default config
 */
function mergeConfig(
  defaultConfig: GatewayConfig,
  fileConfig: Partial<GatewayConfig>,
): GatewayConfig {
  return {
    port: fileConfig.port ?? defaultConfig.port,
    backends: {
      ...defaultConfig.backends,
      ...fileConfig.backends,
    },
    routing: fileConfig.routing,
  };
}

/**
 * Validate configuration
 */
export function validateConfig(config: GatewayConfig): void {
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }

  // Note: Backends are now optional. Gateway will act as transparent proxy.
  // If no backends configured, gateway will forward requests based on routing rules
  // or pass through to the original target.

  // Validate each backend (if any)
  for (const [name, backend] of Object.entries(config.backends)) {
    if (!backend.baseUrl) {
      throw new Error(`Backend ${name} missing baseUrl`);
    }
    if (!backend.apiKey) {
      throw new Error(`Backend ${name} missing apiKey`);
    }
  }
}
