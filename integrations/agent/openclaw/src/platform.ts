/**
 * Optional platform reporter: ship this plugin's GuardEvents to an
 * OpenGuardrails runtime with an enrolled per-MACHINE identity.
 *
 * OpenClaw is the "one daemon per machine" case of the identity design
 * (runtime docs/agent-identity-and-service-auth.md §7): every terminal talks
 * to the same assistant process, so one Ed25519 key per machine
 * (~/.ogr/openclaw-ed25519.json) and one asserted identity
 * `openclaw-<hostname>` with a `client_key` attestation claim — the runtime
 * clamps the claim to the key's enrollment scope.
 *
 * Local enforcement stays authoritative; reporting is fire-and-forget and is
 * enabled only when OGR_RUNTIME_URL + OGR_API_KEY are set. Any failure —
 * missing key material, failed enrollment, an unreachable runtime — leaves
 * the plugin running exactly as before.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"

import type { GuardEvent } from "@openguardrails/core"

const BATCH_MAX = 50
const FLUSH_MS = 2000
const QUEUE_MAX = 1000

export function hostAgentId(): string {
  return `openclaw-${hostname()}`
}

function b64url(raw: Buffer): string {
  return raw.toString("base64url")
}

class PepIdentity {
  keyfile: string
  guardId: string | null = null
  keyId: string | null = null
  private key: KeyObject | null = null

  constructor(keyfile?: string) {
    this.keyfile =
      keyfile || process.env.OGR_KEYFILE || join(homedir(), ".ogr", "openclaw-ed25519.json")
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
      console.warn(`[openguardrails] PEP identity unavailable (${String(err)}) — reporting unsigned`)
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

  async enroll(baseUrl: string, apiKey: string): Promise<boolean> {
    if (!this.key) return false
    if (this.guardId && this.keyId) return true
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/public/ogr/v1/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          public_key: this.publicKeyB64url(),
          guard_id: `openclaw-hook-${hostname()}`,
          name: `openclaw hook (${hostname()})`,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const cred = (await res.json()) as { guard_id: string; key_id: string }
      this.guardId = cred.guard_id
      this.keyId = cred.key_id
      this.persist()
      console.info(`[openguardrails] enrolled: ${this.guardId} (${this.keyId})`)
      return true
    } catch (err) {
      console.warn(`[openguardrails] enrollment failed (${String(err)}) — reporting unsigned`)
      return false
    }
  }

  signatureHeader(body: Buffer): string | null {
    if (!this.key || !this.keyId) return null
    const header = b64url(Buffer.from(JSON.stringify(
      { alg: "EdDSA", kid: this.keyId, b64: false, crit: ["b64"] },
    )))
    const sig = sign(null, Buffer.concat([Buffer.from(header, "ascii"), Buffer.from("."), body]), this.key)
    return `${header}..${b64url(sig)}`
  }
}

/** JS-core camelCase GuardEvent → OGR wire (snake_case, empties dropped). */
export function eventToWire(ev: GuardEvent): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ogr_version: ev.ogrVersion ?? "0.3",
    event_id: ev.eventId,
    guard_id: ev.guardId,
    timestamp: ev.timestamp,
    observation_point: ev.observationPoint,
    kind: ev.kind,
    subject: ev.subject,
    payload: ev.payload,
  }
  if (ev.sessionId) wire.session_id = ev.sessionId
  if (ev.llmProtocol) wire.llm_protocol = ev.llmProtocol
  if (ev.contextRefs?.length) wire.context_refs = ev.contextRefs
  if (ev.provenance?.length) {
    wire.provenance = ev.provenance.map((p) => ({
      source: p.source,
      trust: p.trust,
      ...(p.ref ? { ref: p.ref } : {}),
      ...(p.taintTags?.length ? { taint_tags: p.taintTags } : {}),
    }))
  }
  return wire
}

class PlatformReporter {
  readonly enabled: boolean
  private readonly baseUrl: string
  private readonly apiKey: string
  private identity: PepIdentity | null = null
  private enrolling: Promise<boolean> | null = null
  private queue: Record<string, unknown>[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.baseUrl = (process.env.OGR_RUNTIME_URL ?? "").replace(/\/$/, "")
    this.apiKey = process.env.OGR_API_KEY ?? ""
    this.enabled = Boolean(this.baseUrl && this.apiKey)
    if (this.enabled) {
      this.identity = new PepIdentity()
      this.enrolling = this.identity.enroll(this.baseUrl, this.apiKey)
      this.timer = setInterval(() => void this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
  }

  /** Queue one GuardEvent. Never throws, never blocks the hook path. */
  report(ev: GuardEvent): void {
    if (!this.enabled) return
    if (this.queue.length >= QUEUE_MAX) this.queue.shift()
    this.queue.push(eventToWire(ev))
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return
    await this.enrolling
    const batch = this.queue.splice(0, BATCH_MAX)
    const body = Buffer.from(JSON.stringify({ batch }), "utf8")
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    }
    const signature = this.identity?.signatureHeader(body)
    if (signature) headers["ogr-batch-signature"] = signature
    try {
      const res = await fetch(`${this.baseUrl}/api/public/ogr/v1/ingest`, {
        method: "POST",
        headers,
        body,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn(`[openguardrails] ingest failed (${String(err)}) — ${batch.length} events dropped`)
    }
  }
}

let reporter: PlatformReporter | null = null

export function getReporter(): PlatformReporter {
  if (!reporter) reporter = new PlatformReporter()
  return reporter
}
