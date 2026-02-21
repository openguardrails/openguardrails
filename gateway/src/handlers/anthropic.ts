/**
 * AI Security Gateway - Anthropic Messages API handler
 *
 * Handles POST /v1/messages requests in Anthropic's native format.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig, MappingTable } from "../types.js";
import { sanitize } from "../sanitizer.js";
import { restore, restoreSSELine } from "../restorer.js";

/**
 * Handle Anthropic API request
 */
export async function handleAnthropicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  try {
    // 1. Parse request body
    const body = await readBody(req);
    const requestData = JSON.parse(body);

    const {
      model,
      messages,
      system,
      tools,
      max_tokens,
      temperature,
      stream = false,
      ...rest
    } = requestData;

    // 2. Sanitize messages
    const { sanitized: sanitizedMessages, mappingTable } = sanitize(messages);

    // 3. Sanitize system prompt if present
    const sanitizedSystem = system
      ? sanitize(system).sanitized
      : system;

    // Note: We reuse the same mapping table so placeholders are consistent

    // 4. Build sanitized request
    const sanitizedRequest = {
      model,
      messages: sanitizedMessages,
      ...(system && { system: sanitizedSystem }),
      ...(tools && { tools }),
      max_tokens,
      ...(temperature !== undefined && { temperature }),
      stream,
      ...rest,
    };

    // 5. Get backend config
    const backend = config.backends.anthropic;
    if (!backend) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Anthropic backend not configured" }));
      return;
    }

    // 6. Forward to real Anthropic API
    const apiUrl = `${backend.baseUrl}/v1/messages`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": req.headers["anthropic-version"] as string || "2023-06-01",
        "x-api-key": backend.apiKey,
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

    // 7. Handle streaming response
    if (stream) {
      await handleAnthropicStream(response, res, mappingTable);
    } else {
      await handleAnthropicNonStream(response, res, mappingTable);
    }
  } catch (error) {
    console.error("[ai-security-gateway] Anthropic handler error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal gateway error",
      }),
    );
  }
}

/**
 * Handle streaming response
 */
async function handleAnthropicStream(
  response: Response,
  res: ServerResponse,
  mappingTable: MappingTable,
): Promise<void> {
  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const reader = response.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode chunk
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) {
          res.write("\n");
          continue;
        }

        // Restore placeholders in SSE line
        const restoredLine = restoreSSELine(line, mappingTable);
        res.write(restoredLine + "\n");
      }
    }

    // Write any remaining buffer
    if (buffer.trim()) {
      const restoredLine = restoreSSELine(buffer, mappingTable);
      res.write(restoredLine + "\n");
    }

    res.end();
  } catch (error) {
    console.error("[ai-security-gateway] Stream error:", error);
    res.end();
  }
}

/**
 * Handle non-streaming response
 */
async function handleAnthropicNonStream(
  response: Response,
  res: ServerResponse,
  mappingTable: MappingTable,
): Promise<void> {
  const responseBody = await response.text();
  const responseData = JSON.parse(responseBody);

  // Restore placeholders in response
  const restoredData = restore(responseData, mappingTable);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(restoredData));
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Read request body as string with a size limit to prevent DoS
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
