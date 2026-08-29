/**
 * @openguardrails/local-redaction — the reference mask()/restore() for OGR
 * local secrets redaction (OGR 1.4, specification/local-redaction.md).
 *
 * Zero runtime dependencies. Thin on purpose: fetch/cache/verify the served
 * ruleset, a per-session value↔token map, `mask` and `restore` with the
 * exact procedures the specification names, one glue object
 * ({@link LocalRedactor}) an integration keys by its host's session id, and
 * the in-process HTTP interceptor ({@link installHttpInterceptor}) that masks
 * at the layer every harness shares. The conformance corpus in
 * `conformance/local-redaction.json` runs against this package and against
 * the Python reference alike.
 */
export {
  compileRuleset,
  defaultCachePath,
  DEFAULT_TIERS,
  loadRuleset,
  readCachedRuleset,
  ruleSpans,
  writeCachedRuleset,
  type CompiledPattern,
  type CompiledRule,
  type CompiledRuleset,
  type DisabledRule,
  type LoadOptions,
  type LoadResult,
  type Rule,
  type RulePattern,
  type Ruleset,
  type RuleTier,
  type Span,
} from "./ruleset.js"
export {
  DEFAULT_BOUND,
  OVERFLOW_TOKEN,
  SECRET_TOKEN_PREFIX,
  SessionMap,
  SessionMaps,
  type SessionMapOptions,
  type TokenGrant,
} from "./session.js"
export {
  mask,
  maskKnown,
  maskLeaves,
  maskRequest,
  STRUCTURAL_KEYS,
  TOKEN_RE,
  type MaskResult,
  type Minted,
  type WalkResult,
} from "./mask.js"
export {
  createStreamRestorer,
  jsonStringEncode,
  restore,
  restoreArgs,
  restoreArgsAcross,
  restoreJsonText,
  tokensIn,
  UNRESTORABLE_NOTICE,
  type RestoreArgsResult,
  type RestoreResult,
  type StreamRestorer,
  type ValueEncoder,
} from "./restore.js"
export {
  DEFAULT_MODEL_HOST_SUFFIXES,
  DEFAULT_MODEL_HOSTS,
  isModelHost,
  restoreResponseBody,
  sniffProtocol,
  stampedSession,
  type ModelProtocol,
  type RestoreBodyResult,
} from "./protocol.js"
export { createSseRestorer, type SseRestorer, type SseRestorerOptions } from "./sse.js"
export {
  DEFAULT_SESSION_KEY,
  installHttpInterceptor,
  interceptorStatus,
  uninstallHttpInterceptor,
  UnprotectedRequestError,
  type HttpInterceptorHandle,
  type HttpInterceptorOptions,
  type InterceptorStatus,
} from "./http.js"
export {
  LocalRedactor,
  type RedactionReport,
  type RedactorLog,
  type RedactorOptions,
  type TrafficWitness,
} from "./redactor.js"
