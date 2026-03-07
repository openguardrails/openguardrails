import type { ServerResponse } from "node:http";
import type { GatewayConfig } from "../types.js";
import { findDefaultBackend, getBackendApiType } from "../config.js";

export async function handleModelsRequest(
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  try {
    // Find an OpenAI-compatible backend for models listing
    const resolved = findDefaultBackend("openai", config);
    if (!resolved) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No OpenAI-compatible backend configured" }));
      return;
    }

    const { backend } = resolved;
    const modelsUrl = `${backend.baseUrl}/v1/models`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${backend.apiKey}`,
    };

    if (backend.referer) {
      headers["HTTP-Referer"] = backend.referer;
    }
    if (backend.title) {
      headers["X-Title"] = backend.title;
    }

    const response = await fetch(modelsUrl, { headers });
    const body = await response.text();
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(body);
  } catch (error) {
    console.error("[ai-security-gateway] Models request error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal gateway error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
