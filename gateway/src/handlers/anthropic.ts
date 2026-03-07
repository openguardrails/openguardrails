/**
 * AI Security Gateway - Anthropic Messages API handler
 *
 * Handles POST /v1/messages requests in Anthropic's native format.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendConfig, MappingTable } from "../types.js";
import { sanitize } from "../sanitizer.js";
import { restore, createStreamRestorer } from "../restorer.js";
import { generateRequestId, logSanitizeEvent, logRestoreEvent } from "../activity.js";

/**
 * Handle Anthropic API request
 */
export async function handleAnthropicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: BackendConfig,
): Promise<void> {
  try {
    const requestId = generateRequestId();
    const sanitizeStart = Date.now();

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
    const { sanitized: sanitizedMessages, mappingTable, redactionCount } = sanitize(messages);

    // 3. Sanitize system prompt if present
    let systemRedactionCount = 0;
    const sanitizedSystem = system
      ? (() => {
          const result = sanitize(system);
          systemRedactionCount = result.redactionCount;
          return result.sanitized;
        })()
      : system;

    const totalRedactionCount = redactionCount + systemRedactionCount;

    // Log sanitization event
    if (totalRedactionCount > 0) {
      logSanitizeEvent({
        requestId,
        backend: "anthropic",
        endpoint: "/v1/messages",
        model,
        mappingTable,
        redactionCount: totalRedactionCount,
        durationMs: Date.now() - sanitizeStart,
      });
    }

    // Note: We reuse the same mapping table so placeholders are consistent

    // Debug: log what was sanitized
    if (totalRedactionCount > 0) {
      console.log(`[ai-security-gateway] Sanitized ${totalRedactionCount} items`);
    }

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

    // 5. Forward to real Anthropic API
    // Note: baseUrl already includes the full path prefix (e.g., /v1)
    const apiUrl = `${backend.baseUrl}/messages`;
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

    // 7. Handle streaming or non-streaming response
    if (stream) {
      await handleAnthropicStream(response, res, mappingTable, requestId, model);
    } else {
      await handleAnthropicNonStream(response, res, mappingTable, requestId, model);
    }
  } catch (error) {
    console.error("[ai-security-gateway] Anthropic handler error:", error);
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
 * Handle streaming response with smart placeholder restoration
 *
 * Uses StreamRestorer to detect `__` and buffer potential placeholders.
 * Only buffers when necessary, maintaining streaming UX.
 */
async function handleAnthropicStream(
  response: Response,
  res: ServerResponse,
  mappingTable: MappingTable,
  requestId: string,
  model?: string,
): Promise<void> {
  const restoreStart = Date.now();

  // Debug: log mapping table size
  if (mappingTable.size > 0) {
    console.log(`[ai-security-gateway] Streaming with ${mappingTable.size} placeholders to restore`);
  }

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
  let lineBuffer = "";

  // Create stream restorer for text content
  const streamRestorer = createStreamRestorer(mappingTable);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode chunk
      lineBuffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) {
          res.write("\n");
          continue;
        }

        // Handle event lines (pass through)
        if (line.startsWith("event:")) {
          res.write(line + "\n");
          continue;
        }

        // Handle data lines
        if (!line.startsWith("data: ")) {
          res.write(line + "\n");
          continue;
        }

        const dataContent = line.slice(6);

        try {
          const parsed = JSON.parse(dataContent) as AnthropicSSEChunk;

          // Check for text delta
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
            const textContent = parsed.delta.text;

            if (textContent !== undefined && mappingTable.size > 0) {
              // Process text through stream restorer
              const restored = streamRestorer.process(textContent);

              if (restored.length > 0) {
                // We have restorable content - output it
                const restoredChunk = {
                  ...parsed,
                  delta: { ...parsed.delta, text: restored },
                };
                res.write(`data: ${JSON.stringify(restoredChunk)}\n`);
              }
              // If restorer is buffering, don't output anything yet
            } else {
              // No text content or no mappings - pass through
              res.write(line + "\n");
            }
          } else {
            // Non-text events - pass through
            res.write(line + "\n");
          }
        } catch {
          // Not valid JSON, pass through
          res.write(line + "\n");
        }
      }
    }

    // Write any remaining line buffer
    if (lineBuffer.trim()) {
      res.write(lineBuffer + "\n");
    }

    // Finalize stream restorer - flush any remaining buffered content
    const finalContent = streamRestorer.finalize();
    if (finalContent.length > 0) {
      // Create a final text delta chunk with remaining content
      const finalChunk: AnthropicSSEChunk = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: finalContent },
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n`);
    }

    // Log restoration event
    if (mappingTable.size > 0) {
      logRestoreEvent({
        requestId,
        backend: "anthropic",
        endpoint: "/v1/messages",
        model,
        mappingTable,
        restorationCount: mappingTable.size,
        durationMs: Date.now() - restoreStart,
      });
    }

    res.end();
  } catch (error) {
    console.error("[ai-security-gateway] Stream error:", error);
    res.end();
  }
}

/**
 * Anthropic SSE chunk structure
 */
interface AnthropicSSEChunk {
  type: string;
  index?: number;
  delta?: {
    type: string;
    text?: string;
  };
  [key: string]: unknown;
}

/**
 * Handle non-streaming response
 */
async function handleAnthropicNonStream(
  response: Response,
  res: ServerResponse,
  mappingTable: MappingTable,
  requestId: string,
  model?: string,
): Promise<void> {
  const restoreStart = Date.now();
  const responseBody = await response.text();
  const responseData = JSON.parse(responseBody);

  // Restore placeholders in response
  const restoredData = restore(responseData, mappingTable);

  // Log restoration event
  if (mappingTable.size > 0) {
    logRestoreEvent({
      requestId,
      backend: "anthropic",
      endpoint: "/v1/messages",
      model,
      mappingTable,
      restorationCount: mappingTable.size,
      durationMs: Date.now() - restoreStart,
    });
  }

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
