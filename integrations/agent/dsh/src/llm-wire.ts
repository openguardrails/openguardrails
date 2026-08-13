/**
 * dsh's model-call shapes → the `openai.chat` bodies OGR v0.6's developer path
 * carries.
 *
 * v0.6 moved conversation classification out of the PEP: `llm_request` and
 * `llm_response` carry "the untouched provider request/response body", and the
 * RUNTIME derives the new user words, the tool outcomes being fed back, the
 * model's prose, every tool call it asks for, and the declared tool inventory.
 * Nothing here classifies anything — this module only re-shapes.
 *
 * ⚠️ One honest caveat, stated here and in the README. A dsh plugin does not
 * see the literal provider body: the `llm/stream` waterfall runs on
 * `GenerateOptions`, dsh's provider-NEUTRAL request, and each adapter
 * (`dsh-llm-deepseek`, `dsh-llm-pi-ai`, …) maps it to the wire afterwards.
 * So this is a faithful PROJECTION into one named protocol, not a byte-exact
 * capture, and `llm_protocol` names the shape actually emitted rather than the
 * shape the adapter will send. Everything the runtime classifies from —
 * messages, tool schemas, tool calls, tool results — survives the projection;
 * what is lost is provider-specific transport (`reasoning_effort` and the
 * adapter's own header/metadata mapping).
 */
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from "@deepseek-ai/dsh-llm"

/** The protocol this module projects into; travels on the event as `llmProtocol`. */
export const LLM_PROTOCOL = "openai.chat"

/** An `openai.chat` message, as it appears in a request body. */
interface WireMessage {
  role: string
  content: string | unknown[] | null
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** Concatenated text of a block list; reasoning is excluded (see `projectMessage`). */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
}

/**
 * One dsh message → one or more `openai.chat` messages.
 *
 * A dsh tool RESULT is a user-role message whose single block is a
 * `tool-result`; `openai.chat` spells the same thing as a `tool`-role message
 * keyed by `tool_call_id`. Splitting it out is what lets the runtime see "the
 * tool outcomes being fed back" as such rather than as user words — the
 * distinction the whole developer path rests on.
 *
 * `reasoning` blocks are dropped: they are dsh's separate thinking channel and
 * no `openai.chat` request body carries them. `image` blocks become the
 * protocol's `image_url` part with the attachment's id as the reference — the
 * bytes live in dsh's attachment service and are deliberately not inlined into
 * a guard event.
 */
function projectMessage(message: Message): WireMessage[] {
  const out: WireMessage[] = []
  const toolResults = message.content.filter(
    (b): b is Extract<ContentBlock, { type: "tool-result" }> => b.type === "tool-result",
  )
  for (const result of toolResults) {
    out.push({
      role: "tool",
      tool_call_id: String(result.toolCallId),
      content: textOf(result.content),
    })
  }

  const toolCalls = message.content
    .filter((b): b is Extract<ContentBlock, { type: "tool-call" }> => b.type === "tool-call")
    .map((b) => ({
      id: String(b.id),
      type: "function" as const,
      function: { name: b.name, arguments: b.arguments },
    }))
  const images = message.content.filter(
    (b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image",
  )
  const text = textOf(message.content)

  // A message that carried ONLY tool results is fully represented above.
  if (toolResults.length > 0 && toolCalls.length === 0 && images.length === 0 && text.length === 0) {
    return out
  }

  const content: WireMessage["content"] = images.length > 0
    ? [
      ...text ? [{ type: "text", text }] : [],
      ...images.map((b) => ({
        type: "image_url",
        image_url: { url: `dsh-attachment:${String((b.attachment as { id?: unknown }).id ?? "")}` },
      })),
    ]
    : text

  out.push({
    role: message.role,
    content,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  })
  return out
}

/**
 * `GenerateOptions` → an `openai.chat` request body — the `llm_request` payload.
 * The `system` slot leads the message list, which is where `openai.chat` puts
 * it and where the runtime looks for the agent's own instructions.
 */
export function requestBody(options: GenerateOptions): Record<string, unknown> {
  const messages: WireMessage[] = []
  if (options.system) messages.push({ role: "system", content: options.system })
  for (const message of options.messages) messages.push(...projectMessage(message))

  return {
    model: options.model,
    messages,
    // The tool INVENTORY is an attack surface of its own (description
    // injection, rug-pulls), and v0.6 judges it from the `tools` array where
    // it already travels — so it is never omitted when present.
    ...options.tools?.length
      ? {
        tools: options.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }
      : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
    ...options.stop?.length ? { stop: options.stop } : {},
    stream: true,
  }
}

/** `openai.chat` finish reasons for the dsh finish kinds that have one. */
const FINISH_REASON: Record<string, string> = {
  "stop": "stop",
  "tool-calls": "tool_calls",
  "max-tokens": "length",
}

/**
 * Accumulates a dsh chunk stream into one `openai.chat` response body — the
 * `llm_response` payload.
 *
 * It folds `block-end` chunks, not the deltas: `block-end` carries the
 * assembled, authoritative block, so the accumulator never has to re-implement
 * partial-JSON stitching for tool arguments (and never disagrees with what the
 * loop itself committed).
 */
export class ResponseAccumulator {
  private readonly text: string[] = []
  private readonly toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []
  private finishReason = "stop"
  private usage: unknown
  private finished = false

  constructor(private readonly model: string) {}

  /** Fold one chunk. Unknown chunk types are ignored, by design (the union widens). */
  push(chunk: StreamChunk): void {
    if (chunk.type === "block-end") {
      const block = chunk.block
      if (block.type === "text") this.text.push(block.text)
      else if (block.type === "tool-call") {
        this.toolCalls.push({
          id: String(block.id),
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        })
      }
      return
    }
    if (chunk.type === "usage") {
      this.usage = chunk.usage
      return
    }
    if (chunk.type === "finish") {
      this.finished = true
      this.finishReason = FINISH_REASON[chunk.reason.kind] ?? chunk.reason.kind
    }
  }

  /** Did the stream reach a `finish` chunk? An aborted turn has nothing complete to judge. */
  get complete(): boolean {
    return this.finished
  }

  /** Is there any model output at all? An empty response is not worth a round trip. */
  get empty(): boolean {
    return this.text.length === 0 && this.toolCalls.length === 0
  }

  /** The accumulated `openai.chat` response body. */
  body(): Record<string, unknown> {
    return {
      model: this.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: this.text.join("") || null,
          ...this.toolCalls.length > 0 ? { tool_calls: this.toolCalls } : {},
        },
        finish_reason: this.finishReason,
      }],
      ...this.usage !== undefined ? { usage: this.usage } : {},
    }
  }
}
