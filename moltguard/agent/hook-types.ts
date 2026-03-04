/**
 * Type definitions for all 24 OpenClaw plugin hooks.
 *
 * These types define the event data structure for each hook,
 * enabling complete context reporting to Core for intent-action mismatch detection.
 */

// =============================================================================
// Hook Type Enum
// =============================================================================

export type HookType =
  // Agent lifecycle
  | "before_agent_start"
  | "agent_end"
  | "session_start"
  | "session_end"
  // Messages
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "before_message_write"
  // LLM interactions
  | "before_model_resolve"
  | "before_prompt_build"
  | "llm_input"
  | "llm_output"
  // Tool calls
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist"
  // Compaction
  | "before_compaction"
  | "after_compaction"
  | "before_reset"
  // Subagents
  | "subagent_spawning"
  | "subagent_delivery_target"
  | "subagent_spawned"
  | "subagent_ended"
  // Gateway
  | "gateway_start"
  | "gateway_stop";

// =============================================================================
// Blocking vs Non-Blocking Hook Classification
// =============================================================================

/** Hooks that require synchronous response from Core (can block execution) */
export const BLOCKING_HOOKS: Set<HookType> = new Set([
  "before_tool_call",
  "subagent_spawning",
  "message_sending",
  "before_message_write",
]);

/** Check if a hook type requires synchronous (blocking) reporting */
export function isBlockingHook(hookType: HookType): boolean {
  return BLOCKING_HOOKS.has(hookType);
}

// =============================================================================
// Hook Event Data Types
// =============================================================================

/** Base event data shared by all hooks */
export type BaseEventData = {
  /** ISO 8601 timestamp when the event occurred */
  timestamp: string;
};

// ─── Agent Lifecycle ─────────────────────────────────────────────────────────

export type BeforeAgentStartData = BaseEventData & {
  /** Initial user prompt/intent */
  prompt: string;
  /** System prompt if any */
  systemPrompt?: string;
  /** Conversation ID if resuming */
  conversationId?: string;
};

export type AgentEndData = BaseEventData & {
  /** How the agent ended */
  reason: "user_exit" | "error" | "timeout" | "completed" | "unknown";
  /** Error message if ended due to error */
  error?: string;
  /** Total duration of the conversation in ms */
  durationMs?: number;
};

export type SessionStartData = BaseEventData & {
  /** Session identifier */
  sessionId: string;
  /** Whether this is a new or resumed session */
  isNew: boolean;
};

export type SessionEndData = BaseEventData & {
  /** Session identifier */
  sessionId: string;
  /** Session duration in ms */
  durationMs?: number;
};

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageReceivedData = BaseEventData & {
  /** Who sent the message */
  from: "user" | "assistant" | "system" | "tool";
  /** Message content (may be truncated for large content) */
  content: string;
  /** Content length before truncation */
  contentLength: number;
};

export type MessageSendingData = BaseEventData & {
  /** Target of the message */
  to: "user" | "llm" | "tool";
  /** Message content (may be truncated) */
  content: string;
  /** Content length before truncation */
  contentLength: number;
};

export type MessageSentData = BaseEventData & {
  /** Target of the message */
  to: "user" | "llm" | "tool";
  /** Success status */
  success: boolean;
  /** Duration to send in ms */
  durationMs?: number;
};

export type BeforeMessageWriteData = BaseEventData & {
  /** File path being written to (e.g., JSONL log) */
  filePath: string;
  /** Message being written (may be truncated) */
  content: string;
  /** Content length before truncation */
  contentLength: number;
};

// ─── LLM Interactions ────────────────────────────────────────────────────────

export type BeforeModelResolveData = BaseEventData & {
  /** Requested model ID/name */
  requestedModel: string;
};

export type BeforePromptBuildData = BaseEventData & {
  /** Number of messages in history */
  messageCount: number;
  /** Total token estimate */
  tokenEstimate?: number;
};

