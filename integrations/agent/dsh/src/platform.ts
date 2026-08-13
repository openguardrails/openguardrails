/**
 * Optional platform reporter: ship this plugin's GuardEvents to an
 * OpenGuardrails runtime with an enrolled per-MACHINE identity.
 *
 * dsh is the "one harness process per machine" case of the identity design
 * (runtime docs/agent-identity-and-service-auth.md §7): every session, agent
 * and subagent runs inside the same host process, so one Ed25519 key per
 * machine (~/.ogr/dsh-ed25519.json) and one asserted identity `dsh-<hostname>`
 * with a `client_key` attestation claim — the runtime clamps the claim to the
 * key's enrollment scope.
 *
 * Transport, signing and wire mapping come from `@openguardrails/core`'s
 * RuntimeClient (canonical `/v1/...` paths; the client's mount-compat fallback
 * discovers deployments that only serve `/api/public/ogr`). What stays here is
 * what is dsh-specific: the key file, the enroll-once cache, the batch queue,
 * and the default sensor.
 *
 * Local enforcement stays authoritative; reporting is fire-and-forget and is
 * enabled only when OGR_RUNTIME_URL + OGR_API_KEY are set. Any failure —
 * missing key material, failed enrollment, an unreachable runtime — leaves the
 * plugin enforcing exactly as before.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"

import {
  RuntimeClient,
  createNodeSigner,
  eventToWire as coreEventToWire,
  type GuardEvent,
  type Signer,
  type Verdict,
} from "@openguardrails/core"

const BATCH_MAX = 50
const FLUSH_MS = 2000
const QUEUE_MAX = 1000

// The mechanism axis. Every altitude this plugin reports comes from a Cordis
// listener running inside the dsh process, so a deployment that stops loading
// the plugin stops being observed — `in_process`, never adversary-proof. The
// default lives HERE, not in the core: the SDK deliberately doesn't invent a
// sensor.
const DEFAULT_SENSOR_ID = "openguardrails-dsh"

/** Machine-scoped asserted identity for the harness process. */
export function hostAgentId(): string {
  return `dsh-${hostname()}`
}

function withDefaultSensor(ev: GuardEvent): GuardEvent {
  return ev.sensorId
    ? ev
    : { ...ev, sensorId: DEFAULT_SENSOR_ID, sensorType: "in_process" }
}

/**
 * JS-core camelCase GuardEvent → OGR wire (snake_case, empties dropped), with
 * this plugin's default sensor applied. Delegates to the core's canonical
 * converter.
 */
export function eventToWire(ev: GuardEvent): Record<string, unknown> {
  return coreEventToWire(withDefaultSensor(ev))
}

/** Log sink; the plugin passes dsh's own logger so reporter noise stays in the harness log. */
export interface ReporterLog {
  info(message: string): void
  warn(message: string): void
}

const consoleLog: ReporterLog = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
}

class PepIdentity {
  keyfile: string
  guardId: string | null = null
  keyId: string | null = null
  private key: KeyObject | null = null

  constructor(private readonly log: ReporterLog, keyfile?: string) {
    this.keyfile =
      keyfile || process.env.OGR_KEYFILE || join(homedir(), ".ogr", "dsh-ed25519.json")
    this.loadOrCreate()
  }

  private loadOrCreate(): void {
    try {
      if (existsSync(this.keyfile)) {
        const stored = JSON.parse(readFileSync(this.keyfile, "utf8")) as {
          d: string; x: string; guard_id?: string; key_id?: string
        }
        this.key = createPrivateKey({
          key: { kty: "OKP", crv: "Ed25519", d: stored.d, x: stored.x },
          format: "jwk",
        })
        this.guardId = stored.guard_id ?? null
        this.keyId = stored.key_id ?? null
      } else {
        const { privateKey } = generateKeyPairSync("ed25519")
        this.key = privateKey
        this.persist()
      }
    } catch (err) {
      this.log.warn(`[openguardrails] PEP identity unavailable (${String(err)}) — reporting unsigned`)
      this.key = null
    }
  }

  private jwk(): { d: string; x: string } {
    return this.key!.export({ format: "jwk" }) as unknown as { d: string; x: string }
  }

