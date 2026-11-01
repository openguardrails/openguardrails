/**
 * The guard on the model channel: this gateway is the one thing every request passes through, side
 * requests included, whichever harness sent it. Outbound, secrets become placeholders. Inbound, tool
 * calls are judged on those placeholders, and only what is allowed gets the real value back.
 */
import { type CompiledRuleset } from "./redaction/ruleset.js";
import { maskRequest } from "./redaction/mask.js";
import { restore, UNRESTORABLE_NOTICE } from "./redaction/restore.js";
import { restoreResponseBody } from "./redaction/protocol.js";
import { SessionMap } from "./redaction/session.js";
import { compiledRules } from "./secrets/mask.js";
import { createStreamGuard, type Refusals, type StreamCall } from "./guard-stream.js";
import type { LlmProtocol } from "./model.js";
import type { LocalRuntime } from "./runtime.js";
import { callsIn, entriesFromMessages, type TranscriptEntry } from "./transcript.js";

/**
 * Well above what a plugin in the same agent mints from 1. One value must never have two meanings
 * on one wire, and a plugin and this gateway can both be in the path.
 */
const FIRST_TOKEN = 5_000_000;
/** A value past this is masked for good: it cannot be restored. Better than a value that leaves. */
const MAX_VALUES = 4096;

export interface GuardedRequest {
  body: Record<string, any>;
  map: SessionMap;
  history: TranscriptEntry[];
  agentType: string;
}

export class ModelChannelGuard {
  private readonly maps = new Map<string, SessionMap>();
  private counter = FIRST_TOKEN;
  private readonly rules: CompiledRuleset = compiledRules();

  constructor(private readonly runtime: LocalRuntime) {}

  /** One map per agent, so a value keeps its placeholder across every conversation. */
  private mapFor(agentType: string): SessionMap {
    let map = this.maps.get(agentType);
    if (!map) {
      map = new SessionMap(agentType, { bound: MAX_VALUES, allocate: () => ++this.counter });
      this.maps.set(agentType, map);
    }
    return map;
  }

  outbound(agentType: string, parsed: Record<string, any>): GuardedRequest {
    const map = this.mapFor(agentType);
    const { value: body } = maskRequest(parsed, map, this.rules);
    return { body, map, agentType, history: entriesFromMessages(body.messages ?? body.input) };
  }

  /** Every call answered. A failure inside must not become an allow: it fails to the rules' caller as a refusal. */
  private async refusals(request: GuardedRequest, calls: StreamCall[]): Promise<Refusals> {
    const refused: Refusals = new Map();
    if (calls.length === 0) return refused;
    const judged = await this.runtime.judgeCalls(calls, [...request.history], request.agentType, request.agentType);
    judged.forEach((answer, i) => {
      const call = calls[i]!;
      if (answer.refused) refused.set(call.path, answer.refused.notice);
    });
    // A placeholder nothing here can answer, after a restart for instance. Running with it would hand
    // a tool a word that looks like a value.
    for (const call of calls) {
      const [token] = restore(JSON.stringify(call.args), request.map).unresolved;
      if (token && !refused.has(call.path)) refused.set(call.path, UNRESTORABLE_NOTICE(token));
    }
    return refused;
  }

  whole(request: GuardedRequest, protocol: LlmProtocol, reply: string): Promise<string> {
    return this.renderWhole(request, protocol, reply).catch((error) => JSON.stringify({ error: { message: `openguardrails could not judge this reply: ${String(error)}`, type: "openguardrails_internal" } }));
  }

  private async renderWhole(request: GuardedRequest, protocol: LlmProtocol, reply: string): Promise<string> {
    let parsed: any;
    try {
      parsed = JSON.parse(reply);
    } catch {
      return reply;
    }
    const calls = callsIn(protocol, parsed);
    const refused = await this.refusals(request, calls);
    let out = reply;
    const told = this.runtime.takeQuotaNotice();
    const notice = [...new Set(refused.values()), ...(told ? [told] : [])].join(" ");
    if (notice) {
      if (protocol === "openai.chat") {
        const message = parsed.choices?.[0]?.message ?? {};
        message.tool_calls = (message.tool_calls ?? []).filter((_: unknown, i: number) => !refused.has(`payload.choices.0.message.tool_calls.${i}`));
        message.content = [message.content, notice].filter(Boolean).join("\n\n");
        if (message.tool_calls.length === 0) {
          delete message.tool_calls;
          parsed.choices[0].finish_reason = "stop";
        }
      } else if (protocol === "anthropic.messages") {
        parsed.content = (parsed.content ?? []).filter((_: unknown, i: number) => !refused.has(`payload.content.${i}`));
        parsed.content.push({ type: "text", text: notice });
        if (!parsed.content.some((block: any) => block.type === "tool_use")) parsed.stop_reason = "end_turn";
      } else {
        parsed.output = (parsed.output ?? []).filter((_: unknown, i: number) => !refused.has(`payload.output.${i}`));
        parsed.output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: notice }] });
      }
      out = JSON.stringify(parsed);
    }
    return restoreResponseBody(protocol, out, request.map)?.body ?? out;
  }

  stream(request: GuardedRequest, protocol: LlmProtocol, write: (text: string) => void) {
    return createStreamGuard({
      protocol,
      map: request.map,
      write,
      notice: () => this.runtime.takeQuotaNotice(),
      judge: (calls) =>
        this.refusals(request, calls).catch((error) => {
          // No answer is not an allow: every call is refused, and the agent is told it was a fault.
          const notice = `This action was NOT executed: openguardrails failed while judging it (${String(error)}). Tell the user.`;
          return new Map(calls.map((call) => [call.path, notice]));
        }),
    });
  }
}
