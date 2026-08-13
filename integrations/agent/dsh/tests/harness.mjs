/**
 * Test harness: a real dsh tool registry with this plugin loaded.
 *
 * The tests drive `ctx.tools.execute()` through the genuine pipeline —
 * `tools/pre-execute`, the monotonic guards, dispatch, `tools/post-execute`,
 * `tools/result` — rather than calling the plugin's listeners directly, so a
 * change in how dsh orders or short-circuits that pipeline shows up as a test
 * failure rather than as a silently bypassed guard.
 */
import { Context } from "@deepseek-ai/cordis"
import Tools from "@deepseek-ai/dsh-tools"
import SystemPrompt from "@deepseek-ai/dsh-system-prompt"

import * as plugin from "../dist/index.js"

/** A tool that echoes its arguments; enough to exercise the whole pipeline. */
export function echoTool(name) {
  return {
    name,
    description: `echo (${name})`,
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, url: { type: "string" } },
    },
    output: {
      schema: { type: "object", properties: { echoed: { type: "string" } } },
      render: (_args, value) => [{ type: "text", text: String(value.echoed) }],
    },
    execute: async (args) => ({ echoed: String(args?.command ?? args?.url ?? "") }),
  }
}

/**
 * Boot a registry with the plugin applied.
 * @param config - the plugin's cordis config.
 * @param tools - tool names to register (default: `bash`).
 * @returns the context plus a `call()` helper.
 */
export async function boot(config = {}, tools = ["bash"]) {
  const ctx = new Context()
  // Capture what the plugin reports instead of printing it. Policy resolution
  // is lazy — the first call in a workspace is what reads its policy file — so
  // the capture has to stay installed for the whole session, not just across
  // plugin load.
  const warnings = []
  ctx.logger = {
    warn: (message) => warnings.push(String(message)),
    info: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
  }
  ctx.plugin(SystemPrompt)
  ctx.plugin(Tools)
  await tick()

  for (const name of tools) ctx.tools.register(echoTool(name))
  ctx.plugin(plugin, plugin.Config(config))
  await tick()

  let seq = 0
  /** Run one tool call through the pipeline and return its normalized result. */
  const call = (name, args, options = {}) =>
    ctx.tools.execute({
      callId: `call-${++seq}`,
      name,
      arguments: args,
      signal: options.signal ?? new AbortController().signal,
      ...options.agent ? { agent: options.agent } : {},
    })

  return { ctx, call, warnings }
}

/** Let Cordis settle its fibers (plugin apply is asynchronous). */
export function tick(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The concatenated text of a result's content blocks. */
export function text(result) {
  return result.content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n")
}
