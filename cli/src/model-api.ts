/**
 * The OpenGuardrails Model API: consulted only for what the local rules hand over. See
 * specification/model-api.md. `allow` and `block` answer whether the action is safe and authorized.
 * `needs_decision` means it is safe and yet the choice is the person's own, such as a purchase.
 */
import { secretOf, type Config } from "./config.js";
import type { TranscriptEntry } from "./transcript.js";

export const DEFAULT_MODEL_URL = "https://api.openguardrails.com";
export const DEFAULT_MODEL = "openguardrails-guard-1";
const DEFAULT_TIMEOUT_MS = 4000;

export interface JudgeRequest {
  model: string;
  transcript: TranscriptEntry[];
  environment: { agent_type: string; workspaces: string[] };
}

export interface Judgement {
  decision: "allow" | "block" | "needs_decision";
  category?: string;
  severity?: "low" | "medium" | "high" | "critical";
  reason?: string;
}

/** Why no judgement came back. Never an allow and never a block: nothing was judged. */
export class ModelUnavailable extends Error {
  constructor(
    message: string,
    readonly quota?: { claim_url?: string },
  ) {
    super(message);
  }
}

export interface ModelTarget {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export function modelTarget(config: Config, env = process.env): ModelTarget | null {
  const apiKey = (config.model ? secretOf(config.model, env) : undefined) ?? env.OPENGUARDRAILS_API_KEY;
  if (!apiKey) return null;
  return {
    url: (config.model?.url ?? env.OPENGUARDRAILS_MODEL_URL ?? DEFAULT_MODEL_URL).replace(/\/$/, ""),
    apiKey,
    model: config.model?.model ?? DEFAULT_MODEL,
    timeoutMs: config.model?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export async function judge(target: ModelTarget, request: Omit<JudgeRequest, "model">): Promise<Judgement> {
  let response: Response;
  try {
    response = await fetch(`${target.url}/v1/judge`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: target.model, ...request } satisfies JudgeRequest),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
  } catch (error) {
    throw new ModelUnavailable(`the model API did not answer: ${String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (response.status === 429 && body.error?.code === "quota_exhausted") {
    throw new ModelUnavailable("the model API quota is used up", { claim_url: body.error.claim_url });
  }
  if (!response.ok) throw new ModelUnavailable(`the model API answered HTTP ${response.status}`);
  // A 200 that names no known decision is not a judgement.
  if (body.decision !== "allow" && body.decision !== "block" && body.decision !== "needs_decision") {
    throw new ModelUnavailable("the model API answered without a decision");
  }
  return body as unknown as Judgement;
}
