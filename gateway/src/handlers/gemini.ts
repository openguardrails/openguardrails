/**
 * AI Security Gateway - Google Gemini API handler
 *
 * Handles POST /v1/models/:model:generateContent requests in Gemini's format.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendConfig, MappingTable } from "../types.js";
import { sanitize } from "../sanitizer.js";
import { restore } from "../restorer.js";
import { generateRequestId, logSanitizeEvent, logRestoreEvent } from "../activity.js";

/**
 * Handle Gemini API request
 */
export async function handleGeminiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: BackendConfig,
  modelName: string,
): Promise<void> {
  try {
    const requestId = generateRequestId();
    const sanitizeStart = Date.now();

    // 1. Parse request body
    const body = await readBody(req);
    const requestData = JSON.parse(body);

    const { contents, tools, generationConfig, ...rest } = requestData;

    // 2. Sanitize contents (Gemini uses "contents" instead of "messages")
    const { sanitized: sanitizedContents, mappingTable, redactionCount } = sanitize(contents);

    // Log sanitization event
    if (redactionCount > 0) {
      logSanitizeEvent({
        requestId,
        backend: "gemini",
        endpoint: `/v1/models/${modelName}:generateContent`,
        model: modelName,
        mappingTable,
        redactionCount,
        durationMs: Date.now() - sanitizeStart,
      });
    }

    // 3. Build sanitized request
    const sanitizedRequest = {
      contents: sanitizedContents,
      ...(tools && { tools }),
      ...(generationConfig && { generationConfig }),
      ...rest,
    };

    // 4. Forward to Gemini API
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
    const restoreStart = Date.now();
    const responseBody = await response.text();
    const responseData = JSON.parse(responseBody);

    // Restore placeholders in response
    const restoredData = restore(responseData, mappingTable);

    // Log restoration event
    if (mappingTable.size > 0) {
      logRestoreEvent({
        requestId,
        backend: "gemini",
        endpoint: `/v1/models/${modelName}:generateContent`,
        model: modelName,
        mappingTable,
        restorationCount: mappingTable.size,
        durationMs: Date.now() - restoreStart,
      });
    }

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
