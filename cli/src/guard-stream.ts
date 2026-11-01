/**
 * A streamed reply on its way to the agent: prose flows live, and everything from the first tool call
 * on waits for the verdict. Refused calls never reach the agent. What survives has its placeholders
 * restored, so a tool gets the real value and the model never does.
 */
import { createSseRestorer } from "./redaction/sse.js";
import type { SessionMap } from "./redaction/session.js";
import type { LlmProtocol } from "./model.js";
import { parseArgs, type NormalCall } from "./transcript.js";

export type StreamCall = NormalCall & { path: string };
/** path to the notice for each refused call. Anything not named here runs. */
export type Refusals = Map<string, string>;

interface Frame {
  raw: string;
  event?: string;
  data?: any;
  done?: boolean;
}

function parseFrame(raw: string): Frame {
  const frame: Frame = { raw };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) frame.event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") frame.done = true;
      else {
        try {
          frame.data = JSON.parse(payload);
        } catch {
          // Not JSON: it passes through as it came.
        }
      }
    }
  }
  return frame;
}

const render = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

/** True from the frame on which the verdict matters. */
function startsHold(protocol: LlmProtocol, frame: Frame): boolean {
  if (frame.done) return true;
  const data = frame.data;
  if (!data) return false;
  if (protocol === "openai.chat") {
    const choice = data.choices?.[0];
    return Boolean(choice?.delta?.tool_calls?.length || choice?.finish_reason);
  }
  if (protocol === "anthropic.messages") {
    return (data.type === "content_block_start" && data.content_block?.type !== "text" && data.content_block?.type !== "thinking") || data.type === "message_delta" || data.type === "message_stop";
  }
  return (data.type === "response.output_item.added" && /_call$/.test(String(data.item?.type))) || data.type === "response.completed" || data.type === "response.done";
}

/** The tool calls in the held frames. */
export function callsInFrames(protocol: LlmProtocol, frames: Frame[]): StreamCall[] {
  const calls = new Map<string, { id: string; name: string; text: string }>();
  const entry = (key: string) => {
    const call = calls.get(key) ?? { id: "", name: "", text: "" };
    calls.set(key, call);
    return call;
  };
  for (const { data } of frames) {
    if (!data) continue;
    if (protocol === "openai.chat") {
      for (const delta of data.choices?.[0]?.delta?.tool_calls ?? []) {
        const call = entry(`tool:${delta.index ?? 0}`);
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name = delta.function.name;
        call.text += delta.function?.arguments ?? "";
      }
    } else if (protocol === "anthropic.messages") {
      if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
        const call = entry(`tool:${data.index}`);
        call.id = data.content_block.id;
        call.name = data.content_block.name;
      } else if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
        entry(`tool:${data.index}`).text += data.delta.partial_json ?? "";
      }
    } else if (data.type === "response.output_item.done" && /_call$/.test(String(data.item?.type))) {
      const item = data.item;
      const call = entry(`tool:${data.output_index}`);
      call.id = String(item.call_id ?? item.id ?? "");
      call.name = String(item.name ?? item.type);
      call.text = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.input ?? item.action ?? {});
    }
  }
  return [...calls].map(([path, call]) => ({ path, id: call.id, name: call.name, args: parseArgs(call.text) }));
}

