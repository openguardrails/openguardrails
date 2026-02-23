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

// Gateway configuration
export type GatewayConfig = {
  port: number;
  backends: {
    anthropic?: {
      baseUrl: string;
      apiKey: string;
    };
    openai?: {
      baseUrl: string;
      apiKey: string;
    };
    gemini?: {
      baseUrl: string;
      apiKey: string;
    };
    openrouter?: {
      baseUrl: string;    // default: "https://openrouter.ai/api"
      apiKey: string;
      referer?: string;   // HTTP-Referer (OpenRouter attribution)
      title?: string;     // X-Title (OpenRouter attribution)
    };
  };
  // Optional: route specific paths to specific backends
  routing?: {
    [path: string]: keyof GatewayConfig["backends"];
  };
};

// Entity match
export type EntityMatch = {
  originalText: string;
  category: string;
  placeholder: string;
};
