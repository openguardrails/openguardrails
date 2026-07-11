/**
 * Detector plugin interface.
 *
 * A detector is OGR-conformant if it maps a GuardEvent to a Verdict. This is the
 * surface security/safety vendors implement and compete behind. `evaluate` may
 * be sync or async (e.g. a hosted model call).
 */
import type { GuardEvent, Verdict } from "../models.js"

export interface Detector {
  /** Stable identity used for attribution / metering / benchmark. */
  readonly provider: string
  /** Event kinds this detector handles; empty == all kinds. */
  readonly handles?: readonly string[]
  evaluate(ev: GuardEvent): Verdict | Promise<Verdict>
  appliesTo?(ev: GuardEvent): boolean
}

export function appliesTo(detector: Detector, ev: GuardEvent): boolean {
  if (detector.appliesTo) return detector.appliesTo(ev)
  return !detector.handles || detector.handles.length === 0 || detector.handles.includes(ev.kind)
}
