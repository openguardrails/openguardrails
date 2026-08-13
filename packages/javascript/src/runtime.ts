/**
 * OGR runtime — the Policy Decision Point.
 *
 * Ingests GuardEvents, propagates provenance, correlates by guardId across
 * observation points, fans out to detectors, composes one effective verdict.
 */
import { type GuardEvent, type ResolvedGuardEvent, type Verdict, severity } from "./models.js"
import { type Composition, compose, selectRule } from "./composition.js"
import { type Detector, appliesTo } from "./detectors/index.js"
import { deriveLlmEvent } from "./llm-derive.js"

export interface Policy {
  composition?: Composition
  [key: string]: unknown
}

let idSeq = 0

/** Runtime-assigned event id (OGR v0.6: identifiers are born at the PDP). */
function mintEventId(): string {
  idSeq += 1
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 12) ?? Math.floor(Math.random() * 1e9).toString(36)
  return `evt-${Date.now().toString(36)}-${idSeq.toString(36)}-${rand}`
}

export class Runtime {
  private readonly composition: Composition
  private readonly byGuard = new Map<string, Verdict>() // guardId -> effective verdict so far

  constructor(
    private readonly detectors: Detector[],
    policy: Policy,
  ) {
    this.composition = policy.composition ?? {}
  }

  async evaluate(ev: GuardEvent): Promise<Verdict> {
    // OGR v0.6: identifiers are born at the runtime. An in-process Runtime IS
    // the PDP, so it assigns what the caller did not send: event identity
    // always, guard group defaulting to the event itself. Raw provider
    // bodies (llm_request/llm_response) are classified here too — the PDP's
    // job, wherever the PDP runs.
    deriveLlmEvent(ev)
    if (!ev.eventId) ev.eventId = mintEventId()
    if (!ev.guardId) ev.guardId = ev.eventId
    const rev = ev as ResolvedGuardEvent

    const applicable = this.detectors.filter((d) => appliesTo(d, rev))
    const verdicts = await Promise.all(applicable.map((d) => Promise.resolve(d.evaluate(rev))))

    const rule = selectRule(verdicts, this.composition)
    const effective = compose(rev, verdicts, rule)

    // guardId correlation: a later altitude can only tighten a prior decision.
    const prior = this.byGuard.get(rev.guardId)
    if (prior && severity(prior.decision) < severity(effective.decision)) {
      effective.decision = prior.decision
      effective.reasons.push(
        `[correlation] tightened to prior decision '${prior.decision}' from earlier observation point`,
      )
    }
    this.byGuard.set(rev.guardId, effective)
    return effective
  }
}
