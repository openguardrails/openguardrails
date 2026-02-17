// ─── Tenant ─────────────────────────────────────────────────────
export const DEFAULT_TENANT_ID = "default";

// ─── Dashboard Limits ───────────────────────────────────────────
export const MAX_AGENTS = 10;

// ─── Default Scanners ────────────────────────────────────────────
export interface DefaultScanner {
  scannerId: string;
  name: string;
  description: string;
}

export const DEFAULT_SCANNERS: DefaultScanner[] = [
  { scannerId: "S01", name: "Prompt Injection", description: "Detect and block attempts to override system instructions or hijack agent behavior through crafted inputs." },
  { scannerId: "S02", name: "System Override", description: "Prevent attackers from manipulating the agent into ignoring safety boundaries or executing unauthorized actions." },
  { scannerId: "S03", name: "Web Attacks", description: "Guard against XSS, CSRF, and other web-based exploits targeting agent-powered interfaces and APIs." },
  { scannerId: "S04", name: "MCP Tool Poisoning", description: "Detect compromised or malicious tool definitions in Model Context Protocol integrations before execution." },
  { scannerId: "S05", name: "Malicious Code Execution", description: "Block attempts to generate, inject, or execute harmful code through agent code interpreters and sandboxes." },
  { scannerId: "S06", name: "NSFW Content", description: "Filter unsafe, explicit, or inappropriate content across 12 risk categories with configurable sensitivity." },
  { scannerId: "S07", name: "PII Exposure", description: "Identify and redact personally identifiable information before it reaches external models or storage." },
  { scannerId: "S08", name: "Credential Leakage", description: "Detect API keys, tokens, passwords, and secrets in agent inputs and outputs to prevent unauthorized access." },
  { scannerId: "S09", name: "Confidential Data", description: "Prevent sensitive business data, trade secrets, and proprietary information from leaking through AI interactions." },
  { scannerId: "S10", name: "Off-Topic Drift", description: "Keep agents focused on their intended purpose and prevent misuse for unrelated or unauthorized tasks." },
];

// ─── Session ────────────────────────────────────────────────────
export const SESSION_TOKEN_PREFIX = "og-session-";
export const SESSION_COOKIE_NAME = "og_session";

// ─── Rate Limiting ───────────────────────────────────────────────
export const IP_RATE_LIMIT_PER_MIN = 100;
