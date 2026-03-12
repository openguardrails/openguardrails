/**
 * EventReporter - Handles batched event reporting to Core.
 *
 * Responsibilities:
 *   1. Queue non-blocking events and flush them in batches (100ms window)
 *   2. Send blocking events synchronously and return block decisions
 *   3. Handle network failures gracefully (fail-open)
 *   4. Truncate large content to avoid timeouts
 */

import type { CoreCredentials } from "./config.js";
import type { Logger } from "./types.js";
import type {
  HookType,
  HookEvent,
  HookEventData,
  EventStreamRequest,
  EventStreamResponse,
  isBlockingHook,
} from "./hook-types.js";
import { sanitizeContent } from "./sanitizer.js";

// =============================================================================
// Constants
// =============================================================================

/** Maximum content length before truncation (100KB) */
const MAX_CONTENT_LENGTH = 100 * 1024;

/** Batch flush interval in ms */
const BATCH_FLUSH_INTERVAL_MS = 100;

/** Maximum events per batch */
const MAX_BATCH_SIZE = 50;

/** Timeout for Core API calls */
const API_TIMEOUT_MS = 3000;

// =============================================================================
// Block Decision Type
// =============================================================================

export type BlockDecision = {
  block: true;
  reason: string;
  findings?: Array<{
    riskLevel: string;
    riskType: string;
    reason: string;
  }>;
};

// =============================================================================
// EventReporter Configuration
// =============================================================================

export type EventReporterConfig = {
  coreUrl: string;
  pluginVersion: string;
  /** Timeout for API calls in ms */
  timeoutMs?: number;
  /** Whether to enable batching (default: true) */
  enableBatching?: boolean;
};

// =============================================================================
// EventReporter Class
// =============================================================================

export class EventReporter {
  private config: Required<EventReporterConfig>;
  private log: Logger;
  private credentials: CoreCredentials | null = null;

  /** Sequence counter per session */
  private sessionSeq = new Map<string, number>();

  /** Run ID per session */
  private sessionRunId = new Map<string, string>();

  /** Event queue for batching */
  private queue: Array<{
    sessionKey: string;
    event: HookEvent;
  }> = [];

  /** Flush timer */
  private flushTimer: NodeJS.Timeout | null = null;

  /** Whether we're currently flushing */
  private flushing = false;

  constructor(config: EventReporterConfig, log: Logger) {
    this.config = {
      coreUrl: config.coreUrl,
      pluginVersion: config.pluginVersion,
      timeoutMs: config.timeoutMs ?? API_TIMEOUT_MS,
      enableBatching: config.enableBatching ?? true,
    };
    this.log = log;
  }

  /** Set Core credentials for authenticated API calls */
  setCredentials(credentials: CoreCredentials | null): void {
    this.credentials = credentials;
  }

  /** Set or get run ID for a session */
  setRunId(sessionKey: string, runId: string): void {
    this.sessionRunId.set(sessionKey, runId);
  }

  getRunId(sessionKey: string): string | undefined {
    return this.sessionRunId.get(sessionKey);
  }

  /** Clear session state */
  clearSession(sessionKey: string): void {
    this.sessionSeq.delete(sessionKey);
    this.sessionRunId.delete(sessionKey);
  }

  /**
   * Report an event. For blocking hooks, this is synchronous and may return
   * a block decision. For non-blocking hooks, this queues the event for batching.
   */
  async report(
    sessionKey: string,
    hookType: HookType,
    data: HookEventData,
    blocking: boolean = false,
  ): Promise<BlockDecision | undefined> {
    if (!this.credentials) {
      this.log.debug?.(`EventReporter: no credentials, skipping ${hookType}`);
      return undefined;
    }

    // Get next sequence number for this session
    const seq = this.getNextSeq(sessionKey);

    // Build the event
    const event: HookEvent = {
      seq,
      hookType,
      data: this.sanitizeEventData(data),
    };

    // Blocking hooks: send immediately and wait for response
    if (blocking) {
      return this.reportSync(sessionKey, event);
    }

    // Non-blocking hooks: queue for batching
    this.queueEvent(sessionKey, event);
    return undefined;
  }

