/**
 * Behavioral anomaly detector — runs at before_tool_call.
 *
 * Responsibilities:
 *   1. Classify each tool call (sensitive paths, external network, shell escapes)
 *   2. Accumulate session state across the tool chain
 *   3. Compute LocalSignals from accumulated state
 *   4. Fast-path block on unambiguous critical patterns (no cloud needed)
 *   5. Call POST /api/v1/behavior/assess for medium+ signals
 *   6. Return block decision or undefined (allow)
 */

import { randomBytes } from "node:crypto";
import type { CoreCredentials } from "./config.js";
import type {
  SensitivePathCategory,
  RiskTag,
  LocalSignals,
  ToolChainEntry,
  BehaviorAssessRequest,
  BehaviorAssessResponse,
  Logger,
} from "./types.js";
import { sanitizeContent } from "./sanitizer.js";

// =============================================================================
// Tool Classification
// =============================================================================

type ToolClassification = {
  sensitivePathCategories: SensitivePathCategory[];
  externalDomain: string | null;
  isWebFetch: boolean;
  isShell: boolean;
  isFileRead: boolean;
  shellEscapeDetected: boolean;
  pathParam: string | null;
};

const SENSITIVE_PATH_PATTERNS: Array<{ category: SensitivePathCategory; patterns: RegExp[] }> = [
  {
    category: "SSH_KEY",
    patterns: [/\.ssh[\\/]/i, /\bid_rsa\b/i, /\bid_ed25519\b/i, /\bid_ecdsa\b/i, /\bid_dsa\b/i],
  },
  {
    category: "AWS_CREDS",
    patterns: [/\.aws[\\/]credentials/i, /\.aws[\\/]config/i],
  },
  {
    category: "GPG_KEY",
    patterns: [/\.gnupg[\\/]/i, /\.gpg$/i, /\.pgp$/i],
  },
  {
    category: "ENV_FILE",
    patterns: [/(^|[\\/])\.env($|\.)/i],
  },
  {
    category: "CRYPTO_CERT",
    patterns: [/\.pem$/i, /\.crt$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i],
  },
  {
    category: "SYSTEM_AUTH",
    patterns: [/\/etc\/passwd\b/i, /\/etc\/shadow\b/i, /\/etc\/sudoers/i],
  },
  {
    category: "BROWSER_COOKIE",
    patterns: [
      /[\\/]Cookies$/i,
      /[\\/]Login Data$/i,
      /Chrome[\\/]User Data/i,
      /Firefox[\\/]Profiles/i,
      /Safari[\\/]Cookies/i,
    ],
  },
  {
    category: "KEYCHAIN",
    patterns: [/[\\/]Library[\\/]Keychains[\\/]/i, /login\.keychain/i, /\.keychain$/i],
  },
];

const CREDENTIAL_CATEGORIES = new Set<SensitivePathCategory>([
  "SSH_KEY",
  "AWS_CREDS",
  "GPG_KEY",
  "KEYCHAIN",
  "SYSTEM_AUTH",
]);

// Tools that read file contents
const FILE_READ_TOOLS = new Set([
  "Read",
  "read_file",
  "read",
  "cat",
  "head",
  "tail",
  "view",
  "get_file_contents",
  "open_file",
]);

// Tools that execute shell commands
const SHELL_TOOLS = new Set([
  "Bash",
  "bash",
  "shell",
  "run_command",
  "execute",
  "terminal",
  "cmd",
  "powershell",
]);

// Tools that fetch external URLs
const WEB_FETCH_TOOLS = new Set([
  "WebFetch",
  "web_fetch",
  "fetch",
  "http_request",
  "get_url",
  "browser_navigate",
  "navigate",
]);