export type LlmInputData = BaseEventData & {
  /** Model being called */
  model: string;
  /** Full prompt content (may be truncated for very large prompts) */
  content: string;
  /** Content length before truncation */
  contentLength: number;
  /** Number of messages in the request */
  messageCount: number;
  /** Token count if available */
  tokenCount?: number;
  /** System prompt if separate */
  systemPrompt?: string;
};

export type LlmOutputData = BaseEventData & {
  /** Model that responded */
  model: string;
  /** Response content (may be truncated) */
  content: string;
  /** Content length before truncation */
  contentLength: number;
  /** Whether the response was streamed */
  streamed: boolean;
  /** Tokens used (input + output) if available */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  /** Latency to first token / full response in ms */
  latencyMs: number;
  /** Stop reason */
  stopReason?: "end_turn" | "max_tokens" | "tool_use" | "error" | string;
};

// ─── Tool Calls ──────────────────────────────────────────────────────────────

export type BeforeToolCallData = BaseEventData & {
  /** Tool name being called */
  toolName: string;
  /** Tool parameters (sanitized) */
  params: Record<string, unknown>;
  /** Tool input hash for dedup */
  inputHash?: string;
};

export type AfterToolCallData = BaseEventData & {
  /** Tool name that was called */
  toolName: string;
  /** Tool parameters (sanitized) */
  params: Record<string, unknown>;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Result summary (truncated if large) */
  resultSummary?: string;
  /** Result size in bytes */
  resultSizeBytes: number;
  /** Execution duration in ms */
  durationMs: number;
};

export type ToolResultPersistData = BaseEventData & {
  /** Tool name */
  toolName?: string;
  /** Whether the result was modified (e.g., quota message appended) */
  modified: boolean;
  /** Modification reason if modified */
  modificationReason?: string;
};

// ─── Compaction ──────────────────────────────────────────────────────────────

export type BeforeCompactionData = BaseEventData & {
  /** Number of messages before compaction */
  messageCount: number;
  /** Estimated token count before */
  tokenEstimate?: number;
  /** Reason for compaction */
  reason: "token_limit" | "manual" | "auto";
};

export type AfterCompactionData = BaseEventData & {
  /** Number of messages after compaction */
  messageCount: number;
  /** Messages removed */
  removedCount: number;
  /** Estimated token count after */
  tokenEstimate?: number;
};

export type BeforeResetData = BaseEventData & {
  /** Reason for reset */
  reason: "user_request" | "error_recovery" | "context_overflow" | "unknown";
  /** Number of messages being cleared */
  messageCount: number;
};

// ─── Subagents ───────────────────────────────────────────────────────────────

export type SubagentSpawningData = BaseEventData & {
  /** Subagent ID being created */
  subagentId: string;
  /** Type of subagent */
  subagentType: string;
  /** Task/prompt for the subagent */
  task: string;
  /** Task length before truncation */
  taskLength: number;
  /** Parent agent context */
  parentContext?: string;
};

export type SubagentDeliveryTargetData = BaseEventData & {
  /** Subagent ID */
  subagentId: string;
  /** Delivery target type */
  targetType: string;
  /** Target details */
  targetDetails?: Record<string, unknown>;
};

export type SubagentSpawnedData = BaseEventData & {
  /** Subagent ID that was created */
  subagentId: string;
  /** Subagent type */
  subagentType: string;
  /** Whether spawn was successful */
  success: boolean;
  /** Error if failed */
  error?: string;
};

export type SubagentEndedData = BaseEventData & {
  /** Subagent ID that ended */
  subagentId: string;
  /** How it ended */
  reason: "completed" | "error" | "timeout" | "cancelled" | "unknown";
  /** Result summary if completed */
  resultSummary?: string;
  /** Error message if failed */
  error?: string;
  /** Duration in ms */
  durationMs?: number;
};

