/**
 * AI Security Gateway - OpenAI Chat Completions API handler
 *
 * Handles POST /v1/chat/completions requests in OpenAI's format.
 * Also compatible with OpenAI-compatible APIs (Kimi, DeepSeek, etc.)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig, MappingTable } from "../types.js";
import { sanitize } from "../sanitizer.js";
import { restore, restoreSSELine } from "../restorer.js";

/**
 * Handle OpenAI API request
 */
export async function handleOpenAIRequest(
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
      tools,
      tool_choice,
      temperature,
      max_tokens,
      stream = false,
      ...rest
    } = requestData;

    // 2. Sanitize messages
    const { sanitized: sanitizedMessages, mappingTable } = sanitize(messages);

    // 3. Build sanitized request
    const sanitizedRequest = {
      model,
      messages: sanitizedMessages,
      ...(tools && { tools }),
      ...(tool_choice && { tool_choice }),
      ...(temperature !== undefined && { temperature }),
      ...(max_tokens && { max_tokens }),
      stream,
      ...rest,
    };

    // 4. Get backend config
    const backend = config.backends.openai;
    if (!backend) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "OpenAI backend not configured" }));
      return;
    }

    // 5. Forward to OpenAI (or compatible) API
    const apiUrl = `${backend.baseUrl}/v1/chat/completions`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${backend.apiKey}`,
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

    // 6. Handle streaming or non-streaming response
    if (stream) {
      await handleOpenAIStream(response, res, mappingTable);
    } else {
      await handleOpenAINonStream(response, res, mappingTable);
    }
  } catch (error) {
    console.error("[ai-security-gateway] OpenAI handler error:", error);
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
 * Handle streaming response (SSE)
 */
async function handleOpenAIStream(
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
async function handleOpenAINonStream(
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
