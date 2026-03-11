#!/usr/bin/env node
/**
 * OpenGuardrails AI Security Gateway
 *
 * Local HTTP proxy that intercepts LLM API calls, sanitizes sensitive data
 * before sending to providers, and restores it in responses.
 * Supports Anthropic, OpenAI, and Gemini protocols.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, validateConfig, findBackendByApiKey, findDefaultBackend, findBackendByPathPrefix, getBackendApiType } from "./config.js";
import type { GatewayConfig, BackendConfig, ApiType } from "./types.js";
import { handleAnthropicRequest } from "./handlers/anthropic.js";
import { handleOpenAIRequest } from "./handlers/openai.js";
import { handleGeminiRequest } from "./handlers/gemini.js";
import { handleModelsRequest } from "./handlers/models.js";

let config: GatewayConfig;
let currentServer: ReturnType<typeof createServer> | null = null;

/**
 * Extract API key from request headers
 */
function extractApiKey(req: IncomingMessage): string | null {
  // Try x-api-key header (Anthropic style)
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey && typeof xApiKey === "string") {
    return xApiKey;
  }

  // Try Authorization: Bearer (OpenAI style)
  const auth = req.headers["authorization"];
  if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  // Try x-goog-api-key (Gemini style)
  const googKey = req.headers["x-goog-api-key"];
  if (googKey && typeof googKey === "string") {
    return googKey;
  }

  return null;
}

/**
 * Resolve backend for a request based on path prefix, API key, or defaults
 * Priority: pathPrefix > apiKey > defaultBackend
 */
function resolveBackend(
  req: IncomingMessage,
  apiType: ApiType,
): { name: string; backend: BackendConfig } | null {
  const url = req.url || "";

  // 1. Try to find backend by path prefix (most specific)
  const byPath = findBackendByPathPrefix(url, config);
  if (byPath) {
    return byPath;
  }

  // 2. Try to find backend by API key
  const apiKey = extractApiKey(req);
  if (apiKey) {
    const byKey = findBackendByApiKey(apiKey, config);
    if (byKey) {
      return byKey;
    }
  }

  // 3. Fall back to default backend for the API type
  return findDefaultBackend(apiType, config);
}

/**
 * Main request handler
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { method, url } = req;

  // Log request (skip health checks to reduce noise)
  if (url !== "/health") {
    console.log(`[ai-security-gateway] ${method} ${url}`);
  }

  // CORS headers (for browser-based clients)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");

  // Handle OPTIONS for CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (allow GET)
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
    return;
  }

  // Handle GET /v1/models — proxy to configured backend's models endpoint
  if (method === "GET" && url === "/v1/models") {
    await handleModelsRequest(res, config);
    return;
  }

  // Only allow POST for API endpoints
  if (method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Route to appropriate handler based on path suffix
  // This allows flexible path prefixes (e.g., /v1/coding/chat/completions)
  try {
    if (url?.endsWith("/messages")) {
      // Anthropic Messages API (matches /v1/messages, /v1/xxx/messages, etc.)
      const resolved = resolveBackend(req, "anthropic");
      if (!resolved) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No Anthropic-compatible backend configured" }));
        return;
      }
      await handleAnthropicRequest(req, res, resolved.backend);
    } else if (url?.endsWith("/chat/completions")) {
      // OpenAI/OpenRouter Chat Completions API
      // Try to extract backend name from URL: /backend/{name}/chat/completions
      const backendMatch = url.match(/^\/backend\/([^/]+)\//);
      let resolved: { name: string; backend: BackendConfig } | null = null;

      if (backendMatch) {
        const backendName = backendMatch[1];
        const backend = config.backends[backendName];
        if (backend) {
          resolved = { name: backendName, backend };
          console.log(`[ai-security-gateway] Backend from URL: ${backendName}`);
        }
      }

      // Fallback to path prefix or default
      if (!resolved) {
        resolved = resolveBackend(req, "openai");
        console.log(`[ai-security-gateway] Resolved backend: ${resolved?.name}`);
      }

      // Check explicit routing config
      const explicitBackendName = config.routing?.["/v1/chat/completions"];
      const backend = explicitBackendName
        ? config.backends[explicitBackendName]
        : resolved?.backend;

      if (!backend) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No OpenAI-compatible backend configured" }));
        return;
      }

      const extraHeaders: Record<string, string> = {};
      if (backend.referer) {
        extraHeaders["HTTP-Referer"] = backend.referer;
      }
      if (backend.title) {
        extraHeaders["X-Title"] = backend.title;
      }
      await handleOpenAIRequest(req, res, backend, extraHeaders);
    } else if (url?.match(/\/models\/(.+):generateContent$/)) {
      // Gemini API (matches any path ending with /models/{model}:generateContent)
      const match = url.match(/\/models\/(.+):generateContent$/);
      const modelName = match?.[1];
      if (modelName) {
        const resolved = resolveBackend(req, "gemini");
        if (!resolved) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No Gemini backend configured" }));
          return;
        }
        await handleGeminiRequest(req, res, resolved.backend, modelName);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Model name required" }));
      }
    } else {
      // Unknown endpoint
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", url }));
    }
  } catch (error) {
    console.error("[ai-security-gateway] Request handler error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Stop the gateway server
 */