  /**
   * Send a single event synchronously (for blocking hooks).
   * Returns a block decision if Core says to block, undefined otherwise.
   */
  private async reportSync(
    sessionKey: string,
    event: HookEvent,
  ): Promise<BlockDecision | undefined> {
    const runId = this.sessionRunId.get(sessionKey) ?? "unknown";

    const request: EventStreamRequest = {
      agentId: this.credentials!.agentId,
      sessionKey,
      runId,
      events: [event],
      meta: {
        pluginVersion: this.config.pluginVersion,
        clientTimestamp: new Date().toISOString(),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.coreUrl}/api/v1/events/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials!.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.log.debug?.(`EventReporter: sync request failed with ${response.status}`);
        return undefined; // Fail-open
      }

      const json = (await response.json()) as EventStreamResponse;

      if (!json.success || !json.data) {
        return undefined;
      }

      // Check for block decision for this event
      const blockDecision = json.data.blocks?.find((b) => b.seq === event.seq);
      if (blockDecision) {
        return {
          block: true,
          reason: blockDecision.reason,
          findings: blockDecision.findings,
        };
      }

      return undefined;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`EventReporter: sync request error: ${err}`);
      }
      return undefined; // Fail-open
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Queue an event for batched sending.
   */
  private queueEvent(sessionKey: string, event: HookEvent): void {
    this.queue.push({ sessionKey, event });

    // Start flush timer if not already running
    if (!this.flushTimer && this.config.enableBatching) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((err) => {
          this.log.debug?.(`EventReporter: flush error: ${err}`);
        });
      }, BATCH_FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }

    // Flush immediately if queue is full
    if (this.queue.length >= MAX_BATCH_SIZE) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush().catch((err) => {
        this.log.debug?.(`EventReporter: flush error: ${err}`);
      });
    }
  }

  /**
   * Flush all queued events to Core.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || !this.credentials) {
      return;
    }

    this.flushing = true;
    this.flushTimer = null;

    // Take all queued events
    const items = this.queue.splice(0, MAX_BATCH_SIZE);

    // Group by session for efficient sending
    const bySession = new Map<string, HookEvent[]>();
    for (const item of items) {
      const events = bySession.get(item.sessionKey) ?? [];
      events.push(item.event);
      bySession.set(item.sessionKey, events);
    }

    // Send each session's events
    const promises: Promise<void>[] = [];
    for (const [sessionKey, events] of bySession) {
      promises.push(this.sendBatch(sessionKey, events));
    }

    try {
      await Promise.all(promises);
    } finally {
      this.flushing = false;

      // Re-queue remaining items and restart timer if needed
      if (this.queue.length > 0 && this.config.enableBatching) {
        this.flushTimer = setTimeout(() => {
          this.flush().catch((err) => {
            this.log.debug?.(`EventReporter: flush error: ${err}`);
          });
        }, BATCH_FLUSH_INTERVAL_MS);
        this.flushTimer.unref();
      }
    }
  }

  /**
   * Send a batch of events for a single session.
   */
  private async sendBatch(sessionKey: string, events: HookEvent[]): Promise<void> {
    if (!this.credentials || events.length === 0) return;

    const runId = this.sessionRunId.get(sessionKey) ?? "unknown";

    const request: EventStreamRequest = {
      agentId: this.credentials.agentId,
      sessionKey,
      runId,
      events,
      meta: {
        pluginVersion: this.config.pluginVersion,
        clientTimestamp: new Date().toISOString(),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.coreUrl}/api/v1/events/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.log.debug?.(`EventReporter: batch request failed with ${response.status}`);
        return;
      }

      const json = (await response.json()) as EventStreamResponse;
      if (json.success && json.data) {
        this.log.debug?.(`EventReporter: batch sent ${json.data.processed} events`);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`EventReporter: batch request error: ${err}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get next sequence number for a session.
   */
  private getNextSeq(sessionKey: string): number {
    const current = this.sessionSeq.get(sessionKey) ?? 0;
    this.sessionSeq.set(sessionKey, current + 1);
    return current;
  }

  /**
   * Sanitize event data: truncate large content, remove secrets.
   */
  private sanitizeEventData(data: HookEventData): HookEventData {
    const result = { ...data };

    // Truncate content fields if they exist and are too large
    const contentFields = ["content", "prompt", "task", "resultSummary", "systemPrompt"];

    for (const field of contentFields) {
      if (field in result) {
        const value = (result as Record<string, unknown>)[field];
        if (typeof value === "string" && value.length > MAX_CONTENT_LENGTH) {
          (result as Record<string, unknown>)[field] = value.slice(0, MAX_CONTENT_LENGTH);
        }
      }
    }

    // Sanitize content to remove secrets
    if ("content" in result && typeof result.content === "string") {
      const sanitized = sanitizeContent(result.content);
      (result as { content: string }).content = sanitized.sanitized;
    }

    if ("prompt" in result && typeof (result as { prompt?: string }).prompt === "string") {
      const sanitized = sanitizeContent((result as { prompt: string }).prompt);
      (result as { prompt: string }).prompt = sanitized.sanitized;
    }

    if ("task" in result && typeof (result as { task?: string }).task === "string") {
      const sanitized = sanitizeContent((result as { task: string }).task);
      (result as { task: string }).task = sanitized.sanitized;
    }

    return result;
  }

  /**
   * Stop the reporter and flush remaining events.
   */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
