/**
 * AI Security Gateway - OpenAI Chat Completions API handler
 *
 * Handles POST /v1/chat/completions requests in OpenAI's format.
 * Also compatible with OpenAI-compatible APIs (Kimi, DeepSeek, etc.)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BackendConfig, MappingTable } from "../types.js";
import { sanitize } from "../sanitizer.js";
import { restore, createStreamRestorer } from "../restorer.js";
import { generateRequestId, logSanitizeEvent, logRestoreEvent } from "../activity.js";

/**
 * Handle OpenAI API request
 *
 * @param backend - Config for OpenAI-compatible backend
 * @param extraHeaders - Optional additional headers (e.g., OpenRouter attribution)
 */
export async function handleOpenAIRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backend: BackendConfig,
  extraHeaders?: Record<string, string>,
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
      tools,
      tool_choice,
      temperature,
      max_tokens,
      stream = false,
      ...rest
    } = requestData;

    // 2. Sanitize messages
    const { sanitized: sanitizedMessages, mappingTable, redactionCount } = sanitize(messages);

    // Debug: log what was sanitized
    console.log(`[ai-security-gateway] Sanitized ${redactionCount} items`);
    if (mappingTable.size > 0) {
      for (const [placeholder, original] of mappingTable.entries()) {
        console.log(`[ai-security-gateway]   ${placeholder} <- (${original.length} chars)`);
      }
    }

    // Log sanitization event
    if (redactionCount > 0) {
      logSanitizeEvent({
        requestId,
        backend: "openai",
        endpoint: "/v1/chat/completions",
        model,
        mappingTable,
        redactionCount,
        durationMs: Date.now() - sanitizeStart,
      });
    }

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

    // 4. Use provided backend config
    // Note: baseUrl already includes the full path prefix (e.g., /v1 or /v1/coding)
    const apiUrl = `${backend.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${backend.apiKey}`,
    };
    // Merge extra headers (e.g., OpenRouter attribution headers)
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
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
      await handleOpenAIStream(response, res, mappingTable, requestId, model);
    } else {
      await handleOpenAINonStream(response, res, mappingTable, requestId, model);
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
 * Handle streaming response (SSE) with smart placeholder restoration
 *
 * Uses StreamRestorer to detect `__` and buffer potential placeholders.
 * Only buffers when necessary, maintaining streaming UX.
 */
async function handleOpenAIStream(
  response: Response,
  res: ServerResponse,
  mappingTable: MappingTable,
  requestId: string,
  model?: string,
): Promise<void> {
  const restoreStart = Date.now();

  // Debug: log mapping table
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

  // Buffer for SSE chunks waiting for restoration
  const pendingChunks: Array<{ parsed: OpenAISSEChunk; originalLine: string }> = [];

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
          // Flush pending chunks before empty line
          flushPendingChunks(pendingChunks, streamRestorer, res);
          res.write("\n");
          continue;
        }

        if (!line.startsWith("data: ")) {
          res.write(line + "\n");
          continue;
        }

        const dataContent = line.slice(6);
        if (dataContent === "[DONE]") {
          // Finalize any pending content
          flushPendingChunks(pendingChunks, streamRestorer, res);
          res.write(line + "\n");
          continue;
        }

        try {
          const parsed = JSON.parse(dataContent) as OpenAISSEChunk;
          const textContent = parsed.choices?.[0]?.delta?.content;

          if (textContent !== undefined && mappingTable.size > 0) {
            // Process text through stream restorer
            const restored = streamRestorer.process(textContent);

            if (restored.length > 0) {
              // We have restorable content - flush it
              const restoredChunk = { ...parsed };
              restoredChunk.choices = parsed.choices.map((c, i) =>
                i === 0 ? { ...c, delta: { ...c.delta, content: restored } } : c
              );
              res.write(`data: ${JSON.stringify(restoredChunk)}\n`);
            }

            // If restorer is buffering, we don't output anything yet
            // Content will be output when buffer is flushed
          } else {
            // No text content or no mappings - pass through
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
      // Create a final chunk with remaining content
      const finalChunk: OpenAISSEChunk = {
        choices: [{ delta: { content: finalContent }, index: 0, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n`);
    }

    // Log restoration event
    if (mappingTable.size > 0) {
      logRestoreEvent({
        requestId,
        backend: "openai",
        endpoint: "/v1/chat/completions",
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
 * OpenAI SSE chunk structure
 */
interface OpenAISSEChunk {
  choices: Array<{
    delta: { content?: string; role?: string };
    index: number;
    finish_reason: string | null;
  }>;
  [key: string]: unknown;
}

/**
 * Flush pending chunks with restored content
 */
function flushPendingChunks(
  _pendingChunks: Array<{ parsed: OpenAISSEChunk; originalLine: string }>,
  _streamRestorer: ReturnType<typeof createStreamRestorer>,
  _res: ServerResponse,
): void {
  // Currently unused - StreamRestorer handles buffering internally
}

/**
 * Handle non-streaming response
 */
async function handleOpenAINonStream(
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
      backend: "openai",
      endpoint: "/v1/chat/completions",
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
