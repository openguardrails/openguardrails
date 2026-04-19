/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenGuardrails SDK — client for agent developers.
 *
 * This SDK is the open-source *client*. The detection/policy engine it
 * talks to is the OpenGuardrails service and is not part of this repo.
 * See docs/PHILOSOPHY.md for why.
 */

export interface GuardrailsClientOptions {
  apiKey: string;
  /** Override the default endpoint if self-hosting a gateway. */
  endpoint?: string;
  /** Request timeout in ms. Default 3000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CheckInput {
  /** The user or upstream prompt the agent is about to act on. */
  prompt?: string;
  /** The tool call the agent is about to make. */
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  /** The agent's candidate response. */
  response?: string;
  /** Free-form context. Will be shipped as-is. */
  context?: Record<string, unknown>;
}

export interface CheckVerdict {
  allow: boolean;
  /** Severity of the highest-risk signal, if any. */
  severity?: "low" | "medium" | "high" | "critical";
  /** Short, human-readable reason. */
  reason?: string;
  /** Stable identifiers for the signals that fired. */
  signals?: string[];
  /** Suggested replacement (e.g., redacted response) the caller may use. */
  rewrite?: string;
  /** Opaque request id — quote it when filing a support ticket. */
  traceId?: string;
}

const DEFAULT_ENDPOINT = "https://api.openguardrails.com/v1/check";

export class OpenGuardrailsClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GuardrailsClientOptions) {
    if (!opts.apiKey) throw new Error("OpenGuardrailsClient: apiKey required");
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async check(input: CheckInput): Promise<CheckVerdict> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`,
          "x-ogr-sdk": "oss/0.1.0",
        },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        return failOpen(`HTTP ${res.status}`);
      }
      const v = (await res.json()) as CheckVerdict;
      return v;
    } catch (e) {
      return failOpen((e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * On unreachable service we return allow=true by default. This is a
 * deliberate tradeoff: a guardrail that blocks the agent when the
 * guardrail itself is down is a reliability liability. Callers who prefer
 * fail-closed behavior should check `reason` and enforce themselves.
 */
function failOpen(reason: string): CheckVerdict {
  return { allow: true, reason: `guardrails-unreachable: ${reason}` };
}
