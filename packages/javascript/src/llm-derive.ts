import type { GuardEvent } from "./models.js"

/**
 * The developer path (OGR v0.6): a caller forwards the UNTOUCHED provider
 * body — `llm_request` before it reaches the model, `llm_response` before
 * the agent acts on the answer — and the PDP classifies it. This is the
 * SDK-side twin of the hosted runtime's derivation, so the in-process
 * `Runtime` speaks the same contract as the platform.
 *
 * The derivation rewrites the event IN PLACE into the judged shape the
 * detectors read:
 *
 *   llm_request  → `user_input` (a user turn heads the new input) or
 *                  `tool_result` (a continuation feeding outcomes back),
 *                  payload { text?, tool_results?, tools?, system? }
 *   llm_response → `model_output`, payload { text, reasoning?, tool_calls? }
 *
 * ⚠️ Only the NEW input is classified — everything after the last assistant
 * turn. Re-scanning history would double-count findings on every turn.
 *
 * A body matching no known protocol keeps its raw kind with
 * `payload.unparsed = true`: arrived-but-not-judged is a signal, never a
 * silent drop. Protocols: `openai.chat`, `anthropic.messages`;
 * `llm_protocol` is a hint, the shape is sniffed when absent.
 */

type Dict = Record<string, unknown>

const MAX_TOOLS = 64

function asDict(v: unknown): Dict | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  return asArray(content)
    .map((part) => {
      const p = asDict(part)
      if (!p) return ""
      if (typeof p.text === "string") return p.text
      if (typeof p.content === "string") return p.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function sniffProtocol(ev: GuardEvent): "openai.chat" | "anthropic.messages" | null {
  const hint = ev.llmProtocol
  if (hint === "openai.chat" || hint === "anthropic.messages") return hint
  const p = ev.payload as Dict
  const messages = asArray(p.messages)
  if (ev.kind === "llm_response") {
    if (asArray(p.choices).length > 0) return "openai.chat"
    if (p.type === "message" || asArray(p.content).length > 0) return "anthropic.messages"
    return null
  }
  if (messages.length === 0) return null
  if (typeof p.system === "string" || typeof p.system === "object") return "anthropic.messages"
  const tools = asArray(p.tools).map(asDict).filter(Boolean) as Dict[]
  if (tools.some((t) => t.input_schema !== undefined)) return "anthropic.messages"
  if (tools.some((t) => t.function !== undefined || t.type === "function")) return "openai.chat"
  const blocks = messages.some((m) =>
    asArray(asDict(m)?.content).some((b) => {
      const t = asDict(b)?.type
      return t === "tool_result" || t === "tool_use"
    }),
  )
  return blocks ? "anthropic.messages" : "openai.chat"
}

function normalizeTools(proto: string, tools: unknown): Dict[] | null {
  const list = asArray(tools).slice(0, MAX_TOOLS).map(asDict).filter(Boolean) as Dict[]
  if (list.length === 0) return null
  return list.map((t) => {
    const fn = asDict(t.function)
    if (proto === "openai.chat" && fn) {
      return { name: fn.name, description: fn.description ?? "", schema: fn.parameters ?? {} }
    }
    return { name: t.name, description: t.description ?? "", schema: t.input_schema ?? t.parameters ?? {} }
  })
}

function deriveRequest(ev: GuardEvent, proto: "openai.chat" | "anthropic.messages"): void {
  const p = ev.payload as Dict
  const messages = asArray(p.messages).map(asDict).filter(Boolean) as Dict[]

  let system = ""
  if (proto === "anthropic.messages") {
    system = typeof p.system === "string" ? p.system : textOf(p.system)
  } else {
    system = messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => textOf(m.content))
      .join("\n")
  }

  let lastAssistant = -1
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i
  })
  const fresh = messages.slice(lastAssistant + 1)

  const userTexts: string[] = []
  const results: Dict[] = []
  for (const m of fresh) {
    if (m.role === "tool") {
      results.push({ tool_call_id: m.tool_call_id ?? "", result: textOf(m.content) })
      continue
    }
    if (m.role !== "user") continue
    const blocks = asArray(m.content).map(asDict).filter(Boolean) as Dict[]
    for (const b of blocks.filter((b) => b.type === "tool_result")) {
      results.push({ tool_call_id: b.tool_use_id ?? "", result: textOf(b.content) })
    }
    const text =
      typeof m.content === "string"
        ? m.content
        : blocks
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? ""))
            .join("\n")
    if (text) userTexts.push(text)
  }

  const payload: Dict = {}
  const userText = userTexts.join("\n")
  if (userText) payload.text = userText
  if (results.length > 0) payload.tool_results = results
  const tools = normalizeTools(proto, p.tools)
  if (tools) payload.tools = tools
  if (system) payload.system = system

  ev.kind = userText ? "user_input" : results.length > 0 ? "tool_result" : "user_input"
  ev.payload = payload
  ev.llmProtocol = proto
}

function deriveResponse(ev: GuardEvent, proto: "openai.chat" | "anthropic.messages"): void {
  const p = ev.payload as Dict
  const payload: Dict = {}
  const calls: Dict[] = []

  if (proto === "openai.chat") {
    const msg = asDict(asDict(asArray(p.choices)[0])?.message) ?? {}
    payload.text = textOf(msg.content)
    if (typeof msg.reasoning === "string" && msg.reasoning) payload.reasoning = msg.reasoning
    for (const raw of asArray(msg.tool_calls)) {
      const tc = asDict(raw)
      const fn = asDict(tc?.function)
      if (!tc || !fn) continue
      let args: unknown = fn.arguments
      if (typeof args === "string") {
        try {
          args = JSON.parse(args)
        } catch {
          args = { input: args }
        }
      }
      calls.push({ id: tc.id ?? "", name: fn.name ?? "", arguments: args ?? {} })
    }
  } else {
    const blocks = asArray(p.content).map(asDict).filter(Boolean) as Dict[]
    payload.text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("\n")
    const thinking = blocks
      .filter((b) => b.type === "thinking")
      .map((b) => String(b.thinking ?? ""))
      .join("\n")
    if (thinking) payload.reasoning = thinking
    for (const b of blocks) {
      if (b.type !== "tool_use") continue
      calls.push({ id: b.id ?? "", name: b.name ?? "", arguments: b.input ?? {} })
    }
  }

  if (calls.length > 0) payload.tool_calls = calls
  ev.kind = "model_output"
  ev.payload = payload
  ev.llmProtocol = proto
}

/**
 * Classify an `llm_request`/`llm_response` event in place; a no-op for every
 * other kind. Never throws: an unrecognizable body keeps its raw kind with
 * `payload.unparsed = true`.
 */
export function deriveLlmEvent(ev: GuardEvent): void {
  if (ev.kind !== "llm_request" && ev.kind !== "llm_response") return
  try {
    const proto = sniffProtocol(ev)
    if (!proto) {
      ;(ev.payload as Dict).unparsed = true
      return
    }
    if (ev.kind === "llm_request") deriveRequest(ev, proto)
    else deriveResponse(ev, proto)
  } catch {
    ;(ev.payload as Dict).unparsed = true
  }
}
