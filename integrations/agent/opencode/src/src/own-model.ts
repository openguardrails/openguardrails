/**
 * "Use your own model as the guardrail" — an OGR LLMBackend that calls any
 * OpenAI-compatible chat-completions endpoint. Point it at the same model the
 * agent already uses, a cheaper sibling, or a dedicated guard model.
 */
import type { LLMBackend } from "@openguardrails/core"
import type { JudgeConfig } from "./config.js"

export function openAICompatibleBackend(cfg: JudgeConfig): LLMBackend {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions"
  return {
    name: `own-model:${cfg.model}`,
    async complete(system: string, user: string): Promise<string> {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...(cfg.headers ?? {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      })
      if (!res.ok) throw new Error(`guard model returned ${res.status}`)
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = data.choices?.[0]?.message?.content ?? ""
      // Strip a ```json fence if the model wrapped its reply.
      return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    },
  }
}
