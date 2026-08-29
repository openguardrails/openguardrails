/**
 * The three provider protocols as the HTTP interceptor needs them: which
 * request is a model call at all, which protocol it speaks, which field the
 * harness stamps a session on, and — on the way back — which fields carry
 * TOOL-CALL ARGUMENTS, the only place a placeholder is restored (D7).
 *
 * Mirrors the higress adapters (`protocol/openai_chat.go`, `anthropic.go`,
 * `openai_responses.go`) and AIRS's `sniffProtocol`: the anthropic test runs
 * FIRST because an Anthropic body and a chat body both carry `messages[]`,
 * and chat is the catch-all by elimination.
 */
import { restoreArgs, restoreJsonText, tokensIn } from "./restore.js"
import type { SessionMap } from "./session.js"

export type ModelProtocol = "openai.chat" | "anthropic.messages" | "openai.responses"

/** Hostnames the default matcher treats as a model API without reading the body first. */
export const DEFAULT_MODEL_HOSTS: readonly string[] = [
  "api.openai.com",
  "api.anthropic.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com",
]

/** `*.openai.azure.com` and the like — suffixes, matched on a label boundary. */
export const DEFAULT_MODEL_HOST_SUFFIXES: readonly string[] = [".openai.azure.com"]

export function isModelHost(hostname: string, extra: readonly string[] = []): boolean {
  const h = hostname.toLowerCase()
  if (DEFAULT_MODEL_HOSTS.includes(h) || extra.some((x) => x.toLowerCase() === h)) return true
  return DEFAULT_MODEL_HOST_SUFFIXES.some((s) => h.endsWith(s))
}

type Dict = Record<string, unknown>
const asDict = (v: unknown): Dict | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Dict) : null)
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function anthropicShaped(body: Dict): boolean {
  if (body["system"] !== undefined) return true
  const tools = asArray(body["tools"]).map(asDict)
  if (tools.some((t) => t && t["input_schema"] !== undefined)) return true
  return asArray(body["messages"]).some((m) =>
    asArray(asDict(m)?.["content"]).some((b) => {
      const t = asDict(b)?.["type"]
      return t === "tool_use" || t === "tool_result" || t === "thinking" || t === "redacted_thinking"
    }),
  )
}

/**
 * Which protocol a request body speaks, or null when it is not a model call.
 * The URL path is a hint, the body decides: `/count_tokens` is never a
 * completion; `messages[]` is anthropic on anthropic's own tells and chat by
 * elimination; `input` (with a `model`) or `instructions` is Responses.
 */
export function sniffProtocol(body: unknown, url?: URL): ModelProtocol | null {
  const b = asDict(body)
  if (!b) return null
  const path = url?.pathname ?? ""
  if (path.endsWith("/count_tokens")) return null
  const messages = Array.isArray(b["messages"])
  if (messages) {
    if (path.endsWith("/messages")) return "anthropic.messages"
    if (path.endsWith("/chat/completions")) return "openai.chat"
    return anthropicShaped(b) ? "anthropic.messages" : "openai.chat"
  }
  if (path.endsWith("/responses") && (b["input"] !== undefined || b["instructions"] !== undefined)) return "openai.responses"
  if (b["input"] !== undefined && typeof b["model"] === "string") return "openai.responses"
  if (typeof b["instructions"] === "string" && typeof b["model"] === "string") return "openai.responses"
  return null
}

/**
 * The session the HARNESS stamped on the request, when it did: OpenAI's
 * `user`, Anthropic's `metadata.user_id`. Null when nothing is stamped — the
 * interceptor then keys the map by a per-process default.
 */
export function stampedSession(body: unknown): string | null {
  const b = asDict(body)
  if (!b) return null
  if (typeof b["user"] === "string" && b["user"] !== "") return b["user"]
  const uid = asDict(b["metadata"])?.["user_id"]
  return typeof uid === "string" && uid !== "" ? uid : null
}

export interface RestoreBodyResult {
  body: string
  changed: boolean
  /** Placeholder-shaped tokens still inside tool-call arguments after the pass. */
  unresolved: string[]
}

/**
 * Restore INSIDE TOOL-CALL ARGUMENTS of a complete (non-streamed) reply and
 * nowhere else — prose keeps its placeholders (D7). An unchanged body is
 * returned byte-identical; a changed one is re-serialised.
 *
 *   openai.chat        choices[].message.tool_calls[].function.arguments  (a JSON string)
 *   anthropic.messages content[].input                                    (an object)
 *   openai.responses   output[].arguments                                  (a JSON string)
 */
export function restoreResponseBody(protocol: ModelProtocol, text: string, map: SessionMap): RestoreBodyResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const body = asDict(parsed)
  if (!body) return null
  let changed = false
  const unresolved = new Set<string>()
  const jsonField = (holder: Dict, key: string): void => {
    const v = holder[key]
    if (typeof v !== "string") return
    const r = restoreJsonText(v, map)
    for (const t of r.unresolved) unresolved.add(t)
    if (r.text !== v) {
      holder[key] = r.text
      changed = true
    }
  }
  switch (protocol) {
    case "openai.chat":
      for (const choice of asArray(body["choices"]).map(asDict)) {
        for (const tc of asArray(asDict(choice?.["message"])?.["tool_calls"]).map(asDict)) {
          const fn = asDict(tc?.["function"])
          if (fn) jsonField(fn, "arguments")
        }
      }
      break
    case "anthropic.messages":
      for (const block of asArray(body["content"]).map(asDict)) {
        if (!block || block["type"] !== "tool_use" || block["input"] === undefined) continue
        const r = restoreArgs(block["input"], map)
        for (const t of r.unresolved) unresolved.add(t)
        if (r.changed) {
          block["input"] = r.args
          changed = true
        }
      }
      break
    case "openai.responses":
      for (const item of asArray(body["output"]).map(asDict)) {
        if (item && item["type"] === "function_call") jsonField(item, "arguments")
      }
      break
  }
  return { body: changed ? JSON.stringify(parsed) : text, changed, unresolved: [...unresolved] }
}

/** Tokens in `text` that `map` cannot answer — what the tool hook will block on. */
export function unresolvedIn(text: string, map: SessionMap): string[] {
  return tokensIn(text).filter((t) => map.valueOf(t) === undefined)
}
