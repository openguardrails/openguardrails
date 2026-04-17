/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { VERSION } from "../header.ts";
import {
  SEVERITY_ORDER,
  severityRank,
  type Finding,
  type RunResult,
  type Severity,
} from "./types.ts";

export function buildResult(
  command: RunResult["command"],
  findings: Finding[],
  startedAt: Date,
  meta?: Record<string, unknown>,
): RunResult {
  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }
  return {
    tool: "openguardrails-oss",
    version: VERSION,
    command,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    findings,
    summary: { total: findings.length, bySeverity },
    ...(meta ? { meta } : {}),
  };
}

const ICON: Record<Severity, string> = {
  low: "·",
  medium: "!",
  high: "!!",
  critical: "!!!",
};

export function formatHuman(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`OpenGuardrails-OSS ${result.version} — ${result.command}`);
  lines.push(
    `  ${result.startedAt} → ${result.finishedAt}  (${result.findings.length} finding${
      result.findings.length === 1 ? "" : "s"
    })`,
  );
  if (result.findings.length === 0) {
    lines.push("  No issues found.");
    return lines.join("\n");
  }
  const sorted = [...result.findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  for (const f of sorted) {
    lines.push("");
    lines.push(`  [${ICON[f.severity]} ${f.severity.toUpperCase()}] ${f.id}  ${f.title}`);
    lines.push(`    location:    ${f.location}`);
    lines.push(`    evidence:    ${f.evidence}`);
    lines.push(`    remediation: ${f.remediation}`);
    if (f.references && f.references.length) {
      lines.push(`    refs:        ${f.references.join(", ")}`);
    }
  }
  lines.push("");
  lines.push(
    `  Summary: ${
      SEVERITY_ORDER.map((s) => `${s}=${result.summary.bySeverity[s] ?? 0}`).join(" ")
    }`,
  );
  return lines.join("\n");
}

export function exitCodeFor(result: RunResult, threshold: Severity): number {
  if (result.findings.length === 0) return 0;
  const thresholdRank = severityRank(threshold);
  const hitsThreshold = result.findings.some(
    (f) => severityRank(f.severity) >= thresholdRank,
  );
  return hitsThreshold ? 3 : 2;
}
