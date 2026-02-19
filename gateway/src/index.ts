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
import { loadConfig, validateConfig } from "./config.js";
import type { GatewayConfig } from "./types.js";
import { handleAnthropicRequest } from "./handlers/anthropic.js";
import { handleOpenAIRequest } from "./handlers/openai.js";
import { handleGeminiRequest } from "./handlers/gemini.js";

const GATEWAY_MODE = process.env.GATEWAY_MODE || "selfhosted";

let config: GatewayConfig;

/**
 * Main request handler
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { method, url } = req;

  // Log request
  console.log(`[ai-security-gateway] ${method} ${url}`);

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

  // Only allow POST for API endpoints
  if (method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Route to appropriate handler
  try {
    if (url === "/v1/messages") {
      // Anthropic Messages API
      await handleAnthropicRequest(req, res, config);
    } else if (url === "/v1/chat/completions") {
      // OpenAI Chat Completions API
      await handleOpenAIRequest(req, res, config);
    } else if (url?.match(/^\/v1\/models\/(.+):generateContent$/)) {
      // Gemini API
      const match = url.match(/^\/v1\/models\/(.+):generateContent$/);
      const modelName = match?.[1];
      if (modelName) {
        await handleGeminiRequest(req, res, config, modelName);
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
 * Start gateway server
 */
export function startGateway(configPath?: string): void {
  try {
    // Load and validate configuration
    config = loadConfig(configPath);
    validateConfig(config);

    console.log("[ai-security-gateway] Configuration loaded:");
    console.log(`  Mode: ${GATEWAY_MODE}`);
    console.log(`  Port: ${config.port}`);
    console.log(
      `  Backends: ${Object.keys(config.backends).join(", ")}`,
    );

    // Create HTTP server
    const server = createServer(handleRequest);

    // Start listening
    server.listen(config.port, "127.0.0.1", () => {
      console.log(
        `[ai-security-gateway] Server listening on http://127.0.0.1:${config.port}`,
      );
      console.log("[ai-security-gateway] Ready to proxy requests");
      console.log("");
      console.log("Endpoints:");
      console.log(`  POST http://127.0.0.1:${config.port}/v1/messages - Anthropic`);
      console.log(`  POST http://127.0.0.1:${config.port}/v1/chat/completions - OpenAI`);
      console.log(`  POST http://127.0.0.1:${config.port}/v1/models/:model:generateContent - Gemini`);
      console.log(`  GET  http://127.0.0.1:${config.port}/health - Health check`);
    });

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
  } catch (error) {
    console.error("[ai-security-gateway] Failed to start:", error);
    process.exit(1);
  }
}

// Re-export for programmatic use
export { sanitize, sanitizeMessages } from "./sanitizer.js";
export { restore, restoreJSON, restoreSSELine } from "./restorer.js";
export type { GatewayConfig, MappingTable, SanitizeResult, EntityMatch } from "./types.js";

// Start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = process.argv[2];
  startGateway(configPath);
}
