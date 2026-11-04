/**
 * SSE keep-alive for streamed replies. A model that thinks for a while, a queue for a busy upstream,
 * or the gateway holding back a tool call to judge it can leave a stream silent for longer than a
 * client waits; voicego's own model gateway sent a comment every 15 s for that reason. A comment
 * line is ignored by every SSE client, but only between events: one written into the middle of an
 * event would corrupt it, so it is sent only when the last bytes out ended an event.
 */
import type { ServerResponse } from "node:http";

export const KEEPALIVE = ": keep-alive\n\n";

export function sseKeepAlive(res: ServerResponse, everyMs = 15_000): void {
  let timer: NodeJS.Timeout | null = null;
  let last = Date.now();
  let atBoundary = true;
  const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((...args: unknown[]) => {
    const result = writeHead(...args);
    const type = String(res.getHeader("content-type") ?? findType(args) ?? "");
    if (type.includes("text/event-stream") && !timer) {
      timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return stop();
        if (atBoundary && Date.now() - last >= everyMs) {
          write(KEEPALIVE);
          last = Date.now();
        }
      }, Math.min(everyMs, 1000));
      timer.unref();
    }
    return result;
  }) as typeof res.writeHead;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("latin1") : "";
    if (text.length > 0) {
      last = Date.now();
      atBoundary = text.endsWith("\n\n") || text.endsWith("\r\n\r\n");
    }
    return write(chunk, ...rest);
  }) as typeof res.write;
  res.once("close", stop);
  res.once("finish", stop);
}

function findType(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg && typeof arg === "object" && !Array.isArray(arg)) {
      for (const [key, value] of Object.entries(arg as Record<string, unknown>)) if (key.toLowerCase() === "content-type") return String(value);
    }
  }
  return undefined;
}
