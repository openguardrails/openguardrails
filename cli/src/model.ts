/** Recognising a model API call, and reading the tool calls out of its request body. */

export type LlmProtocol = "anthropic.messages" | "openai.chat" | "openai.responses";

export interface ToolCall {
  id: string;
  name: string;
  /** Serialized arguments. Read for destinations; never written to the log. */
  args: string;
}

/**
 * By path, not by host: a local vLLM, OpenRouter and a relay all speak these paths, and those
 * unofficial hosts are the ones this tool exists to see.
 */
export function classifyModelRequest(method: string, pathname: string): LlmProtocol | null {
  if (method !== "POST") return null;
  if (/\/messages$/.test(pathname)) return "anthropic.messages";
  if (/\/chat\/completions$/.test(pathname)) return "openai.chat";
  if (/\/responses$/.test(pathname)) return "openai.responses";
  return null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v ?? null));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The proxy hook sees a reply's status and headers only, never its body. A client that resends the
 * conversation shows an issued call in the NEXT request's history, so it is visible after it ran,
 * never before. Not every client resends: Claude Code 2.1 was measured sending the new tool_result
 * alone, and `toolResultIdsIn` is how a run finds out it cannot see a client's calls.
 */
export function toolCallsIn(protocol: LlmProtocol, body: unknown): ToolCall[] {
  if (!isObject(body)) return [];
  const calls: ToolCall[] = [];
  if (protocol === "openai.responses") {
    const input = Array.isArray(body.input) ? body.input : [];
    for (const item of input) {
      if (!isObject(item)) continue;
      const id = String(item.call_id ?? item.id ?? "");
      if (item.type === "function_call") calls.push({ id, name: String(item.name), args: str(item.arguments) });
      if (item.type === "custom_tool_call") calls.push({ id, name: String(item.name), args: str(item.input) });
      if (item.type === "local_shell_call") calls.push({ id, name: "local_shell", args: str(item.action) });
    }
    return calls;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (protocol === "anthropic.messages" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === "tool_use") {
          calls.push({ id: String(block.id), name: String(block.name), args: str(block.input) });
        }
      }
    }
    if (protocol === "openai.chat" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isObject(call) || !isObject(call.function)) continue;
        calls.push({ id: String(call.id), name: String(call.function.name), args: str(call.function.arguments) });
      }
    }
  }
  return calls;
}

/** The tool calls in a reply, streamed or whole, so a call is known as it is issued. */
export function toolCallsInReply(protocol: LlmProtocol, reply: string, streamed: boolean): ToolCall[] {
  const events: any[] = [];
  if (streamed) {
    for (const line of reply.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5)));
      } catch {
        // [DONE], or a frame that is not JSON.
      }
    }
  } else {
    try {
      const body = JSON.parse(reply);
      if (protocol === "anthropic.messages") return toolCallsIn(protocol, { messages: [body] });
      if (protocol === "openai.chat") return toolCallsIn(protocol, { messages: (body.choices ?? []).map((choice: any) => choice.message) });
      return toolCallsIn(protocol, { input: body.output });
    } catch {
      return [];
    }
  }
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (protocol === "openai.chat") {
      for (const delta of event?.choices?.[0]?.delta?.tool_calls ?? []) {
        const call = calls.get(String(delta.index)) ?? { id: "", name: "", args: "" };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name = delta.function.name;
        call.args += delta.function?.arguments ?? "";
        calls.set(String(delta.index), call);
      }
    } else if (protocol === "anthropic.messages") {
      if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
        calls.set(String(event.index), { id: event.content_block.id, name: event.content_block.name, args: "" });
      }
      if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        const call = calls.get(String(event.index));
        if (call) call.args += event.delta.partial_json ?? "";
      }
    } else if (event?.type === "response.output_item.done") {
      const [call] = toolCallsIn(protocol, { input: [event.item] });
      if (call) calls.set(call.id, call);
    }
  }
  return [...calls.values()].filter((call) => call.id);
}

/** The call ids that a request's tool results answer. */
export function toolResultIdsIn(protocol: LlmProtocol, body: unknown): string[] {
  if (!isObject(body)) return [];
  const ids: string[] = [];
  if (protocol === "openai.responses") {
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (isObject(item) && /_output$/.test(String(item.type)) && item.call_id) ids.push(String(item.call_id));
    }
    return ids;
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isObject(message)) continue;
    if (protocol === "openai.chat" && message.role === "tool" && message.tool_call_id) ids.push(String(message.tool_call_id));
    if (protocol === "anthropic.messages" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === "tool_result") ids.push(String(block.tool_use_id));
      }
    }
  }
  return ids;
}

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]+@)?(\[[0-9a-f:]+\]|[a-z0-9.-]+)/gi;
const SSH_HOST = /\b[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const BARE_HOST = /(?<![\w./-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|sh|co|cn|app|cloud|xyz|me|info))(?![\w-])/gi;

/**
 * The destinations a tool call names in plain text. It errs towards naming too many, which can
 * only hide a finding. A host assembled at run time or encoded is not named, which is the point.
 */
export function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const re of [URL_HOST, SSH_HOST, BARE_HOST]) {
    for (const match of text.matchAll(re)) {
      if (match[1]) hosts.add(match[1].toLowerCase().replace(/\.$/, ""));
    }
  }
  return [...hosts];
}

/** A label only: a process can send any User-Agent, so nothing may be decided on it. */
export function harnessFrom(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  for (const [needle, name] of [
    ["claude-cli", "claude-code"],
    ["claude-code", "claude-code"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["openclaw", "openclaw"],
    ["hermes", "hermes"],
    ["gemini-cli", "gemini-cli"],
    ["aider", "aider"],
  ] as const) {
    if (ua.includes(needle)) return name;
  }
  return "unknown";
}
