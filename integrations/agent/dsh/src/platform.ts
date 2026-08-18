/**
 * Host identity for the harness process.
 *
 * dsh is the "one harness process per machine" case: every session, agent and
 * subagent runs inside the same host process, so the asserted identity is
 * `dsh-<hostname>` and `agent_user` defaults to the OS account — the best a
 * local single-user harness can assert. The runtime treats every identity
 * field as a CLAIM bounded by the API key's tenant.
 *
 * (The v0.6 Ed25519 enrollment and request signing lived here; v0.7 deleted
 * enrollment from the protocol, so the key file, the signer and the enroll
 * cache went with it.)
 */
import { hostname, userInfo } from "node:os"

/** Machine-scoped asserted identity for the harness process. */
export function hostAgentId(): string {
  return `dsh-${hostname()}`
}

/** The OS account the harness runs as, or undefined when unreadable. */
export function osUser(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}
