/**
 * OGR runtime — the Policy Decision Point.
 *
 * Ingests GuardEvents, propagates provenance, correlates by guardId across
 * observation points, fans out to detectors, composes one effective verdict.
 */
import { type GuardEvent, type Verdict, severity } from "./models.js"
import { type Composition, compose, selectRule } from "./composition.js"
import { type Detector, appliesTo } from "./detectors/index.js"

export interface Policy {
  composition?: Composition
  [key: string]: unknown
}

export class Runtime {
  private readonly composition: Composition
  private readonly events = new Map<string, GuardEvent>() // eventId -> event
  private readonly byGuard = new Map<string, Verdict>() // guardId -> effective verdict so far

  constructor(
    private readonly detectors: Detector[],
    policy: Policy,
  ) {
    this.composition = policy.composition ?? {}
  }

  /** Inherit provenance from referenced prior events. */
  private enrich(ev: GuardEvent): GuardEvent {
    for (const ref of ev.contextRefs ?? []) {
      const prior = this.events.get(ref)
      if (prior) ev.provenance.push(...prior.provenance)
    }
    return ev
  }

  async evaluate(ev: GuardEvent): Promise<Verdict> {
    this.enrich(ev)
    this.events.set(ev.eventId, ev)

    const applicable = this.detectors.filter((d) => appliesTo(d, ev))
    const verdicts = await Promise.all(applicable.map((d) => Promise.resolve(d.evaluate(ev))))

    const rule = selectRule(verdicts, this.composition)
    const effective = compose(ev, verdicts, rule)

    // guardId correlation: a later altitude can only tighten a prior decision.
    const prior = this.byGuard.get(ev.guardId)
    if (prior && severity(prior.decision) < severity(effective.decision)) {
      effective.decision = prior.decision
      effective.reasons.push(
        `[correlation] tightened to prior decision '${prior.decision}' from earlier observation point`,
      )
    }
    this.byGuard.set(ev.guardId, effective)
    return effective
  }
}
