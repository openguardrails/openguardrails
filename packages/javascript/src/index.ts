/**
 * @openguardrails/core — the OpenGuardrails (OGR) reference runtime for
 * JavaScript/TypeScript. A vendor-neutral protocol for AI agent safety &
 * security: GuardEvent → Verdict, composed under a policy you own.
 *
 * The TS counterpart of the Python `openguardrails` package. Zero dependencies.
 */
export * from "./models.js"
export * from "./composition.js"
export * from "./runtime.js"
export { type Detector, appliesTo } from "./detectors/index.js"
export { ConfigRulesDetector, type ConfigRules, type CommandRule } from "./detectors/config-rules.js"
export { LLMJudgeDetector, HeuristicBackend, type LLMBackend, SYSTEM_PROMPT } from "./detectors/llm-judge.js"
