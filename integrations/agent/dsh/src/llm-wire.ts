/**
 * dsh's model-call shapes → the two halves of an OGR v0.8 STEP.
 *
 * `step/request` carries the request in `openai.chat` form (the runtime
 * normalizes raw provider bodies; `llm_protocol` names the shape). The
 * response side sends the CANONICAL shape instead — `llm_protocol:
 * "canonical"`, `{text, reasoning?, tool_calls, model, usage?, timing}` —
 * because a dsh plugin assembles the answer from a chunk stream and no
 * single raw provider body ever exists, which is exactly the case the
 * spec's canonical form is for.
 *
 * ⚠️ One honest caveat, stated here and in the README. A dsh plugin does not
 * see the literal provider body: the `llm/stream` waterfall runs on
 * `GenerateOptions`, dsh's provider-NEUTRAL request, and each adapter
 * (`dsh-llm-deepseek`, `dsh-llm-pi-ai`, …) maps it to the wire afterwards.
 * So the request is a faithful PROJECTION into one named protocol, not a
 * byte-exact capture. Everything the runtime classifies from — messages,
 * tool schemas, tool calls, tool results — survives the projection; what is
 * lost is provider-specific transport.
 */
import type { ContentBlock, GenerateOptions, Message, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm"

/** The protocol the REQUEST projects into; travels on the event as `llm_protocol`. */
export const LLM_PROTOCOL = "openai.chat"

/** The RESPONSE side is stream-reassembled — no raw provider body exists, so it says so. */
export const RESPONSE_PROTOCOL = "canonical"

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
 * tool outcomes being fed back" as such rather than as user words — and it is
 * where those outcomes get JUDGED: a result travels in the NEXT
 * step's request, so this projection is the enforcement surface for indirect
 * injection riding a tool result.
 *
 * `reasoning` blocks are dropped from requests: they are dsh's separate
 * thinking channel and no `openai.chat` request body carries them. `image`
 * blocks become the protocol's `image_url` part with the attachment's id as
 * the reference — the bytes live in dsh's attachment service and are
 * deliberately not inlined into a guard event.
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
 * `GenerateOptions` → an `openai.chat` request body — the `step/request`
 * payload. The `system` slot leads the message list, which is where
 * `openai.chat` puts it and where the runtime looks for the agent's own
 * instructions.
 */
export function requestBody(options: GenerateOptions): Record<string, unknown> {
  const messages: WireMessage[] = []
  if (options.system) messages.push({ role: "system", content: options.system })
  for (const message of options.messages) messages.push(...projectMessage(message))

  return {
    model: options.model,
    messages,
    // The tool INVENTORY is an attack surface of its own (description
    // injection, rug-pulls), judged from the `tools` array where it already
    // travels — so it is never omitted when present.
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

/** One assembled tool call, as the canonical payload carries it. */
export interface AccumulatedCall {
  id: string
  name: string
  arguments: unknown
}

/**
 * Accumulates a dsh chunk stream into the CANONICAL `step/response` payload.
 *
 * It folds `block-end` chunks, not the deltas: `block-end` carries the
 * assembled, authoritative block, so the accumulator never has to re-implement
 * partial-JSON stitching for tool arguments (and never disagrees with what the
 * loop itself committed). Timing is the plugin's own observation — start of
 * stream, first content chunk, finish — which is exactly the TTFT/decode split
 * the Trajectory view renders.
 */
export class ResponseAccumulator {
  private readonly text: string[] = []
  private readonly reasoning: string[] = []
  private readonly calls: AccumulatedCall[] = []
  private usage: TokenUsage | undefined
  private finished = false
  private finishKind = "stop"
  private readonly startedAt = new Date()
  private firstTokenAt: Date | undefined
  private completedAt: Date | undefined

  constructor(private readonly model: string) {}

  /** Fold one chunk. Unknown chunk types are ignored, by design (the union widens). */
  push(chunk: StreamChunk): void {
    if (this.firstTokenAt === undefined
      && (chunk.type === "text-delta" || chunk.type === "block-start" || chunk.type === "block-end")) {
      this.firstTokenAt = new Date()
    }
    if (chunk.type === "block-end") {
      const block = chunk.block
      if (block.type === "text") this.text.push(block.text)
      else if (block.type === "reasoning") this.reasoning.push(block.text)
      else if (block.type === "tool-call") {
        let args: unknown = block.arguments
        if (typeof args === "string") {
          // The canonical shape carries the argument OBJECT; a string would
          // double-encode and hand the judge `"{\"command\":…}"`.
          try {
            args = JSON.parse(args)
          } catch {
            args = { input: args }
          }
        }
        this.calls.push({ id: String(block.id), name: block.name, arguments: args ?? {} })
      }
      return
    }
    if (chunk.type === "usage") {
      this.usage = chunk.usage
      return
    }
    if (chunk.type === "finish") {
      this.finished = true
      this.completedAt = new Date()
      this.finishKind = chunk.reason.kind
    }
  }

  /** Did the stream reach a `finish` chunk? An aborted turn has nothing complete to judge. */
  get complete(): boolean {
    return this.finished
  }

  /** Is there any model output at all? An empty response is not worth a round trip. */
  get empty(): boolean {
    return this.text.length === 0 && this.calls.length === 0
  }

  /** The assembled tool calls, in stream order — what per-call enforcement keys on. */
  get toolCalls(): readonly AccumulatedCall[] {
    return this.calls
  }

  /** The canonical `step/response` payload. */
  body(): Record<string, unknown> {
    const text = this.text.join("")
    const reasoning = this.reasoning.join("")
    return {
      text,
      ...reasoning ? { reasoning } : {},
      ...this.calls.length > 0 ? { tool_calls: this.calls } : {},
      model: this.model,
      ...this.usage
        ? {
          usage: {
            input_tokens: this.usage.inputTokens,
            output_tokens: this.usage.outputTokens,
            ...this.usage.reasoningTokens !== undefined ? { reasoning_tokens: this.usage.reasoningTokens } : {},
            ...this.usage.cacheReadTokens !== undefined ? { cache_read_tokens: this.usage.cacheReadTokens } : {},
            ...this.usage.cacheWriteTokens !== undefined ? { cache_write_tokens: this.usage.cacheWriteTokens } : {},
          },
        }
        : {},
      timing: {
        started_at: this.startedAt.toISOString(),
        ...this.firstTokenAt ? { first_token_at: this.firstTokenAt.toISOString() } : {},
        ...this.completedAt ? { completed_at: this.completedAt.toISOString() } : {},
      },
    }
  }
}

/** One queued chunk with the characters it would newly reveal downstream. */
interface HeldChunk {
  chunk: StreamChunk
  /** New characters this chunk reveals; 0 for pure structure. */
  cost: number
  /** `finish` — never released before the verdict, whatever the budget. */
  terminal: boolean
}

/**
 * The v0.8 streaming enforcement: hold the TAIL, judge once.
 *
 * A streamed answer is judged exactly once, whole, after the stream ends
 * (never chunk-by-chunk — v0.7's interim evaluates are gone from the
 * protocol). Enforcement comes from what the user has NOT seen yet: chunks
 * are forwarded as they arrive, but the final `tail` characters stay held
 * until the verdict — `allow` flushes them, `block` drops them and the
 * stream ends in an error finish, so the response never completes. The
 * accepted cost, stated by the spec, is that content ahead of the tail has
 * already been seen; a deployment that cannot accept it sets the tail huge,
 * which degenerates to buffering the whole answer.
 *
 * Character accounting, not chunk counting: deltas are split when the budget
 * lands mid-chunk, and a `block-end` — which repeats its block's WHOLE text —
 * only releases once that text has already been revealed by its deltas (its
 * cost is the unrevealed remainder), so a consumer that renders block-ends
 * cannot be handed the held tail through the back door. The `finish` chunk is
 * terminal by definition and never released early: nothing downstream may act
 * on the answer — tool calls included — before the verdict lands. Order is
 * strictly preserved; nothing is reordered around the hold.
 */
export class TailGate {
  private readonly held: HeldChunk[] = []
  /** Characters the stream has produced so far (deltas + block-end remainders). */
  private revealable = 0
  /** Characters already released downstream. */
  private released = 0
  /** Delta characters seen per block index — what a block-end has already revealed. */
  private readonly deltaSeen = new Map<number, number>()

  constructor(private readonly tail: number) {}

  /** Fold one chunk in; returns the chunks (possibly split) releasable NOW. */
  feed(chunk: StreamChunk): StreamChunk[] {
    let cost = 0
    let terminal = false
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      cost = chunk.text.length
      this.deltaSeen.set(chunk.index, (this.deltaSeen.get(chunk.index) ?? 0) + cost)
    } else if (chunk.type === "tool-call-delta") {
      cost = chunk.argumentsDelta.length
      this.deltaSeen.set(chunk.index, (this.deltaSeen.get(chunk.index) ?? 0) + cost)
    } else if (chunk.type === "block-end") {
      const block = chunk.block
      const already = this.deltaSeen.get(chunk.index) ?? 0
      if (block.type === "text" || block.type === "reasoning") {
        cost = Math.max(0, block.text.length - already)
      } else if (block.type === "tool-call") {
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {})
        cost = Math.max(0, args.length - already)
      }
    } else if (chunk.type === "finish") {
      terminal = true
    }
    this.revealable += cost
    this.held.push({ chunk, cost, terminal })
    return this.drain()
  }

  /** Everything still held, in order — released on `allow` (or an unjudgeable stream). */
  flush(): StreamChunk[] {
    const out = this.held.map((h) => h.chunk)
    this.held.length = 0
    this.released = this.revealable
    return out
  }

  private drain(): StreamChunk[] {
    const out: StreamChunk[] = []
    let budget = Math.max(0, this.revealable - this.tail) - this.released
    while (this.held.length > 0) {
      const head = this.held[0] as HeldChunk
      if (head.terminal) break
      const splittable = head.chunk.type === "text-delta" || head.chunk.type === "reasoning-delta"
      if (head.cost <= budget) {
        out.push(head.chunk)
        this.released += head.cost
        budget -= head.cost
        this.held.shift()
        continue
      }
      if (splittable && budget > 0) {
        // The budget lands mid-delta: release the prefix, keep the remainder
        // queued as its own (smaller) delta. Concatenation is unchanged.
        const delta = head.chunk as Extract<StreamChunk, { type: "text-delta" | "reasoning-delta" }>
        out.push({ ...delta, text: delta.text.slice(0, budget) })
        head.chunk = { ...delta, text: delta.text.slice(budget) }
        head.cost -= budget
        this.released += budget
      }
      break
    }
    return out
  }
}
