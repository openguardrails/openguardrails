/**
 * Streaming restore: an SSE reply rewritten frame by frame so that a
 * placeholder inside a TOOL-CALL ARGUMENT restores even when it straddles
 * two deltas, and nothing else in the stream is touched (D7 — prose keeps
 * its placeholders).
 *
 * Ported from the higress decoders (`chatDecoder`, `anthropicDecoder`,
 * `responsesDecoder`) with two deliberate differences:
 *
 *  - The unit of work is the FRAME, never the line. Anthropic and Responses
 *    frames carry an `event:` line BEFORE their `data:` line, and a client
 *    dispatches on it — so a held tail flushed "before the data line" would
 *    land between an event name and its data and be dispatched under the
 *    wrong name. Working per frame lets a flush be emitted ahead of the
 *    whole frame that closes the field.
 *  - Only argument fields are restored. The gateway restores prose too
 *    because it masked prose; here the model is MEANT to keep talking in
 *    placeholders, and a restored answer would put the value on every
 *    delivery channel the harness has.
 *
 * ⚠️ Every streamed argument field keeps its OWN pending tail (one per tool
 * call index / content block / output item): two calls stream interleaved,
 * and one call's half-token must never be completed by the other's next
 * delta.
 */
import type { ModelProtocol } from "./protocol.js"
import { createStreamRestorer, jsonStringEncode, restoreJsonText, tokensIn, type StreamRestorer } from "./restore.js"
import type { SessionMap } from "./session.js"

/** One protocol's view of a `data:` payload. */
interface FrameDecoder {
  /**
   * One complete data payload. `before` — complete frames to emit AHEAD of
   * this one (held tails being flushed); `payload` — the rewritten payload,
   * or null when the frame passes through untouched.
   */
  data(payload: string, isLast: boolean): { before: string; payload: string | null }
  /** Everything still held, as complete frames. */
  flush(): string
}

interface Tail {
  pending: string
  /** The restored argument text so far — scanned for tokens no map answers. */
  seen: string
}

export interface SseRestorer {
  /** Feed raw stream text (any chunking); returns what may be emitted now. */
  feed(chunk: string): string
  /** The stream ended: the carried partial frame and every held tail. */
  end(): string
}

export interface SseRestorerOptions {
  /** Called with the placeholder-shaped tokens an argument still holds once its field is complete. */
  onUnresolved?: (tokens: string[]) => void
}

