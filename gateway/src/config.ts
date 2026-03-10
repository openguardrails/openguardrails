/**
 * Gateway configuration management
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig, ApiType } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".openclaw", "extensions", "moltguard", "data", "gateway.json");

/**
 * Load gateway configuration from file or environment
 */
export function loadConfig(configPath?: string): GatewayConfig {
  const path = configPath || DEFAULT_CONFIG_PATH;

  // Default configuration
  const defaultConfig: GatewayConfig = {
    port: parseInt(process.env.GATEWAY_PORT || "53669", 10),
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
        `[ai-security-gateway] Failed to load config from ${path}:`,
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
      type: "anthropic",
    };
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    config.backends.openai = {
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
      apiKey: process.env.OPENAI_API_KEY,
      type: "openai",
    };
  }

  // Kimi (Moonshot) — only set if openai backend not already configured
  if (
    (process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY) &&
    !config.backends.openai
  ) {
    config.backends.kimi = {
      baseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn",
      apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || "",
      type: "openai",
    };
  }

  // Gemini
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    config.backends.gemini = {
      baseUrl:
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
      type: "gemini",
    };
  }

  // OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    config.backends.openrouter = {
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api",
      apiKey: process.env.OPENROUTER_API_KEY,
      type: "openai",
      ...(process.env.OPENROUTER_REFERER && {
        referer: process.env.OPENROUTER_REFERER,
      }),
      ...(process.env.OPENROUTER_TITLE && {
        title: process.env.OPENROUTER_TITLE,
      }),
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
    defaultBackends: fileConfig.defaultBackends,
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

/**
 * Infer API type from backend name
 */
export function inferApiType(name: string): ApiType {
  const lower = name.toLowerCase();
  if (lower.includes("anthropic") || lower.includes("claude")) {
    return "anthropic";
  }
  if (lower.includes("gemini") || lower.includes("google")) {
    return "gemini";
  }
  // Default to OpenAI-compatible for everything else
  return "openai";
}

/**
 * Get API type for a backend
 */
export function getBackendApiType(name: string, config: GatewayConfig): ApiType {
  const backend = config.backends[name];
  if (backend?.type) {
    return backend.type;
  }
  return inferApiType(name);
}

/**
 * Find backend by API key
 */
export function findBackendByApiKey(
  apiKey: string,
  config: GatewayConfig,
): { name: string; backend: typeof config.backends[string] } | null {
  for (const [name, backend] of Object.entries(config.backends)) {
    if (backend.apiKey === apiKey) {
      return { name, backend };
    }
  }
  return null;
}

/**
 * Find default backend for an API type
 */
export function findDefaultBackend(
  apiType: ApiType,
  config: GatewayConfig,
): { name: string; backend: typeof config.backends[string] } | null {
  // Check explicit default first
  const defaultName = config.defaultBackends?.[apiType];
  if (defaultName && config.backends[defaultName]) {
    return { name: defaultName, backend: config.backends[defaultName] };
  }

  // Find first backend matching the API type
  for (const [name, backend] of Object.entries(config.backends)) {
    if (getBackendApiType(name, config) === apiType) {
      return { name, backend };
    }
  }

  return null;
}

/**
 * Find backend by request path prefix
 * Matches the longest pathPrefix that is a prefix of the request path
 */
export function findBackendByPathPrefix(
  requestPath: string,
  config: GatewayConfig,
): { name: string; backend: typeof config.backends[string] } | null {
  let bestMatch: { name: string; backend: typeof config.backends[string] } | null = null;
  let bestMatchLength = 0;

  for (const [name, backend] of Object.entries(config.backends)) {
    if (backend.pathPrefix && requestPath.startsWith(backend.pathPrefix)) {
      if (backend.pathPrefix.length > bestMatchLength) {
        bestMatch = { name, backend };
        bestMatchLength = backend.pathPrefix.length;
      }
    }
  }

  return bestMatch;
}

/**
 * Find backend by model name
 */
export function findBackendByModel(
  modelName: string,
  config: GatewayConfig,
): { name: string; backend: typeof config.backends[string] } | null {
  for (const [name, backend] of Object.entries(config.backends)) {
    if (backend.models?.includes(modelName)) {
      return { name, backend };
    }
  }
  return null;
}
