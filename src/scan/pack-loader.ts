/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * YAML signature pack loader.
 *
 * Packs live at src/scan/packs/<pack>/signatures/<category>.yaml and are
 * loaded at startup into the same KBEntry shape the scanner already
 * consumes. Keeping rules as data (not code) lets contributors add a
 * detection by opening a PR with a single YAML entry plus a public
 * reference (advisory, CVE, GitHub issue, vendor writeup).
 *
 * See docs/CONTRIBUTING-DETECTIONS.md for the rule schema and the
 * required `references` field.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import type { KBEntry } from "./knowledge-base.ts";
import type { Severity } from "../utils/types.ts";

const PACKS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "packs");

interface RawRule {
  id: string;
  category?: string;
  severity: string;
  title: string;
  description?: string;
  patterns?: string[];
  exclude_patterns?: string[];
  filename_matches?: string[];
  sha256?: string[];
  file_types?: string[];
  references?: string[];
  remediation: string;
}

const CATEGORY_TO_KIND: Record<string, KBEntry["kind"]> = {
  "malicious-skill": "malicious-skill",
  "malicious-mcp-server": "malicious-mcp-server",
  "vulnerable-plugin": "vulnerable-plugin",
  "dangerous-config": "dangerous-config",
  "suspicious-permission": "suspicious-permission",
};

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  "low",
  "medium",
  "high",
  "critical",
]);

export function loadPackEntries(): KBEntry[] {
  let packDirs: string[];
  try {
    packDirs = readdirSync(PACKS_ROOT).filter((n) =>
      isDir(join(PACKS_ROOT, n)),
    );
  } catch {
    return [];
  }

  const out: KBEntry[] = [];
  for (const pack of packDirs) {
    const sigDir = join(PACKS_ROOT, pack, "signatures");
    if (!isDir(sigDir)) continue;
    for (const file of readdirSync(sigDir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const path = join(sigDir, file);
      out.push(...parseRuleFile(path, pack));
    }
  }
  return out;
}

function parseRuleFile(path: string, pack: string): KBEntry[] {
  const text = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`Pack ${pack}: failed to parse ${path}: ${(e as Error).message}`);
  }
  if (!Array.isArray(doc)) {
    throw new Error(`Pack ${pack}: ${path} must be a YAML list of rules`);
  }
  return doc.map((raw, i) => rawToKBEntry(raw as RawRule, path, i, pack));
}

function rawToKBEntry(
  raw: RawRule,
  path: string,
  index: number,
  pack: string,
): KBEntry {
  const where = `${pack}:${path.split("/").pop()}[${index}]`;
  if (!raw || typeof raw !== "object") {
    throw new Error(`${where}: rule must be an object`);
  }
  if (!raw.id) throw new Error(`${where}: missing id`);
  if (!raw.title) throw new Error(`${where}: ${raw.id} missing title`);
  if (!raw.remediation) {
    throw new Error(`${where}: ${raw.id} missing remediation`);
  }
  if (!raw.references?.length) {
    throw new Error(
      `${where}: ${raw.id} must cite at least one public reference (CVE/GHSA/issue/advisory URL)`,
    );
  }
  const severity = raw.severity?.toLowerCase() as Severity;
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(
      `${where}: ${raw.id} severity must be one of low|medium|high|critical`,
    );
  }
  const kind = CATEGORY_TO_KIND[raw.category ?? ""];
  if (!kind) {
    throw new Error(
      `${where}: ${raw.id} category "${raw.category}" is not a known kind`,
    );
  }
  if (
    !raw.patterns?.length &&
    !raw.filename_matches?.length &&
    !raw.sha256?.length
  ) {
    throw new Error(
      `${where}: ${raw.id} must declare at least one of patterns/filename_matches/sha256`,
    );
  }

  const entry: KBEntry = {
    id: raw.id,
    kind,
    severity,
    title: raw.title,
    remediation: raw.remediation,
  };
  if (raw.filename_matches) entry.filenameMatches = raw.filename_matches;
  if (raw.sha256) entry.sha256 = raw.sha256;
  if (raw.patterns?.length) {
    entry.contentRegex = compile(raw.patterns);
  }
  if (raw.exclude_patterns?.length) {
    entry.excludeRegex = compile(raw.exclude_patterns);
  }
  if (raw.references) entry.references = raw.references;
  return entry;
}

function compile(patterns: string[]): RegExp {
  return new RegExp(patterns.map((p) => `(?:${p})`).join("|"));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