const parse = (payload: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(payload)
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const dict = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A `data:`-only frame (the OpenAI family). */
const dataFrame = (payload: string): string => `data: ${payload}\n\n`
/** An `event:` + `data:` frame (Anthropic, Responses). */
const eventFrame = (name: string, payload: string): string => `event: ${name}\ndata: ${payload}\n\n`

function tails(): Map<string, Tail> {
  return new Map()
}
function tail(m: Map<string, Tail>, key: string): Tail {
  let t = m.get(key)
  if (!t) {
    t = { pending: "", seen: "" }
    m.set(key, t)
  }
  return t
}

/** `openai.chat`: `choices[].delta.tool_calls[].function.arguments`, keyed by choice + call index. */
function chatDecoder(r: StreamRestorer, map: SessionMap, report: (tokens: string[]) => void): FrameDecoder {
  const calls = tails()
  let model = ""
  const finish = (t: Tail): void => {
    const left = tokensIn(t.seen).filter((k) => map.valueOf(k) === undefined)
    if (left.length) report(left)
    t.seen = ""
  }
  const flush = (): string => {
    const byChoice = new Map<number, Array<Record<string, unknown>>>()
    for (const [key, t] of calls) {
      if (t.pending !== "") {
        const [c, i] = key.split(":").map(Number) as [number, number]
        const arr = byChoice.get(c) ?? []
        arr.push({ index: i, function: { arguments: t.pending } })
        byChoice.set(c, arr)
        t.seen += t.pending
        t.pending = ""
      }
      finish(t)
    }
    let out = ""
    for (const [c, tool_calls] of byChoice) {
      out += dataFrame(
        JSON.stringify({
          id: "chatcmpl-ogr-flush",
          object: "chat.completion.chunk",
          ...(model ? { model } : {}),
          choices: [{ index: c, delta: { tool_calls } }],
        }),
      )
    }
    return out
  }
  return {
    data(payload, isLast) {
      if (payload === "[DONE]") return { before: flush(), payload: null }
      const parsed = parse(payload)
      if (!parsed) return { before: "", payload: null }
      if (typeof parsed["model"] === "string" && !model) model = parsed["model"]
      const choices = list(parsed["choices"]).map(dict)
      // A frame carrying a finish reason closes every field of that choice:
      // its deltas are the last, and whatever is still held is text.
      const closing = choices.some((c) => typeof c?.["finish_reason"] === "string")
      let modified = false
      choices.forEach((choice, ci) => {
        const index = typeof choice?.["index"] === "number" ? (choice["index"] as number) : ci
        list(dict(choice?.["delta"])?.["tool_calls"]).forEach((tc, n) => {
          const call = dict(tc)
          const fn = dict(call?.["function"])
          if (!call || !fn || typeof fn["arguments"] !== "string") return
          const i = typeof call["index"] === "number" ? (call["index"] as number) : n
          const t = tail(calls, `${index}:${i}`)
          const original = fn["arguments"] as string
          const restored = r.feed(t, original, isLast || closing)
          t.seen += restored
          if (restored !== original) {
            fn["arguments"] = restored
            modified = true
          }
        })
      })
      const before = closing ? flush() : ""
      return { before, payload: modified ? JSON.stringify(parsed) : null }
    },
    flush,
  }
}

/** `anthropic.messages`: `content_block_delta` / `input_json_delta.partial_json`, keyed by block index. */
function anthropicDecoder(r: StreamRestorer, map: SessionMap, report: (tokens: string[]) => void): FrameDecoder {
  const blocks = tails()
  const kinds = new Map<string, string>()
  const flushBlock = (key: string): string => {
    const t = blocks.get(key)
    if (!t) return ""
    let out = ""
    if (t.pending !== "") {
      out = eventFrame(
        "content_block_delta",
        JSON.stringify({ type: "content_block_delta", index: Number(key), delta: { type: "input_json_delta", partial_json: t.pending } }),
      )
      t.seen += t.pending
      t.pending = ""
    }
    const left = tokensIn(t.seen).filter((k) => map.valueOf(k) === undefined)
    if (left.length) report(left)
    t.seen = ""
    return out
  }
  const flush = (): string => {
    let out = ""
    for (const key of blocks.keys()) out += flushBlock(key)
    return out
  }
  return {
    data(payload, isLast) {
      const parsed = parse(payload)
      if (!parsed) return { before: "", payload: null }
      const key = String(typeof parsed["index"] === "number" ? parsed["index"] : 0)
      switch (parsed["type"]) {
        case "content_block_start": {
          const kind = dict(parsed["content_block"])?.["type"]
          if (typeof kind === "string") kinds.set(key, kind)
          return { before: "", payload: null }
        }
        case "content_block_delta": {
          const delta = dict(parsed["delta"])
          if (!delta || delta["type"] !== "input_json_delta" || typeof delta["partial_json"] !== "string") {
            return { before: "", payload: null } // text_delta, thinking_delta, signature_delta: never touched
          }
          const t = tail(blocks, key)
          const original = delta["partial_json"] as string
          const restored = r.feed(t, original, isLast)
          t.seen += restored
          if (restored === original) return { before: "", payload: null }
          delta["partial_json"] = restored
          return { before: "", payload: JSON.stringify(parsed) }
        }
        case "content_block_stop":
          // The block is closing: whatever it still holds is text, and it
          // must be delivered BEFORE the stop the client closes the block on.
          return { before: flushBlock(key), payload: null }
        case "message_delta":
        case "message_stop":
          return { before: flush(), payload: null }
        default:
          return { before: "", payload: null }
      }
    },
    flush,
  }
}

/**
 * `openai.responses`: `response.function_call_arguments.delta` keyed by
 * `output_index`; the `.done` and terminal events REPEAT the whole value and
 * an SDK builds its result from them, so those are restored whole — inside
 * `arguments` only.
 */
function responsesDecoder(r: StreamRestorer, map: SessionMap, report: (tokens: string[]) => void): FrameDecoder {
  const items = tails()
  const flushItem = (key: string): string => {
    const t = items.get(key)
    if (!t) return ""
    let out = ""
    if (t.pending !== "") {
      out = eventFrame(
        "response.function_call_arguments.delta",
        JSON.stringify({ type: "response.function_call_arguments.delta", output_index: Number(key), delta: t.pending }),
      )
      t.seen += t.pending
      t.pending = ""
    }
    t.seen = ""
    return out
  }
  const flush = (): string => {
    let out = ""
    for (const key of items.keys()) out += flushItem(key)
    return out
  }
  const whole = (holder: Record<string, unknown> | null, field: string): boolean => {
    if (!holder || typeof holder[field] !== "string") return false
    const res = restoreJsonText(holder[field] as string, map)
    if (res.unresolved.length) report(res.unresolved)
    if (res.text === holder[field]) return false
    holder[field] = res.text
    return true
  }
  return {
    data(payload, isLast) {
      const parsed = parse(payload)
      if (!parsed) return { before: "", payload: null }
      const key = String(typeof parsed["output_index"] === "number" ? parsed["output_index"] : 0)
      switch (parsed["type"]) {
        case "response.function_call_arguments.delta": {
          if (typeof parsed["delta"] !== "string") return { before: "", payload: null }
          const t = tail(items, key)
          const original = parsed["delta"] as string
          const restored = r.feed(t, original, isLast)
          t.seen += restored
          if (restored === original) return { before: "", payload: null }
          parsed["delta"] = restored
          return { before: "", payload: JSON.stringify(parsed) }
        }
        case "response.function_call_arguments.done": {
          const before = flushItem(key)
          return { before, payload: whole(parsed, "arguments") ? JSON.stringify(parsed) : null }
        }
        case "response.output_item.done": {
          const before = flushItem(key)
          const item = dict(parsed["item"])
          const changed = item?.["type"] === "function_call" && whole(item, "arguments")
          return { before, payload: changed ? JSON.stringify(parsed) : null }
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          const before = flush()
          let changed = false
          for (const item of list(dict(parsed["response"])?.["output"]).map(dict)) {
            if (item?.["type"] === "function_call" && whole(item, "arguments")) changed = true
          }
          return { before, payload: changed ? JSON.stringify(parsed) : null }
        }
        default:
          return { before: "", payload: null }
      }
    },
    flush,
  }
}

const FRAME_END = /\r?\n\r?\n/

/**
 * The stream rewriter for one protocol and one session map. Chunk boundaries
 * fall anywhere — inside a JSON string, between `\r` and `\n` — so nothing is
 * parsed until a frame is whole; a frame with exactly one `data:` line is
 * handed to the decoder, anything else passes through byte-identical.
 */
export function createSseRestorer(protocol: ModelProtocol, map: SessionMap, opts: SseRestorerOptions = {}): SseRestorer {
  const restorer = createStreamRestorer(map, { encode: jsonStringEncode })
  const report = (tokens: string[]): void => opts.onUnresolved?.(tokens)
  const decoder =
    protocol === "anthropic.messages"
      ? anthropicDecoder(restorer, map, report)
      : protocol === "openai.responses"
        ? responsesDecoder(restorer, map, report)
        : chatDecoder(restorer, map, report)
  let carry = ""

  const frame = (text: string, isLast: boolean): string => {
    const lines = text.split(/(?<=\n)/) // keep each line's own ending
    let dataAt = -1
    let count = 0
    lines.forEach((line, i) => {
      if (line.startsWith("data:")) {
        count += 1
        dataAt = i
      }
    })
    if (count !== 1) return text
    const line = lines[dataAt]!
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""
    let payload = line.slice(5, line.length - ending.length)
    if (payload.startsWith(" ")) payload = payload.slice(1)
    const out = decoder.data(payload, isLast)
    if (out.payload !== null) lines[dataAt] = `data: ${out.payload}${ending}`
    return out.before + lines.join("")
  }

  return {
    feed(chunk) {
      carry += chunk
      let out = ""
      for (;;) {
        const m = FRAME_END.exec(carry)
        if (!m) break
        const end = m.index + m[0].length
        out += frame(carry.slice(0, end), false)
        carry = carry.slice(end)
      }
      return out
    },
    end() {
      let out = ""
      if (carry !== "") {
        out += frame(carry, true)
        carry = ""
      }
      return out + decoder.flush()
    },
  }
}
