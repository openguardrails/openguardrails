/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITY_ORDER: readonly Severity[] = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  location: string;
  evidence: string;
  remediation: string;
  references?: string[];
}

export interface RunResult {
  tool: "openguardrails-oss";
  version: string;
  command: "scan" | "redteam" | "integrate";
  startedAt: string;
  finishedAt: string;
  findings: Finding[];
  summary: {
    total: number;
    bySeverity: Partial<Record<Severity, number>>;
  };
  meta?: Record<string, unknown>;
}
