/**
 * Local secrets redaction for dsh: which SESSION a masked model request
 * belongs to.
 *
 * The mask itself is `@openguardrails/local-redaction`'s in-process HTTP
 * interceptor — the only seam this harness has (a loop-built
 * `GenerateOptions` is frozen and `dsh-agent-loop`'s invariant asserts its
 * `messages` still equal `session.deriveMessages()`, so the `llm/stream`
 * waterfall can observe a request but never rewrite one). The interceptor
 * sees an HTTP body and nothing else, and a dsh request body carries no
 * session id, so the session key has to be carried out-of-band from the
 * `llm/stream` seam — where dsh does hand us `options.sessionId` — down to
 * the `fetch` the adapter makes several frames later.
 *
 * ⚠️⚠️ **THE OBVIOUS WAY TO DO THAT SILENTLY FAILS, AND ITS FAILURE IS A
 * CROSS-SESSION LEAK.** `AsyncLocalStorage.run(key, () => next())` looks
 * right and is not: `next()` only CONSTRUCTS the downstream async iterable,
 * and an async generator's body runs when the CONSUMER pulls — outside the
 * scope that has already exited. Measured, two concurrent sessions:
 *
 *     als.run(key, () => next())        →  the adapter's fetch sees `undefined`
 *     await als.run(key, () => it.next())  →  A sees A, B sees B
 *
 * With `undefined` every session collapses onto one map key. That is not
 * merely imprecise: `dsh web` serves many conversations from one process, so
 * one shared key means a token minted in one conversation answers a restore
 * in another, and the wrong secret is spliced into a tool call. Nothing
 * throws — the restore succeeds, with the wrong value.
 *
 * So {@link scopeSession} pulls each chunk INSIDE the scope: whatever that
 * pull starts — the adapter's `fetch`, and the interceptor inside it —
 * inherits the store, and the scope is re-entered for every resumption
 * rather than captured once at construction.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { DEFAULT_SESSION_KEY } from "@openguardrails/local-redaction"

const storage = new AsyncLocalStorage<string>()

/**
 * The session key the interceptor should mask this request under: whichever
 * `llm/stream` pull is in flight on this async chain, else the process-wide
 * default (an auxiliary call, or a model call made outside the loop).
 */
export function currentSessionKey(): string {
  return storage.getStore() ?? DEFAULT_SESSION_KEY
}

/**
 * The map key for one dsh session. A model call the loop did not raise has
 * no session id and shares the process-wide key — the same fallback
 * {@link currentSessionKey} answers with, so both vantages agree.
 */
export function sessionKeyFor(sessionId: unknown): string {
  return sessionId === undefined || sessionId === null ? DEFAULT_SESSION_KEY : String(sessionId)
}

/**
 * Re-yield `inner`, pulling every chunk inside `key`'s scope.
 *
 * The pull is what matters — see the module note. Cancellation and early
 * exit are forwarded so a dropped stream still tears the adapter down: a
 * `for await` that breaks calls `return()` on the iterator, and losing that
 * would leak the underlying HTTP response.
 */
export async function* scopeSession<T>(key: string, inner: AsyncIterable<T>): AsyncIterable<T> {
  const it = inner[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await storage.run(key, () => it.next())
      if (step.done) return
      yield step.value
    }
  } finally {
    // `return` is optional on the async-iterator protocol; a generator has it.
    await storage.run(key, async () => {
      await it.return?.(undefined as never)
    })
  }
}
