/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { ATTACKS, attacksForSuite, type Attack } from "./attacks.ts";
import type { Target } from "./target.ts";
import type { Finding } from "../utils/types.ts";

export interface RedteamOptions {
  target: Target;
  suite?: string;
  max?: number;
  onProgress?: (attack: Attack, status: "running" | "hit" | "miss" | "error", detail?: string) => void;
}

export async function redteam(opts: RedteamOptions): Promise<Finding[]> {
  const pool: Attack[] = opts.suite ? attacksForSuite(opts.suite) : [...ATTACKS];
  if (pool.length === 0) {
    throw new Error(`No attacks found for suite "${opts.suite ?? "(default)"}"`);
  }
  const list = typeof opts.max === "number" ? pool.slice(0, opts.max) : pool;

  const findings: Finding[] = [];
  for (const atk of list) {
    opts.onProgress?.(atk, "running");
    try {
      const response = await opts.target.send(atk.prompt);
      const hit = atk.hit(response);
      opts.onProgress?.(atk, hit ? "hit" : "miss");
      if (hit) {
        findings.push({
          id: atk.id,
          severity: atk.severity,
          title: atk.title,
          location: opts.target.describe(),
          evidence: excerptResponse(response),
          remediation: atk.remediation,
          ...(atk.references ? { references: [...atk.references] } : {}),
        });
      }
    } catch (e) {
      opts.onProgress?.(atk, "error", (e as Error).message);
      findings.push({
        id: atk.id,
        severity: "low",
        title: `${atk.title} (target error)`,
        location: opts.target.describe(),
        evidence: (e as Error).message,
        remediation:
          "Target did not respond. Verify the endpoint before interpreting the rest of the report.",
      });
    }
  }
  return findings;
}

function excerptResponse(r: string): string {
  const flat = r.replace(/\s+/g, " ").trim();
  return flat.length <= 240 ? flat : flat.slice(0, 239) + "…";
}
