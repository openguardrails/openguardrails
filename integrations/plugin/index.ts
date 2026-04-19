/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * moltguard — OpenClaw-family agent plugin for OpenGuardrails.
 *
 * OpenClaw-style agents call a `PreTool` / `PostResponse` hook for each
 * action. moltguard wires those hooks to OpenGuardrailsClient so every
 * tool call and response is checked against the live policy before the
 * agent commits to it.
 */

import { OpenGuardrailsClient, type CheckVerdict } from "../sdk.ts";

export interface MoltguardConfig {
  apiKey: string;
  endpoint?: string;
  /** Block the action when the service is unreachable. Default false. */
  failClosed?: boolean;
  /** Tools this plugin should never check (e.g., pure read-only calls). */
  allowlist?: string[];
}

export interface PreToolContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  userPrompt?: string;
}

export interface PostResponseContext {
  response: string;
  userPrompt?: string;
}

export interface PluginDecision {
  action: "allow" | "block" | "rewrite";
  reason?: string;
  rewrittenValue?: string;
  traceId?: string;
}

export function createMoltguardPlugin(cfg: MoltguardConfig) {
  const client = new OpenGuardrailsClient({
    apiKey: cfg.apiKey,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
  });
  const allow = new Set(cfg.allowlist ?? []);
  const failClosed = cfg.failClosed ?? false;

  return {
    name: "moltguard",
    version: "0.1.0",

    async preTool(ctx: PreToolContext): Promise<PluginDecision> {
      if (allow.has(ctx.toolName)) return { action: "allow" };
      const verdict = await client.check({
        prompt: ctx.userPrompt ?? "",
        toolCall: { name: ctx.toolName, args: ctx.toolArgs },
      });
      return decide(verdict, failClosed);
    },

    async postResponse(ctx: PostResponseContext): Promise<PluginDecision> {
      const verdict = await client.check({
        prompt: ctx.userPrompt ?? "",
        response: ctx.response,
      });
      return decide(verdict, failClosed);
    },
  } as const;
}

function decide(verdict: CheckVerdict, failClosed: boolean): PluginDecision {
  if (verdict.reason?.startsWith("guardrails-unreachable")) {
    return {
      action: failClosed ? "block" : "allow",
      reason: verdict.reason,
      ...(verdict.traceId ? { traceId: verdict.traceId } : {}),
    };
  }
  if (!verdict.allow) {
    return {
      action: verdict.rewrite ? "rewrite" : "block",
      reason: verdict.reason ?? "policy violation",
      ...(verdict.rewrite ? { rewrittenValue: verdict.rewrite } : {}),
      ...(verdict.traceId ? { traceId: verdict.traceId } : {}),
    };
  }
  return {
    action: "allow",
    ...(verdict.traceId ? { traceId: verdict.traceId } : {}),
  };
}

/**
 * Returns a JSON manifest that OpenClaw reads to load the plugin.
 * CLI `ogr integrate plugin` writes this to stdout.
 */
export function moltguardManifest(): Record<string, unknown> {
  return {
    name: "moltguard",
    version: "0.1.0",
    kind: "openclaw-plugin",
    entry: "dist/integrations/moltguard/index.js",
    hooks: ["preTool", "postResponse"],
    config: {
      apiKey: { type: "string", required: true, env: "OPENGUARDRAILS_API_KEY" },
      endpoint: { type: "string", required: false },
      failClosed: { type: "boolean", default: false },
      allowlist: { type: "string[]", default: [] },
    },
    homepage: "https://openguardrails.com",
  };
}