/** The held frames with refused calls gone and the agent told why. */
export function renderHeld(protocol: LlmProtocol, frames: Frame[], refused: Refusals): string {
  if (refused.size === 0) return frames.map((frame) => frame.raw).join("");
  const notice = [...new Set(refused.values())].join(" ");
  let out = "";
  if (protocol === "openai.chat") {
    const kept = [...new Set(frames.flatMap((f) => (f.data?.choices?.[0]?.delta?.tool_calls ?? []).map((d: any) => d.index ?? 0)))].filter((i) => !refused.has(`tool:${i}`));
    const renumber = new Map(kept.map((index, i) => [index, i]));
    let noticed = false;
    const tell = (like: any) => {
      noticed = true;
      return render({ ...like, choices: [{ index: 0, delta: { content: `\n\n${notice}` }, finish_reason: null }] });
    };
    for (const frame of frames) {
      const choice = frame.data?.choices?.[0];
      if (!choice) {
        // `[DONE]` closes the stream, so the notice must already be out by then.
        if (frame.done && !noticed) out += tell({ object: "chat.completion.chunk", model: "" });
        out += frame.raw;
        continue;
      }
      const deltas = (choice.delta?.tool_calls ?? []).filter((d: any) => renumber.has(d.index ?? 0)).map((d: any) => ({ ...d, index: renumber.get(d.index ?? 0) }));
      const { tool_calls: had, ...delta } = choice.delta ?? {};
      if (choice.finish_reason) {
        if (!noticed) out += tell(frame.data);
        out += render({ ...frame.data, choices: [{ ...choice, delta: {}, finish_reason: kept.length > 0 ? choice.finish_reason : "stop" }] });
      } else if (!had) {
        out += frame.raw;
      } else if (deltas.length > 0 || Object.values(delta).some(Boolean)) {
        out += render({ ...frame.data, choices: [{ ...choice, delta: { ...delta, ...(deltas.length > 0 ? { tool_calls: deltas } : {}) } }] });
      }
    }
    if (!noticed) out += tell({ object: "chat.completion.chunk", model: "" });
    return out;
  }
  if (protocol === "anthropic.messages") {
    const first = frames.find((f) => f.data?.type === "content_block_start")?.data?.index ?? 0;
    let next = first;
    const renumber = new Map<number, number>();
    for (const { data } of frames) {
      if (data?.type === "content_block_start" && !refused.has(`tool:${data.index}`)) renumber.set(data.index, next++);
    }
    const survivors = frames.some((f) => f.data?.type === "content_block_start" && f.data.content_block?.type === "tool_use" && !refused.has(`tool:${f.data.index}`));
    let noticed = false;
    const tell = () => {
      noticed = true;
      return (
        render({ type: "content_block_start", index: next, content_block: { type: "text", text: "" } }, "content_block_start") +
        render({ type: "content_block_delta", index: next, delta: { type: "text_delta", text: notice } }, "content_block_delta") +
        render({ type: "content_block_stop", index: next }, "content_block_stop")
      );
    };
    for (const frame of frames) {
      const data = frame.data;
      if (data && typeof data.index === "number" && String(data.type).startsWith("content_block")) {
        if (refused.has(`tool:${data.index}`)) continue;
        out += render({ ...data, index: renumber.get(data.index) ?? data.index }, frame.event);
      } else if (data?.type === "message_delta") {
        if (!noticed) out += tell();
        out += render({ ...data, delta: { ...data.delta, stop_reason: survivors ? data.delta?.stop_reason : "end_turn" } }, frame.event);
      } else {
        if (data?.type === "message_stop" && !noticed) out += tell();
        out += frame.raw;
      }
    }
    return noticed ? out : out + tell();
  }
  // A Responses stream states its whole output in several places, so a call cannot be cut out of it
  // cleanly. The whole step is retracted, and the agent is told why.
  return render({ type: "response.failed", response: { status: "failed", error: { code: "refused", message: notice } } }, "response.failed");
}

export interface StreamGuardOptions {
  protocol: LlmProtocol;
  map: SessionMap;
  write(text: string): void;
  /** Answers for every call. It must always resolve. */
  judge(calls: StreamCall[]): Promise<Refusals>;
}

export function createStreamGuard({ protocol, map, write, judge }: StreamGuardOptions) {
  const restorer = createSseRestorer(protocol, map);
  const held: Frame[] = [];
  let carry = "";
  let holding = false;
  const take = (raw: string) => {
    const frame = parseFrame(raw);
    if (!holding && startsHold(protocol, frame)) holding = true;
    if (holding) held.push(frame);
    else {
      const out = restorer.feed(raw);
      if (out) write(out);
    }
  };
  return {
    feed(chunk: string): void {
      carry += chunk;
      for (;;) {
        const match = /\r?\n\r?\n/.exec(carry);
        if (!match) return;
        const end = match.index + match[0].length;
        take(carry.slice(0, end));
        carry = carry.slice(end);
      }
    },
    /** The upstream ended: judge what is held, and send what survives. */
    async finish(): Promise<void> {
      if (carry.trim()) take(`${carry}\n\n`);
      carry = "";
      const refused = await judge(callsInFrames(protocol, held));
      const out = restorer.feed(renderHeld(protocol, held, refused)) + restorer.end();
      if (out) write(out);
    },
  };
}
