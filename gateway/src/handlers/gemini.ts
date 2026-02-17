/**
 * AI Security Gateway - Google Gemini API handler
 *
 * Handles POST /v1/models/:model:generateContent requests in Gemini's format.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig, MappingTable } from "../types.js";
import { sanitize } from "../sanitizer.js";
import { restore } from "../restorer.js";

/**
 * Handle Gemini API request
 */
export async function handleGeminiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  modelName: string,
): Promise<void> {
  try {
    // 1. Parse request body
    const body = await readBody(req);
    const requestData = JSON.parse(body);

    const { contents, tools, generationConfig, ...rest } = requestData;

    // 2. Sanitize contents (Gemini uses "contents" instead of "messages")
    const { sanitized: sanitizedContents, mappingTable } = sanitize(contents);

    // 3. Build sanitized request
    const sanitizedRequest = {
      contents: sanitizedContents,
      ...(tools && { tools }),
      ...(generationConfig && { generationConfig }),
      ...rest,
    };

    // 4. Get backend config
    const backend = config.backends.gemini;
    if (!backend) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gemini backend not configured" }));
      return;
    }

    // 5. Forward to Gemini API
    const apiUrl = `${backend.baseUrl}/v1/models/${modelName}:generateContent`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": backend.apiKey,
      },
      body: JSON.stringify(sanitizedRequest),
    });

    if (!response.ok) {
      // Forward error response
      res.writeHead(response.status, { "Content-Type": "application/json" });
      const errorBody = await response.text();
      res.end(errorBody);
      return;
    }

    // 6. Handle response (Gemini typically doesn't stream in same way)
    const responseBody = await response.text();
    const responseData = JSON.parse(responseBody);

    // Restore placeholders in response
    const restoredData = restore(responseData, mappingTable);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(restoredData));
  } catch (error) {
    console.error("[ai-security-gateway] Gemini handler error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal gateway error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Read request body as string
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