export function stopGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (currentServer) {
      currentServer.close(() => {
        currentServer = null;
        console.log("[ai-security-gateway] Server stopped");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Check if gateway is running
 */
export function isGatewayServerRunning(): boolean {
  return currentServer !== null;
}

/**
 * Start gateway server
 * @param configPath - Path to config file
 * @param embedded - If true, don't call process.exit on errors (for in-process use)
 */
export function startGateway(configPath?: string, embedded = false): void {
  // Stop existing server if running (same process)
  if (currentServer) {
    if (!embedded) console.log("[ai-security-gateway] Stopping existing server for restart...");
    currentServer.close();
    currentServer = null;
  }

  try {
    // Load and validate configuration
    config = loadConfig(configPath);
    validateConfig(config);

    if (!embedded) {
      console.log("[ai-security-gateway] Configuration loaded:");
      console.log(`  Port: ${config.port}`);
      console.log(
        `  Backends: ${Object.keys(config.backends).join(", ") || "(none)"}`,
      );
    }

    // Create HTTP server
    const server = createServer(handleRequest);
    currentServer = server;

    // Handle server errors — in embedded mode, never throw (prevents uncaught exceptions)
    server.on("error", (err: NodeJS.ErrnoException) => {
      console.error("[ai-security-gateway] Server error:", err);
      currentServer = null;
      if (!embedded) {
        process.exit(1);
      }
    });

    // Start listening
    server.listen(config.port, "127.0.0.1", () => {
      if (!embedded) {
        console.log(
          `[ai-security-gateway] Server listening on http://127.0.0.1:${config.port}`,
        );
        console.log("[ai-security-gateway] Ready to proxy requests");
        console.log("");
        console.log("Endpoints:");
        console.log(`  POST http://127.0.0.1:${config.port}/v1/messages - Anthropic`);
        console.log(`  POST http://127.0.0.1:${config.port}/v1/chat/completions - OpenAI / OpenRouter`);
        console.log(`  POST http://127.0.0.1:${config.port}/v1/models/:model:generateContent - Gemini`);
        console.log(`  GET  http://127.0.0.1:${config.port}/v1/models - List models (OpenAI / OpenRouter)`);
        console.log(`  GET  http://127.0.0.1:${config.port}/health - Health check`);
      }
    });

    // In embedded mode, don't let the server prevent process exit
    if (embedded) {
      server.unref();
    }

    // Only register shutdown handlers if not embedded
    if (!embedded) {
      process.on("SIGINT", () => {
        console.log("\n[ai-security-gateway] Shutting down...");
        server.close(() => {
          console.log("[ai-security-gateway] Server stopped");
          process.exit(0);
        });
      });

      process.on("SIGTERM", () => {
        console.log("\n[ai-security-gateway] Shutting down...");
        server.close(() => {
          console.log("[ai-security-gateway] Server stopped");
          process.exit(0);
        });
      });
    }
  } catch (error) {
    console.error("[ai-security-gateway] Failed to start:", error);
    currentServer = null;
    if (!embedded) {
      process.exit(1);
    }
    throw error;
  }
}

// Re-export for programmatic use
export { sanitize, sanitizeMessages } from "./sanitizer.js";
export { restore, restoreJSON, restoreSSELine } from "./restorer.js";
export {
  addActivityListener,
  removeActivityListener,
  clearActivityListeners,
} from "./activity.js";
// stopGateway and isGatewayServerRunning are already exported above
export type {
  GatewayConfig,
  MappingTable,
  SanitizeResult,
  EntityMatch,
  GatewayActivityEvent,
  ActivityListener,
} from "./types.js";

// Start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = process.argv[2];
  startGateway(configPath);
}
