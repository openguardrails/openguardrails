import type { ServerResponse } from "node:http";
import type { GatewayConfig } from "../types.js";

export async function handleModelsRequest(
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  try {
    let modelsUrl: string;
    let headers: Record<string, string> = {};

    if (config.backends.openrouter) {
      modelsUrl = `${config.backends.openrouter.baseUrl}/v1/models`;
      headers = {
        "Authorization": `Bearer ${config.backends.openrouter.apiKey}`,
      };
      if (config.backends.openrouter.referer) {
        headers["HTTP-Referer"] = config.backends.openrouter.referer;
      }
      if (config.backends.openrouter.title) {
        headers["X-Title"] = config.backends.openrouter.title;
      }
    } else if (config.backends.openai) {
      modelsUrl = `${config.backends.openai.baseUrl}/v1/models`;
      headers = { "Authorization": `Bearer ${config.backends.openai.apiKey}` };
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No OpenAI-compatible backend configured" }));
      return;
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
