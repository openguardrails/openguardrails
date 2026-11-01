/**
 * The context the model judges with. The API keeps no session, so every request must carry the
 * whole story: what the person asked, what the agent has done and the action under review, last.
 * Tool results are represented by their outcome only. They are untrusted text, and an instruction
 * inside one must not reach the judge as if someone had said it.
 */
import { maskDeep } from "./secrets/mask.js";

export type TranscriptEntry = Record<string, unknown>;

const MAX_ENTRIES = 512;
const MAX_ENTRY_CHARS = 32_000;

const clip = (text: string) => (text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}…[${text.length - MAX_ENTRY_CHARS} more characters]` : text);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part && typeof part === "object" && typeof (part as any).text === "string" ? (part as any).text : ""))
    .filter(Boolean)
    .join("\n");
}

export interface NormalCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Arguments arrive as an object or as JSON text. Unparseable text is kept, not dropped. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { input: raw };
  } catch {
    return { input: raw };
  }
}

function callFrom(raw: any): NormalCall | null {
  const name = raw?.function?.name ?? raw?.name;
  if (typeof name !== "string" || !name) return null;
  return { id: String(raw.id ?? raw.call_id ?? ""), name, args: parseArgs(raw.function?.arguments ?? raw.arguments ?? raw.args ?? raw.input ?? raw.params) };
}

/** Tool calls in a step/response payload, each with the path a verdict must name it by. */
export function callsIn(protocol: string, payload: any): Array<NormalCall & { path: string }> {
  const out: Array<NormalCall & { path: string }> = [];
  const add = (raw: unknown, path: string) => {
    const call = callFrom(raw);
    if (call) out.push({ ...call, path });
  };
  if (protocol === "openai.chat") {
    (payload?.choices?.[0]?.message?.tool_calls ?? []).forEach((raw: unknown, i: number) => add(raw, `payload.choices.0.message.tool_calls.${i}`));
  } else if (protocol === "anthropic.messages") {
    (payload?.content ?? []).forEach((raw: any, i: number) => raw?.type === "tool_use" && add(raw, `payload.content.${i}`));
  } else if (protocol === "openai.responses") {
    (payload?.output ?? []).forEach((raw: any, i: number) => /_call$/.test(String(raw?.type)) && add(raw, `payload.output.${i}`));
  } else {
    (payload?.tool_calls ?? []).forEach((raw: unknown, i: number) => add(raw, `payload.tool_calls.${i}`));
  }
  return out;
}

const projection = (call: NormalCall): TranscriptEntry => {
  const command = typeof call.args.command === "string" ? call.args.command : null;
  return { [call.name]: clip(command ?? JSON.stringify(call.args)) };
};

/** A conversation, whichever shape the producer sent it in, as judge entries. */
export function entriesFromMessages(messages: unknown): TranscriptEntry[] {
  if (!Array.isArray(messages)) return [];
  const entries: TranscriptEntry[] = [];
  for (const message of messages as any[]) {
    const role = message?.role;
    if (role === "user") {
      const results = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "tool_result") : [];
      for (const result of results) entries.push({ outcome: result.is_error ? "error" : "ok", id: result.tool_use_id });
      const text = results.length ? textOf(message.content.filter((part: any) => part?.type !== "tool_result")) : textOf(message.content);
      if (text) entries.push({ user: clip(text) });
    } else if (role === "assistant") {
      const text = textOf(message.content);
      if (text) entries.push({ assistant: clip(text) });
      for (const raw of message.tool_calls ?? (Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === "tool_use") : [])) {
        const call = callFrom(raw);
        if (call) entries.push(projection(call));
      }
    } else if (role === "tool" || role === "toolResult") {
      entries.push({ outcome: "ok", id: message.tool_call_id ?? message.toolCallId });
    }
  }
  return entries;
}

/** The last entries, with the action under review as the final one. Secrets never leave this function. */
export function buildTranscript(history: TranscriptEntry[], action: NormalCall): TranscriptEntry[] {
  return maskDeep([...history.slice(-(MAX_ENTRIES - 1)), projection(action)]);
}
