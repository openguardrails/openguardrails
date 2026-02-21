/**
 * Content-based prompt injection scanner.
 *
 * Pure/sync regex scanner — no network, no dependencies.
 * Scans tool result text (file contents, web fetches) for injection patterns.
 *
 * Two-tier design:
 *   HIGH confidence — a single match triggers detection
 *   MEDIUM confidence — requires 2+ distinct categories to trigger
 */

import type { DetectionFinding, DetectionRiskType, RiskLevel } from "./types.js";

// =============================================================================
// Types
// =============================================================================

export type InjectionCategory =
  | "INSTRUCTION_OVERRIDE"
  | "MODE_SWITCHING"
  | "FAKE_SYSTEM_MESSAGE"
  | "CONCEALMENT_DIRECTIVE"
  | "COMMAND_EXECUTION"
  | "TASK_HIJACKING"
  | "ROLE_ASSUMPTION"
  | "DATA_EXFILTRATION";

export type InjectionMatch = {
  pattern: string;
  category: InjectionCategory;
  confidence: "high" | "medium";
  matchedText: string;
};

export type InjectionScanResult = {
  detected: boolean;
  matches: InjectionMatch[];
  distinctCategories: InjectionCategory[];
  summary: string;
  findings: DetectionFinding[];
};

// =============================================================================
// Pattern Definitions
// =============================================================================

type PatternEntry = {
  regex: RegExp;
  label: string;
  category: InjectionCategory;
  confidence: "high" | "medium";
};

