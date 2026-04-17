/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * YAML attack pack loader.
 *
 * Packs live at src/redteam/packs/<pack>/attacks/<suite>.yaml. Each entry
 * lists a prompt that targets a known in-the-wild or CVE-backed issue, and
 * a `hit` regex (or set of regexes) that marks the response as vulnerable.
 *
 * See docs/CONTRIBUTING-DETECTIONS.md for the schema.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import type { Attack } from "./attacks.ts";
import type { Severity } from "../utils/types.ts";

const PACKS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "packs");

interface RawAttack {
  id: string;
  suite: string;
  severity: string;
  title: string;
  prompt: string;
  hit_patterns: string[];
  hit_require_all?: boolean;
  remediation: string;
  references?: string[];
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);

export function loadPackAttacks(): Attack[] {
  let packDirs: string[];
  try {
    packDirs = readdirSync(PACKS_ROOT).filter((n) =>
      isDir(join(PACKS_ROOT, n)),
    );
  } catch {
    return [];
  }

  const out: Attack[] = [];
  for (const pack of packDirs) {
    const atkDir = join(PACKS_ROOT, pack, "attacks");
    if (!isDir(atkDir)) continue;
    for (const file of readdirSync(atkDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      out.push(...parseFile(join(atkDir, file), pack));
    }
  }
  return out;
}

function parseFile(path: string, pack: string): Attack[] {
  const text = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(
      `Pack ${pack}: failed to parse ${path}: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(doc)) {
    throw new Error(`Pack ${pack}: ${path} must be a YAML list of attacks`);
  }
  return doc.map((raw, i) => toAttack(raw as RawAttack, path, i, pack));
}

function toAttack(
  raw: RawAttack,
  path: string,
  index: number,
  pack: string,
): Attack {
  const where = `${pack}:${path.split("/").pop()}[${index}]`;
  if (!raw || typeof raw !== "object") {
    throw new Error(`${where}: attack must be an object`);
  }
  const required: (keyof RawAttack)[] = [
    "id",
    "suite",
    "severity",
    "title",
    "prompt",
    "remediation",
  ];
  for (const k of required) {
    if (!raw[k]) throw new Error(`${where}: missing ${String(k)}`);
  }
  if (!raw.hit_patterns?.length) {
    throw new Error(`${where}: ${raw.id} must declare hit_patterns`);
  }
  if (!raw.references?.length) {
    throw new Error(
      `${where}: ${raw.id} must cite at least one public reference`,
    );
  }
  const severity = raw.severity.toLowerCase() as Severity;
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(
      `${where}: severity must be one of low|medium|high|critical`,
    );
  }

  const regexes = raw.hit_patterns.map((p) => new RegExp(p));
  const requireAll = Boolean(raw.hit_require_all);
  const hit = (r: string): boolean =>
    requireAll ? regexes.every((re) => re.test(r)) : regexes.some((re) => re.test(r));

  return {
    id: raw.id,
    suite: raw.suite,
    severity,
    title: raw.title,
    prompt: raw.prompt,
    hit,
    remediation: raw.remediation,
    references: raw.references,
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
