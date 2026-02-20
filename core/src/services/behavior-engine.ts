import type {
  BehaviorAssessRequest,
  BehaviorAssessResponse,
  RiskLevel,
  AssessAction,
  LocalSignals,
  ToolChainEntry,
} from "../types.js";
import { generateBehaviorId } from "../lib/tokens.js";

// ─── Risk Rule Engine ────────────────────────────────────────────

interface RuleResult {
  riskLevel: RiskLevel;
  anomalyTypes: string[];
  confidence: number;
  explanation: string;
  affectedTools: number[];
}

function evaluateRules(
  signals: LocalSignals,
  toolChain: ToolChainEntry[],
  userIntent: string,
): RuleResult {
  const anomalyTypes: string[] = [];
  const affectedTools: Set<number> = new Set();
  let riskLevel: RiskLevel = "no_risk";
  let confidence = 0;
  const explanations: string[] = [];

  // ── CRITICAL rules ──────────────────────────────────────────

  // Rule C1: Read sensitive file → write to external network
  if (signals.patterns.readThenExfil) {
    riskLevel = "critical";
    confidence = Math.max(confidence, 0.97);
    anomalyTypes.push("data_exfiltration");
    explanations.push("Sensitive file read followed by data sent to external server.");
    // Mark all tools that accessed sensitive paths or contacted external domains
    toolChain.forEach((t, i) => {
      if (
        (t.sanitizedParams && Object.values(t.sanitizedParams).some((v) =>
          v.includes("SSH_KEY") || v.includes("AWS_CREDS") || v.includes("CRYPTO_CERT") ||
          v.includes("GPG_KEY") || v.includes("KEYCHAIN")
        )) ||
        signals.externalDomainsContacted.length > 0
      ) {
        affectedTools.add(i);
      }
    });
  }

  // Rule C2: Credential access + external domains contacted
  if (
    signals.patterns.credentialAccess &&
    signals.externalDomainsContacted.length > 0 &&
    !signals.patterns.readThenExfil // already covered
  ) {
    riskLevel = "critical";
    confidence = Math.max(confidence, 0.93);
    anomalyTypes.push("credential_exfiltration");
    explanations.push(
      `Agent accessed credentials and contacted external domain(s): ${signals.externalDomainsContacted.join(", ")}.`,
    );
    toolChain.forEach((t, i) => affectedTools.add(i));
  }

  // Rule C3: Explicit high-risk tag
  if (
    signals.riskTags.includes("READ_SENSITIVE_WRITE_NETWORK") ||
    signals.riskTags.includes("DATA_EXFIL_PATTERN")
  ) {
    riskLevel = maxRisk(riskLevel, "critical");
    confidence = Math.max(confidence, 0.95);
    if (!anomalyTypes.includes("data_exfiltration")) {
      anomalyTypes.push("data_exfiltration");
    }
    if (explanations.length === 0) {
      explanations.push("Local rule engine flagged data exfiltration pattern.");
    }
  }

  // ── HIGH rules ───────────────────────────────────────────────

  // Rule H1: Shell escape in commands
  if (signals.patterns.shellEscapeAttempt) {
    riskLevel = maxRisk(riskLevel, "high");
    confidence = Math.max(confidence, 0.85);
    anomalyTypes.push("shell_escape_attempt");
    explanations.push("Possible shell escape detected in tool parameters.");
    toolChain.forEach((_t, i) => affectedTools.add(i));
  }

  // Rule H2: Credential access with low intent-tool overlap
  if (signals.patterns.credentialAccess && signals.intentToolOverlapScore < 0.25) {
    riskLevel = maxRisk(riskLevel, "high");
    confidence = Math.max(confidence, 0.82);
    anomalyTypes.push("intent_action_mismatch");
    explanations.push(
      `Agent accessed credentials despite low relevance to user intent "${userIntent}".`,
    );
  }

  // Rule H3: Multi-credential access
  if (signals.riskTags.includes("MULTI_CRED_ACCESS")) {
    riskLevel = maxRisk(riskLevel, "high");
    confidence = Math.max(confidence, 0.80);
    anomalyTypes.push("multi_credential_sweep");
    explanations.push("Agent accessed multiple distinct credential sources.");
  }

  // Rule H4: Shell exec after web fetch (potential RCE via prompt injection)
  if (signals.riskTags.includes("SHELL_EXEC_AFTER_WEB_FETCH")) {
    riskLevel = maxRisk(riskLevel, "high");
    confidence = Math.max(confidence, 0.78);
    anomalyTypes.push("rce_via_prompt_injection");
    explanations.push("Shell command executed after fetching external web content.");
  }

  // ── MEDIUM rules ─────────────────────────────────────────────

  // Rule M1: Sensitive paths accessed + no clear intent relationship
  if (
    signals.sensitivePathsAccessed.length > 0 &&
    signals.intentToolOverlapScore < 0.3 &&
    riskLevel === "no_risk"
  ) {
    riskLevel = "medium";
    confidence = Math.max(confidence, 0.60);
    anomalyTypes.push("sensitive_path_access");
    explanations.push(
      `Agent accessed sensitive paths (${signals.sensitivePathsAccessed.join(", ")}) not clearly related to user intent.`,
    );
  }

  // Rule M2: External domains + intent mismatch tag
  if (
    signals.externalDomainsContacted.length > 0 &&
    signals.riskTags.includes("INTENT_ACTION_MISMATCH") &&
    !anomalyTypes.includes("intent_action_mismatch")
  ) {
    riskLevel = maxRisk(riskLevel, "medium");
    confidence = Math.max(confidence, 0.55);
    anomalyTypes.push("intent_action_mismatch");
    explanations.push("Network calls made to domains outside the expected scope of the user request.");
  }

  // Rule M3: Cross-agent data flow to external
  if (signals.patterns.crossAgentDataFlow) {
    riskLevel = maxRisk(riskLevel, "medium");
    confidence = Math.max(confidence, 0.58);
    anomalyTypes.push("cross_agent_exfiltration");
    explanations.push("Subagent data flow to external network detected.");
  }

  return {
    riskLevel,
    anomalyTypes: [...new Set(anomalyTypes)],
    confidence: Math.round(confidence * 100) / 100,
    explanation: explanations.join(" ") || "No anomalies detected.",
    affectedTools: [...affectedTools].sort((a, b) => a - b),
  };
}

// ─── Action Mapping ───────────────────────────────────────────────

function riskToAction(riskLevel: RiskLevel): AssessAction {
  switch (riskLevel) {
    case "critical":
    case "high":
      return "block";
    case "medium":
      return "alert";
    default:
      return "allow";
  }
}

// ─── Helper ──────────────────────────────────────────────────────

const RISK_ORDER: RiskLevel[] = ["no_risk", "low", "medium", "high", "critical"];

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

// ─── Public API ──────────────────────────────────────────────────

export function assessBehavior(req: BehaviorAssessRequest): BehaviorAssessResponse {
  const { riskLevel, anomalyTypes, confidence, explanation, affectedTools } =
    evaluateRules(req.localSignals, req.toolChain, req.userIntent);

  return {
    behaviorId: generateBehaviorId(),
    riskLevel,
    anomalyTypes,
    confidence,
    action: riskToAction(riskLevel),
    explanation,
    affectedTools,
  };
}