  private persist(): void {
    const { d, x } = this.jwk()
    mkdirSync(dirname(this.keyfile), { recursive: true })
    writeFileSync(
      this.keyfile,
      JSON.stringify({ d, x, guard_id: this.guardId, key_id: this.keyId }),
    )
    chmodSync(this.keyfile, 0o600)
  }

  publicKeyB64url(): string | null {
    return this.key ? this.jwk().x : null
  }

  async enroll(client: RuntimeClient): Promise<boolean> {
    if (!this.key) return false
    if (this.guardId && this.keyId) return true
    try {
      const cred = await client.enroll({
        publicKey: this.publicKeyB64url()!,
        pepId: `dsh-plugin-${hostname()}`,
        name: `dsh plugin (${hostname()})`,
      })
      this.guardId = cred.pepId
      this.keyId = cred.keyId
      this.persist()
      this.log.info(`[openguardrails] enrolled: ${this.guardId} (${this.keyId})`)
      return true
    } catch (err) {
      this.log.warn(`[openguardrails] enrollment failed (${String(err)}) — reporting unsigned`)
      return false
    }
  }

  /** A Signer for the enrolled key, or null before/without enrollment. */
  async signer(): Promise<Signer | null> {
    if (!this.key || !this.keyId) return null
    return createNodeSigner(this.key, this.keyId)
  }
}

/**
 * Fire-and-forget batching reporter. Disposable, because a dsh plugin unloads
 * (hot reload, `--patch` swap) and must not leave an interval or an in-flight
 * batch behind.
 */
export class PlatformReporter {
  readonly enabled: boolean
  private client: RuntimeClient | null = null
  private identity: PepIdentity | null = null
  private signer: Signer | null = null
  private enrolling: Promise<void> | null = null
  private queue: GuardEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly log: ReporterLog = consoleLog) {
    const baseUrl = process.env.OGR_RUNTIME_URL ?? ""
    const apiKey = process.env.OGR_API_KEY ?? ""
    this.enabled = Boolean(baseUrl && apiKey)
    if (this.enabled) {
      // The delegating signer lets requests go out unsigned until enrollment
      // lands — the runtime accepts them at the unenrolled attestation floor.
      this.client = new RuntimeClient({
        baseUrl,
        apiKey,
        signer: { sign: (body) => this.signer?.sign(body) ?? null },
      })
      this.identity = new PepIdentity(log)
      this.enrolling = this.enroll()
      this.timer = setInterval(() => void this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
  }

  private async enroll(): Promise<void> {
    if (!(await this.identity!.enroll(this.client!))) return
    try {
      this.signer = await this.identity!.signer()
    } catch (err) {
      this.log.warn(`[openguardrails] signer unavailable (${String(err)}) — reporting unsigned`)
    }
  }

  /**
   * Evaluate ONE GuardEvent synchronously against the runtime and return its
   * Verdict — the developer path (`llm_request`/`llm_response`), where the
   * classification is the RUNTIME's job and a local detector chain has nothing
   * useful to say.
   *
   * Returns `null` when reporting is not configured or the call failed, which
   * the caller reads as "no opinion". Deciding what a missing verdict means is
   * the caller's job, not this transport's: an observational site ignores it,
   * an enforcing site consults its own fail-closed setting.
   */
  async evaluate(ev: GuardEvent): Promise<Verdict | null> {
    if (!this.enabled) return null
    await this.enrolling
    try {
      return await this.client!.evaluate(withDefaultSensor(ev))
    } catch (err) {
      this.log.warn(`[openguardrails] evaluate failed (${String(err)}) — no verdict`)
      return null
    }
  }

  /** Queue one GuardEvent. Never throws, never blocks the enforcement path. */
  report(ev: GuardEvent): void {
    if (!this.enabled) return
    if (this.queue.length >= QUEUE_MAX) this.queue.shift()
    this.queue.push(withDefaultSensor(ev))
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return
    await this.enrolling
    const batch = this.queue.splice(0, BATCH_MAX)
    try {
      await this.client!.ingest(batch)
    } catch (err) {
      this.log.warn(`[openguardrails] ingest failed (${String(err)}) — ${batch.length} events dropped`)
    }
  }

  /** Stop the timer and drain what is queued. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.flush()
  }
}