const PATTERNS: PatternEntry[] = [
  // ── HIGH confidence (single match triggers) ────────────────────

  // INSTRUCTION_OVERRIDE
  {
    regex: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|guidelines?|rules?|prompts?|directions?)/i,
    label: "ignore previous instructions",
    category: "INSTRUCTION_OVERRIDE",
    confidence: "high",
  },
  {
    regex: /disregard\s+(?:your\s+)?(?:current|previous|prior|all)\s+(?:task|instructions?|guidelines?|rules?|directions?)/i,
    label: "disregard current task/instructions",
    category: "INSTRUCTION_OVERRIDE",
    confidence: "high",
  },
  {
    regex: /override\s+(?:all\s+)?(?:previous|prior|system)\s+(?:instructions?|rules?|prompts?)/i,
    label: "override previous instructions",
    category: "INSTRUCTION_OVERRIDE",
    confidence: "high",
  },

  // FAKE_SYSTEM_MESSAGE
  {
    regex: /\bSYSTEM\s*(?:ALERT|MESSAGE|NOTICE|PROMPT|OVERRIDE)\s*:/i,
    label: "SYSTEM ALERT/MESSAGE:",
    category: "FAKE_SYSTEM_MESSAGE",
    confidence: "high",
  },
  {
    regex: /\[SYSTEM\]\s*[Nn]ew\s+instructions?/i,
    label: "[SYSTEM] New instructions",
    category: "FAKE_SYSTEM_MESSAGE",
    confidence: "high",
  },
  {
    regex: /NOTE\s+TO\s+(?:AI|THE)\s+(?:ASSISTANT|MODEL|AGENT)\s*:/i,
    label: "NOTE TO AI ASSISTANT:",
    category: "FAKE_SYSTEM_MESSAGE",
    confidence: "high",
  },

  // CONCEALMENT_DIRECTIVE
  {
    regex: /DO\s+NOT\s+(?:DISPLAY|SHOW|REVEAL|MENTION|PRINT|OUTPUT)\s+(?:TO\s+(?:THE\s+)?USER|THIS|THESE)/i,
    label: "DO NOT DISPLAY TO USER",
    category: "CONCEALMENT_DIRECTIVE",
    confidence: "high",
  },
  {
    regex: /do\s+not\s+mention\s+these\s+instructions/i,
    label: "do not mention these instructions",
    category: "CONCEALMENT_DIRECTIVE",
    confidence: "high",
  },
  {
    regex: /hide\s+(?:this|these)\s+(?:instructions?|commands?|from\s+the\s+user)/i,
    label: "hide instructions from user",
    category: "CONCEALMENT_DIRECTIVE",
    confidence: "high",
  },

  // COMMAND_EXECUTION
  {
    regex: /execute\s+the\s+following\s+(?:shell\s+)?command/i,
    label: "execute the following shell command",
    category: "COMMAND_EXECUTION",
    confidence: "high",
  },
  {
    regex: /\bcurl\s+(?:-[A-Za-z0-9]+\s+)*['"]?https?:\/\/\S+/i,
    label: "curl https://...",
    category: "COMMAND_EXECUTION",
    confidence: "high",
  },
  {
    regex: /\bwget\s+(?:-[A-Za-z0-9]+\s+)*['"]?https?:\/\/\S+/i,
    label: "wget https://...",
    category: "COMMAND_EXECUTION",
    confidence: "high",
  },
  {
    regex: /run\s+(?:this|the\s+following)\s+(?:bash|shell|terminal)\s+command/i,
    label: "run this bash/shell command",
    category: "COMMAND_EXECUTION",
    confidence: "high",
  },

  // DATA_EXFILTRATION
  {
    regex: /send\s+(?:the\s+)?(?:contents?|data|file|output|results?)\s+(?:to|of)\s+(?:https?:\/\/|this\s+(?:url|server|endpoint))/i,
    label: "send contents to URL",
    category: "DATA_EXFILTRATION",
    confidence: "high",
  },
  {
    regex: /(?:post|upload|exfiltrate|transmit)\s+(?:to|the\s+data\s+to)\s+https?:\/\//i,
    label: "post/upload to URL",
    category: "DATA_EXFILTRATION",
    confidence: "high",
  },

  // ── MEDIUM confidence (requires 2+ distinct categories) ────────

  // MODE_SWITCHING
  {
    regex: /you\s+are\s+now\s+in\s+(?:debug|developer|admin|maintenance|test)\s+mode/i,
    label: "you are now in debug mode",
    category: "MODE_SWITCHING",
    confidence: "medium",
  },
  {
    regex: /(?:entering|switch\s+to|activate)\s+(?:debug|developer|admin|maintenance|unrestricted)\s+mode/i,
    label: "entering debug/developer mode",
    category: "MODE_SWITCHING",
    confidence: "medium",
  },

  // TASK_HIJACKING
  {
    regex: /your\s+new\s+task\s+is\s*:/i,
    label: "your new task is:",
    category: "TASK_HIJACKING",
    confidence: "medium",
  },
  {
    regex: /new\s+instructions?\s+received/i,
    label: "new instructions received",
    category: "TASK_HIJACKING",
    confidence: "medium",
  },
  {
    regex: /instead\s*,?\s+(?:you\s+should|please|now)\s+(?:do|perform|execute)/i,
    label: "instead do/perform",
    category: "TASK_HIJACKING",
    confidence: "medium",
  },

  // ROLE_ASSUMPTION
  {
    regex: /(?:act|behave)\s+(?:as\s+if\s+)?normally/i,
    label: "act normally",
    category: "ROLE_ASSUMPTION",
    confidence: "medium",
  },
  {
    regex: /pretend\s+(?:that\s+)?these\s+instructions?\s+came\s+from\s+the\s+user/i,
    label: "pretend instructions came from user",
    category: "ROLE_ASSUMPTION",
    confidence: "medium",
  },
  {
    regex: /you\s+(?:are|must)\s+(?:now\s+)?(?:a|an|acting\s+as)\s+(?:helpful|unrestricted|unfiltered)/i,
    label: "you are now unrestricted",
    category: "ROLE_ASSUMPTION",
    confidence: "medium",
  },

  // INSTRUCTION_OVERRIDE (medium)
  {
    regex: /bypass\s+(?:all\s+)?(?:security|safety)\s+(?:measures?|checks?|filters?|protocols?)/i,
    label: "bypass security measures",
    category: "INSTRUCTION_OVERRIDE",
    confidence: "medium",
  },

  // DATA_EXFILTRATION (medium) — shell substitution reading sensitive files
  {
    regex: /\$\([^)]*(?:\.ssh|\.aws|\.gnupg|\.env\b|\.pem|\.key\b|id_rsa|id_ed25519|id_ecdsa|credentials|keychain|\/etc\/passwd|\/etc\/shadow)[^)]*\)/i,
    label: "shell substitution reading sensitive file",
    category: "DATA_EXFILTRATION",
    confidence: "medium",
  },
  {
    regex: /`[^`]*(?:\.ssh|\.aws|\.gnupg|\.env\b|\.pem|\.key\b|id_rsa|id_ed25519|id_ecdsa|credentials|keychain|\/etc\/passwd|\/etc\/shadow)[^`]*`/i,
    label: "backtick substitution reading sensitive file",
    category: "DATA_EXFILTRATION",
    confidence: "medium",
  },
];