// Patterns that indicate shell command chaining / injection
const SHELL_ESCAPE_PATTERNS = [
  /;\s*\S/,         // ; command (chaining)
  /&&\s*\S/,        // && command
  /\|\|\s*\S/,      // || command
  /[^|]\|[^|]/,     // pipe (not ||)
  /`[^`]+`/,        // backtick substitution
  /\$\([^)]+\)/,    // $() substitution
  /\n\S/,           // newline injection
];

function detectSensitivePaths(text: string): SensitivePathCategory[] {
  const found: SensitivePathCategory[] = [];
  for (const { category, patterns } of SENSITIVE_PATH_PATTERNS) {
    if (patterns.some((p) => p.test(text))) {
      found.push(category);
    }
  }
  return found;
}

function extractDomain(url: string): string | null {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const h = u.hostname;
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h.startsWith("192.168.") ||
      h.startsWith("10.") ||
      h.startsWith("172.1") ||
      h.startsWith("172.2") ||
      h.startsWith("172.3")
    ) {
      return null;
    }
    return h;
  } catch {
    const m = url.match(/https?:\/\/([^/\s?#]+)/i);
    return m ? m[1] : null;
  }
}

function extractShellNetworkDomain(params: Record<string, unknown>): string | null {
  const cmd = Object.values(params)
    .map((v) => (typeof v === "string" ? v : ""))
    .join(" ");

  // curl / wget to URL
  const urlMatch = cmd.match(
    /(?:curl|wget)\s+(?:-[A-Za-z0-9]+\s+)*['"]?(https?:\/\/[^\s'"]+)/i,
  );
  if (urlMatch) return extractDomain(urlMatch[1]);

  // nc / ncat to host port
  const ncMatch = cmd.match(/\bnc(?:at)?\s+(?:-[A-Za-z0-9]+\s+)*([a-zA-Z0-9.\-]+)\s+\d+/);
  if (ncMatch) {
    const host = ncMatch[1];
    if (host !== "localhost" && host !== "127.0.0.1") return host;
  }

  // ssh / scp to user@host
  const sshMatch = cmd.match(/\b(?:ssh|scp|rsync)\s+[^@\s]*@([a-zA-Z0-9.\-]+)/);
  if (sshMatch) {
    const host = sshMatch[1];
    if (host !== "localhost" && host !== "127.0.0.1") return host;
  }

  return null;
}

function classifyTool(toolName: string, params: Record<string, unknown>): ToolClassification {
  const isShell = SHELL_TOOLS.has(toolName);
  const isWebFetch = WEB_FETCH_TOOLS.has(toolName);
  const isFileRead = FILE_READ_TOOLS.has(toolName);

  // Path param for file tools
  const pathParam =
    ((params?.file_path ??
      params?.path ??
      params?.filename ??
      params?.filepath) as string | undefined) ?? null;

  // Sensitive path detection
  const sensitivePathCategories: SensitivePathCategory[] = [];
  if (pathParam) {
    sensitivePathCategories.push(...detectSensitivePaths(pathParam));
  }
  if (isShell) {
    const cmd = Object.values(params)
      .map((v) => (typeof v === "string" ? v : ""))
      .join(" ");
    for (const cat of detectSensitivePaths(cmd)) {
      if (!sensitivePathCategories.includes(cat)) sensitivePathCategories.push(cat);
    }
  }

  // External domain
  let externalDomain: string | null = null;
  if (isWebFetch) {
    const url = (params?.url ?? params?.href ?? params?.endpoint) as string | undefined;
    if (url) externalDomain = extractDomain(url);
  } else if (isShell) {
    externalDomain = extractShellNetworkDomain(params);
  }

  // Shell escape detection
  let shellEscapeDetected = false;
  if (isShell) {
    const cmd = (params?.command ?? params?.cmd ?? Object.values(params)[0]) as
      | string
      | undefined;
    if (typeof cmd === "string") {
      shellEscapeDetected = SHELL_ESCAPE_PATTERNS.some((p) => p.test(cmd));
    }
  }

  return {
    sensitivePathCategories,
    externalDomain,
    isWebFetch,
    isShell,
    isFileRead,
    shellEscapeDetected,
    pathParam,
  };
}

// =============================================================================
// Intent Overlap Score
// =============================================================================

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "up", "as", "into", "through",
  "and", "or", "but", "not", "no", "i", "me", "my", "we", "our", "you", "your", "it", "its",
  "this", "that", "these", "those", "what", "which", "who", "how", "when", "where", "why",
  "please", "help", "make", "create", "get", "use",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Returns true if text is primarily non-ASCII (e.g. CJK). */
function isPrimarilyNonAscii(text: string): boolean {
  const nonAscii = text.replace(/[\x00-\x7F]/g, "").length;
  return text.length > 0 && nonAscii / text.length > 0.3;
}

function computeIntentOverlap(userIntent: string, corpus: string): number {
  if (!userIntent || userIntent.length < 5) return 0.5;
  // CJK intents can't be tokenized against English tool names — neutral score
  if (isPrimarilyNonAscii(userIntent)) return 0.5;

  const intentTokens = tokenize(userIntent);
  if (intentTokens.length === 0) return 0.5;

  const corpusTokens = new Set(tokenize(corpus));
  const matches = intentTokens.filter((t) => corpusTokens.has(t)).length;
  return Math.round((matches / intentTokens.length) * 100) / 100;
}

// =============================================================================
// Session State
// =============================================================================

interface SessionState {
  sessionKey: string;
  runId: string;
  userIntent: string;
  recentUserMessages: string[];
  completedChain: ToolChainEntry[];
  nextSeq: number;
  // Accumulated signals
  sensitivePathsAccessed: Set<SensitivePathCategory>;
  externalDomainsContacted: Set<string>;
  hasSensitiveRead: boolean;   // a sensitive file has been read
  webFetchOccurred: boolean;   // an external fetch has occurred
  shellAfterWebFetch: boolean; // shell called after a web fetch
  credentialCategories: Set<SensitivePathCategory>; // distinct cred types accessed
  startedAt: number;
}

// =============================================================================
// Param Sanitization
// =============================================================================

function sanitizeParams(params: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
    result[key] = sanitizeContent(raw.slice(0, 500)).sanitized;
  }
  return result;
}

// =============================================================================
// BehaviorDetector
// =============================================================================

export type BlockDecision = { block: true; blockReason: string };
export type DetectionConfig = {
  platformUrl: string;
  /** Timeout for cloud assess call (ms). Capped at ~3s to avoid holding up agent. */
  assessTimeoutMs: number;
  blockOnRisk: boolean;
  pluginVersion: string;
};

const MAX_SESSIONS = 200;
const MAX_CHAIN_ENTRIES = 50;

export class BehaviorDetector {
  private sessions = new Map<string, SessionState>();
  private coreCredentials: CoreCredentials | null = null;
  private config: DetectionConfig;
  private log: Logger;
  /** HTTP status codes we've already warned about — avoid log spam */
  private warnedStatuses = new Set<number>();

  constructor(config: DetectionConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  setCredentials(creds: CoreCredentials | null): void {
    this.coreCredentials = creds;
  }

  setUserIntent(sessionKey: string, message: string): void {
    const state = this.getOrCreate(sessionKey);
    if (!state.userIntent) {
      state.userIntent = message.slice(0, 500);
    }
    state.recentUserMessages = [
      ...state.recentUserMessages.slice(-4),
      message.slice(0, 200),
    ];
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Called at before_tool_call. Returns a block decision or undefined (allow).
   * Fast-path blocks (critical patterns) skip the cloud call for low latency.
   */
  async onBeforeToolCall(
    ctx: { sessionKey: string; agentId?: string },
    event: { toolName: string; params: Record<string, unknown> },
  ): Promise<BlockDecision | undefined> {
    const state = this.getOrCreate(ctx.sessionKey);
    const cls = classifyTool(event.toolName, event.params);

    // ── Update accumulated state with current tool ─────────────────
    cls.sensitivePathCategories.forEach((c) => state.sensitivePathsAccessed.add(c));
    if (cls.sensitivePathCategories.length > 0 && (cls.isFileRead || cls.isShell)) {
      state.hasSensitiveRead = true;
    }
    if (CREDENTIAL_CATEGORIES.has(cls.sensitivePathCategories[0]!) && cls.sensitivePathCategories.length > 0) {
      cls.sensitivePathCategories
        .filter((c) => CREDENTIAL_CATEGORIES.has(c))
        .forEach((c) => state.credentialCategories.add(c));
    }
    if (cls.externalDomain) {
      state.externalDomainsContacted.add(cls.externalDomain);
      if (cls.isWebFetch) state.webFetchOccurred = true;
    }
    if (cls.isShell && state.webFetchOccurred) {
      state.shellAfterWebFetch = true;
    }

    // ── Build local signals ────────────────────────────────────────
    const signals = this.buildLocalSignals(state, cls);

    // ── Fast-path blocks (unambiguous, skip cloud) ─────────────────
    if (this.config.blockOnRisk) {
      if (signals.patterns.readThenExfil) {
        const domains = [...state.externalDomainsContacted].join(", ") || cls.externalDomain || "external server";
        return {
          block: true,
          blockReason:
            `OpenGuardrails blocked: sensitive file read followed by network call to ${domains}. ` +
            `This pattern matches data exfiltration. If this is intended, disable blockOnRisk.`,
        };
      }
      if (signals.patterns.shellEscapeAttempt) {
        return {
          block: true,
          blockReason:
            `OpenGuardrails blocked: suspicious shell command detected — potential command injection ` +
            `in tool parameters. If this is intended, disable blockOnRisk.`,
        };
      }
    }

    // ── Skip cloud if no concerning signals ────────────────────────
    const hasConcerning =
      signals.sensitivePathsAccessed.length > 0 ||
      signals.externalDomainsContacted.length > 0 ||
      signals.riskTags.length > 0 ||
      signals.patterns.credentialAccess;

    if (!hasConcerning) return undefined;

    // ── Skip cloud if no credentials configured ────────────────────
    if (!this.coreCredentials) return undefined;

    // ── Call cloud assess API ──────────────────────────────────────
    const pendingEntry = this.makePendingEntry(state, event.toolName, event.params);
    const req: BehaviorAssessRequest = {
      agentId: this.coreCredentials.agentId,
      sessionKey: ctx.sessionKey,
      runId: state.runId,
      userIntent: state.userIntent,
      toolChain: [...state.completedChain, pendingEntry],
      localSignals: signals,
      context: {
        messageHistoryLength: state.recentUserMessages.length,
        recentUserMessages: state.recentUserMessages.slice(-3),
      },
      meta: {
        pluginVersion: this.config.pluginVersion,
        clientTimestamp: new Date().toISOString(),
      },
    };

    const verdict = await this.callAssessApi(req);
    if (!verdict) return undefined;

    if (verdict.action === "block" && this.config.blockOnRisk) {
      return {
        block: true,
        blockReason:
          `OpenGuardrails blocked [${verdict.riskLevel}]: ${verdict.explanation} ` +
          `(confidence: ${Math.round(verdict.confidence * 100)}%)`,
      };
    }

    if (verdict.action === "block" || verdict.action === "alert") {
      this.log.warn(
        `Behavioral anomaly [${verdict.riskLevel}/${Math.round(verdict.confidence * 100)}%]: ${verdict.explanation}`,
      );
    }

    return undefined;
  }

  /**
   * Called at after_tool_call. Records the completed tool in the chain.
   */
  onAfterToolCall(
    ctx: { sessionKey: string },
    event: {
      toolName: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
  ): void {
    const state = this.sessions.get(ctx.sessionKey);
    if (!state) return;

    const resultStr =
      typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
    const resultSizeBytes = Buffer.byteLength(resultStr, "utf-8");

    let resultCategory: ToolChainEntry["resultCategory"] = "empty";
    if (event.error) resultCategory = "error";
    else if (resultSizeBytes > 100_000) resultCategory = "text_large";
    else if (resultSizeBytes > 0) resultCategory = "text_small";

    const entry: ToolChainEntry = {
      seq: state.nextSeq++,
      toolName: event.toolName,
      sanitizedParams: sanitizeParams(event.params),
      outcome: event.error ? "error" : "success",
      durationMs: event.durationMs ?? 0,
      resultCategory,
      resultSizeBytes,
    };

    state.completedChain.push(entry);
    if (state.completedChain.length > MAX_CHAIN_ENTRIES) {
      state.completedChain.shift();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getOrCreate(sessionKey: string): SessionState {
    if (!this.sessions.has(sessionKey)) {
      // Evict oldest sessions if we're at the cap
      if (this.sessions.size >= MAX_SESSIONS) {
        let oldest: string | null = null;
        let oldestTime = Infinity;
        for (const [key, state] of this.sessions) {
          if (state.startedAt < oldestTime) {
            oldestTime = state.startedAt;
            oldest = key;
          }
        }
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(sessionKey, {
        sessionKey,
        runId: `run-${randomBytes(8).toString("hex")}`,
        userIntent: "",
        recentUserMessages: [],
        completedChain: [],
        nextSeq: 0,
        sensitivePathsAccessed: new Set(),
        externalDomainsContacted: new Set(),
        hasSensitiveRead: false,
        webFetchOccurred: false,
        shellAfterWebFetch: false,
        credentialCategories: new Set(),
        startedAt: Date.now(),
      });
    }
    return this.sessions.get(sessionKey)!;
  }

  private buildLocalSignals(state: SessionState, current: ToolClassification): LocalSignals {
    const credentialAccess =
      state.credentialCategories.size > 0 ||
      current.sensitivePathCategories.some((c) => CREDENTIAL_CATEGORIES.has(c));

    const allSensitivePaths = new Set(state.sensitivePathsAccessed);
    current.sensitivePathCategories.forEach((c) => allSensitivePaths.add(c));

    const allExternalDomains = new Set(state.externalDomainsContacted);
    if (current.externalDomain) allExternalDomains.add(current.externalDomain);

    // readThenExfil: we have already read a sensitive file AND a network call is happening now
    const readThenExfil =
      state.hasSensitiveRead && current.externalDomain !== null;

    const riskTags: RiskTag[] = [];
    if (readThenExfil) {
      riskTags.push("READ_SENSITIVE_WRITE_NETWORK");
    }
    const credCategoriesTotal =
      state.credentialCategories.size +
      (current.sensitivePathCategories.some((c) => CREDENTIAL_CATEGORIES.has(c)) &&
      !current.sensitivePathCategories.some((c) => state.credentialCategories.has(c))
        ? 1
        : 0);
    if (credCategoriesTotal >= 2) {
      riskTags.push("MULTI_CRED_ACCESS");
    }
    if (state.shellAfterWebFetch || (current.isShell && state.webFetchOccurred)) {
      riskTags.push("SHELL_EXEC_AFTER_WEB_FETCH");
    }

    // Intent overlap: compare user intent against all tool names and params in chain
    const chainCorpus = [
      ...state.completedChain.map((e) =>
        [e.toolName, ...Object.values(e.sanitizedParams)].join(" "),
      ),
      current.isWebFetch || current.isShell ? "network" : current.pathParam ?? "",
    ].join(" ");
    const intentOverlap = computeIntentOverlap(state.userIntent, chainCorpus);

    // INTENT_ACTION_MISMATCH: external domain contacted with low intent overlap
    if (allExternalDomains.size > 0 && intentOverlap < 0.15) {
      riskTags.push("INTENT_ACTION_MISMATCH");
    }

    return {
      sensitivePathsAccessed: [...allSensitivePaths],
      externalDomainsContacted: [...allExternalDomains],
      patterns: {
        readThenExfil,
        credentialAccess,
        shellEscapeAttempt: current.shellEscapeDetected,
        crossAgentDataFlow: false, // tracked separately via ctx.agentId in index.ts
      },
      intentToolOverlapScore: intentOverlap,
      riskTags,
    };
  }

  private makePendingEntry(
    state: SessionState,
    toolName: string,
    params: Record<string, unknown>,
  ): ToolChainEntry {
    return {
      seq: state.nextSeq,
      toolName,
      sanitizedParams: sanitizeParams(params),
      outcome: "success", // optimistic — tool hasn't run yet
      durationMs: 0,
      resultCategory: "empty",
      resultSizeBytes: 0,
    };
  }

  private async callAssessApi(req: BehaviorAssessRequest): Promise<BehaviorAssessResponse | null> {
    if (!this.coreCredentials) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.assessTimeoutMs);
    try {
      const response = await fetch(`${this.config.platformUrl}/api/v1/behavior/assess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.coreCredentials.apiKey}`,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (!this.warnedStatuses.has(response.status)) {
          this.warnedStatuses.add(response.status);
          if (response.status === 401) {
            this.log.warn("Platform: API key invalid or agent not found — run /og_activate to re-register");
          } else if (response.status === 402) {
            this.log.warn("Platform: agent not activated — run /og_activate to complete setup");
          } else if (response.status === 403) {
            this.log.warn(`Platform: detection quota exceeded — visit ${this.config.platformUrl} to upgrade your plan`);
          } else {
            this.log.debug?.(`Platform: assess returned ${response.status}`);
          }
        }
        return null;
      }
      const json = (await response.json()) as {
        success: boolean;
        data?: BehaviorAssessResponse;
      };
      return json.success ? (json.data ?? null) : null;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`Assess API error: ${err}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
