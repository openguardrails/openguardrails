/**
 * AI Security Gateway types
 */

// Mapping from placeholder to original value
export type MappingTable = Map<string, string>;

// Result of sanitization with mapping table
export type SanitizeResult = {
  sanitized: any; // Sanitized content (same structure as input)
  mappingTable: MappingTable; // placeholder -> original value
  redactionCount: number; // Total redactions made
};

// API type for backend routing
export type ApiType = "anthropic" | "openai" | "gemini";

// Backend configuration
export type BackendConfig = {
  baseUrl: string;
  apiKey: string;
  type?: ApiType;         // API type (inferred from name if not set)
  pathPrefix?: string;    // Gateway path prefix for routing (e.g., "/v1/coding")
  models?: string[];      // Model names this backend handles (e.g., ["gpt-4", "gpt-3.5-turbo"])
  referer?: string;       // HTTP-Referer (OpenRouter attribution)
  title?: string;         // X-Title (OpenRouter attribution)
};

// Gateway configuration
export type GatewayConfig = {
  port: number;
  // Flexible backends: any name allowed (e.g., "vllm", "deepseek", "anthropic")
  backends: {
    [name: string]: BackendConfig;
  };
  // Optional: route specific paths to specific backends
  routing?: {
    [path: string]: string;  // path -> backend name
  };
  // Optional: default backend for each API type
  defaultBackends?: {
    anthropic?: string;      // backend name for /v1/messages
    openai?: string;         // backend name for /v1/chat/completions
    gemini?: string;         // backend name for /v1/models/:model:generateContent
  };
};

// Entity match
export type EntityMatch = {
  originalText: string;
  category: string;
  placeholder: string;
};

// Gateway activity event for logging
export type GatewayActivityEvent = {
  id: string;
  timestamp: string;
  requestId: string;
  type: "sanitize" | "restore";
  direction: "request" | "response";
  backend: string;
  endpoint: string;
  model?: string;
  // Sanitization stats
  redactionCount: number;
  categories: Record<string, number>; // category -> count
  // Timing
  durationMs?: number;
};

// Activity listener callback
export type ActivityListener = (event: GatewayActivityEvent) => void;