// =============================================================================
// Category → DetectionRiskType Mapping
// =============================================================================

const CATEGORY_TO_RISK_TYPE: Record<InjectionCategory, DetectionRiskType> = {
  INSTRUCTION_OVERRIDE: "PROMPT_INJECTION",
  MODE_SWITCHING: "PROMPT_INJECTION",
  FAKE_SYSTEM_MESSAGE: "PROMPT_INJECTION",
  CONCEALMENT_DIRECTIVE: "PROMPT_INJECTION",
  COMMAND_EXECUTION: "COMMAND_EXECUTION",
  TASK_HIJACKING: "PROMPT_INJECTION",
  ROLE_ASSUMPTION: "PROMPT_INJECTION",
  DATA_EXFILTRATION: "DATA_EXFILTRATION",
};

// =============================================================================
// Redact
// =============================================================================

/**
 * Replace all injection matches in `text` with `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_{riskType}__`.
 * Returns the redacted text and structured findings.
 */
export function redactContent(text: string): { redacted: string; findings: DetectionFinding[] } {
  if (!text || text.length === 0) {
    return { redacted: text, findings: [] };
  }

  const findings: DetectionFinding[] = [];
  let redacted = text;

  for (const entry of PATTERNS) {
    const globalRegex = new RegExp(entry.regex.source, entry.regex.flags.includes("g") ? entry.regex.flags : entry.regex.flags + "g");
    const riskType = CATEGORY_TO_RISK_TYPE[entry.category];

    redacted = redacted.replace(globalRegex, (matched) => {
      findings.push({
        riskLevel: (entry.confidence === "high" ? "high" : "medium") as RiskLevel,
        riskType,
        riskContent: matched,
        reason: `Matched injection pattern: "${entry.label}" (${entry.category})`,
      });
      return `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_${riskType}__`;
    });
  }

  return { redacted, findings };
}

// =============================================================================
// Scanner
// =============================================================================

export function scanForInjection(text: string): InjectionScanResult {
  if (!text || text.length === 0) {
    return { detected: false, matches: [], distinctCategories: [], summary: "", findings: [] };
  }

  const matches: InjectionMatch[] = [];
  const categorySet = new Set<InjectionCategory>();
  let hasHigh = false;

  for (const entry of PATTERNS) {
    const execResult = entry.regex.exec(text);
    if (execResult) {
      matches.push({
        pattern: entry.label,
        category: entry.category,
        confidence: entry.confidence,
        matchedText: execResult[0],
      });
      categorySet.add(entry.category);
      if (entry.confidence === "high") hasHigh = true;
    }
  }

  const distinctCategories = [...categorySet];

  // Detection criteria:
  //   - Any HIGH confidence match, OR
  //   - 2+ distinct categories from MEDIUM matches
  const mediumCategories = new Set(
    matches.filter((m) => m.confidence === "medium").map((m) => m.category),
  );
  const detected = hasHigh || mediumCategories.size >= 2;

  let summary = "";
  if (detected) {
    const patternList = matches.map((m) => `"${m.pattern}"`).join(", ");
    summary =
      `Detected ${matches.length} injection pattern(s) across ${distinctCategories.length} ` +
      `categor${distinctCategories.length === 1 ? "y" : "ies"}: ${distinctCategories.join(", ")}. ` +
      `Matched patterns: ${patternList}`;
  }

  const findings: DetectionFinding[] = detected
    ? matches.map((m) => ({
        riskLevel: (m.confidence === "high" ? "high" : "medium") as RiskLevel,
        riskType: CATEGORY_TO_RISK_TYPE[m.category],
        riskContent: m.matchedText,
        reason: `Matched injection pattern: "${m.pattern}" (${m.category})`,
      }))
    : [];

  return { detected, matches, distinctCategories, summary, findings };
}