// ─── Gateway ─────────────────────────────────────────────────────────────────

export type GatewayStartData = BaseEventData & {
  /** Gateway port */
  port: number;
  /** Gateway URL */
  url: string;
};

export type GatewayStopData = BaseEventData & {
  /** Reason for stopping */
  reason: "shutdown" | "error" | "restart" | "unknown";
  /** Error if stopped due to error */
  error?: string;
};

// =============================================================================
// Union Type for All Hook Event Data
// =============================================================================

export type HookEventData =
  | BeforeAgentStartData
  | AgentEndData
  | SessionStartData
  | SessionEndData
  | MessageReceivedData
  | MessageSendingData
  | MessageSentData
  | BeforeMessageWriteData
  | BeforeModelResolveData
  | BeforePromptBuildData
  | LlmInputData
  | LlmOutputData
  | BeforeToolCallData
  | AfterToolCallData
  | ToolResultPersistData
  | BeforeCompactionData
  | AfterCompactionData
  | BeforeResetData
  | SubagentSpawningData
  | SubagentDeliveryTargetData
  | SubagentSpawnedData
  | SubagentEndedData
  | GatewayStartData
  | GatewayStopData;

// =============================================================================
// Hook Event Structure
// =============================================================================

/** A single hook event for reporting to Core */
export type HookEvent = {
  /** Event sequence number (monotonically increasing per session) */
  seq: number;
  /** Hook type */
  hookType: HookType;
  /** Event data specific to this hook type */
  data: HookEventData;
};

// =============================================================================
// Event Stream Request/Response
// =============================================================================

/** Request body for POST /api/v1/events/stream */
export type EventStreamRequest = {
  /** Agent ID from credentials */
  agentId: string;
  /** Session key */
  sessionKey: string;
  /** Run ID for this conversation */
  runId: string;
  /** Array of events to report */
  events: HookEvent[];
  /** Client metadata */
  meta: {
    pluginVersion: string;
    clientTimestamp: string;
  };
};

/** Response from POST /api/v1/events/stream */
export type EventStreamResponse = {
  success: boolean;
  data?: {
    /** Number of events processed */
    processed: number;
    /** Block decisions for blocking hooks (keyed by seq) */
    blocks?: Array<{
      seq: number;
      reason: string;
      findings?: Array<{
        riskLevel: string;
        riskType: string;
        reason: string;
      }>;
    }>;
  };
  error?: string;
};

// =============================================================================
// Type Guard Helpers
// =============================================================================

/** Map of hook types to their expected data types (for runtime validation) */
export const HOOK_DATA_FIELDS: Record<HookType, string[]> = {
  before_agent_start: ["prompt"],
  agent_end: ["reason"],
  session_start: ["sessionId", "isNew"],
  session_end: ["sessionId"],
  message_received: ["from", "content", "contentLength"],
  message_sending: ["to", "content", "contentLength"],
  message_sent: ["to", "success"],
  before_message_write: ["filePath", "content", "contentLength"],
  before_model_resolve: ["requestedModel"],
  before_prompt_build: ["messageCount"],
  llm_input: ["model", "content", "contentLength", "messageCount"],
  llm_output: ["model", "content", "contentLength", "streamed", "latencyMs"],
  before_tool_call: ["toolName", "params"],
  after_tool_call: ["toolName", "params", "success", "resultSizeBytes", "durationMs"],
  tool_result_persist: ["modified"],
  before_compaction: ["messageCount", "reason"],
  after_compaction: ["messageCount", "removedCount"],
  before_reset: ["reason", "messageCount"],
  subagent_spawning: ["subagentId", "subagentType", "task", "taskLength"],
  subagent_delivery_target: ["subagentId", "targetType"],
  subagent_spawned: ["subagentId", "subagentType", "success"],
  subagent_ended: ["subagentId", "reason"],
  gateway_start: ["port", "url"],
  gateway_stop: ["reason"],
};
