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

import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATEWAY_MODE = process.env.GATEWAY_MODE || "selfhosted";
const SHUTDOWN_TOKEN_FILE = join(homedir(), ".openclaw", "extensions", "moltguard", "data", "gateway-shutdown-token");

let config: GatewayConfig;
let currentServer: ReturnType<typeof createServer> | null = null;
let currentShutdownToken: string | null = null;

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

  // Shutdown endpoint (for graceful restart during plugin update)
  // Requires Authorization header with the shutdown token
  if (url === "/shutdown" && method === "POST") {
    const authHeader = req.headers["authorization"];
    const providedToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!currentShutdownToken || !providedToken || providedToken !== currentShutdownToken) {
      console.log("[ai-security-gateway] Shutdown request rejected: invalid or missing token");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    console.log("[ai-security-gateway] Shutdown requested with valid token, closing server...");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "shutting_down" }));
    // Close after response is sent
    setImmediate(() => {
      if (currentServer) {
        currentServer.close(() => {
          console.log("[ai-security-gateway] Server shut down via /shutdown endpoint");
          currentServer = null;
          // Clean up token file
          try {
            if (existsSync(SHUTDOWN_TOKEN_FILE)) {
              unlinkSync(SHUTDOWN_TOKEN_FILE);
            }
          } catch {
            // Ignore cleanup errors
          }
        });
      }
    });
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
        currentShutdownToken = null;
        // Clean up token file
        try {
          if (existsSync(SHUTDOWN_TOKEN_FILE)) {
            unlinkSync(SHUTDOWN_TOKEN_FILE);
          }
        } catch {
          // Ignore cleanup errors
        }
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
 * Generate and save a shutdown token for graceful restart
 */
function generateShutdownToken(): string {
  const token = randomBytes(32).toString("hex");
  try {
    const dir = join(homedir(), ".openclaw", "extensions", "moltguard", "data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(SHUTDOWN_TOKEN_FILE, token, { mode: 0o600 });
  } catch (err) {
    console.warn("[ai-security-gateway] Could not save shutdown token:", err);
  }
  return token;
}

/**
 * Read shutdown token from file (for requesting shutdown of old server)
 */
function readShutdownToken(): string | null {
  try {
    if (existsSync(SHUTDOWN_TOKEN_FILE)) {
      return readFileSync(SHUTDOWN_TOKEN_FILE, "utf-8").trim();
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Request shutdown of an existing gateway server on the same port
 * Uses shutdown token stored in file for authentication
 */
async function requestShutdown(port: number): Promise<boolean> {
  const token = readShutdownToken();
  if (!token) {
    console.log("[ai-security-gateway] No shutdown token found, cannot request graceful shutdown");
    return false;
  }

  try {
    console.log(`[ai-security-gateway] Requesting shutdown of existing server on port ${port}...`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      console.log("[ai-security-gateway] Shutdown request accepted, waiting for server to close...");
      // Wait for the old server to actually close
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    }
    return false;
  } catch {
    // Server might not support /shutdown or is not responding
    return false;
  }
}

/**
 * Start gateway server
 * @param configPath - Path to config file
 * @param embedded - If true, don't call process.exit on errors (for in-process use)
 */
export function startGateway(configPath?: string, embedded = false): void {
  // Stop existing server if running (same process)
  if (currentServer) {
    console.log("[ai-security-gateway] Stopping existing server for restart...");
    currentServer.close();
    currentServer = null;
  }

  // Internal function to do the actual startup
  const doStart = (retryCount = 0): void => {
    try {
      // Load and validate configuration
      config = loadConfig(configPath);
      validateConfig(config);

      if (retryCount === 0) {
        console.log("[ai-security-gateway] Configuration loaded:");
        console.log(`  Mode: ${GATEWAY_MODE}`);
        console.log(`  Port: ${config.port}`);
        console.log(
          `  Backends: ${Object.keys(config.backends).join(", ") || "(none)"}`,
        );
      }

      // Create HTTP server
      const server = createServer(handleRequest);
      currentServer = server;

      // Handle server errors (including EADDRINUSE)
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retryCount < 2) {
          console.log(`[ai-security-gateway] Port ${config.port} in use, attempting graceful takeover...`);
          currentServer = null;

          // Try to request shutdown from the old server
          requestShutdown(config.port).then((success) => {
            if (success) {
              console.log("[ai-security-gateway] Old server shut down, retrying startup...");
              doStart(retryCount + 1);
            } else {
              // Old server didn't respond to shutdown, might be a different process
              console.error(`[ai-security-gateway] Could not shut down existing server on port ${config.port}`);
              console.error("[ai-security-gateway] Another process may be using this port");
              if (!embedded) {
                process.exit(1);
              }
            }
          });
        } else {
          console.error("[ai-security-gateway] Server error:", err);
          currentServer = null;
          if (!embedded) {
            process.exit(1);
          }
          throw err;
        }
      });

      // Start listening
      server.listen(config.port, "127.0.0.1", () => {
        // Generate shutdown token for graceful restart
        currentShutdownToken = generateShutdownToken();

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
      });

      // Only register shutdown handlers if not embedded
      if (!embedded) {
        // Handle shutdown
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
      // In embedded mode, just throw the error so the caller can handle it
      throw error;
    }
  };

  doStart();
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
