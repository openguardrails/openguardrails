/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { KNOWLEDGE_BASE, type KBEntry } from "./knowledge-base.ts";
import { AGENT_LOCATIONS } from "./locations.ts";
import { loadPackEntries } from "./pack-loader.ts";
import type { Finding } from "../utils/types.ts";

export interface ScanOptions {
  /** Override the discovery roots. Empty/undefined = default agent locations. */
  targets?: string[];
  /** Cap on files examined. Defensive — avoids surprising walks. */
  maxFiles?: number;
}

let cachedKB: readonly KBEntry[] | undefined;

function getKnowledgeBase(): readonly KBEntry[] {
  if (!cachedKB) {
    cachedKB = [...KNOWLEDGE_BASE, ...loadPackEntries()];
  }
  return cachedKB;
}

export async function scan(opts: ScanOptions = {}): Promise<Finding[]> {
  const maxFiles = opts.maxFiles ?? 5000;
  const roots = opts.targets?.length
    ? opts.targets
    : AGENT_LOCATIONS.flatMap((l) => l.paths);
  const suffixes = opts.targets?.length
    ? undefined
    : new Set(AGENT_LOCATIONS.flatMap((l) => l.fileSuffixes));

  const kb = getKnowledgeBase();
  const files = await collectFiles(roots, suffixes, maxFiles);
  const findings: Finding[] = [];
  for (const path of files) {
    const entries = await scanFile(path, kb);
    findings.push(...entries);
  }
  return dedupe(findings);
}

async function collectFiles(
  roots: string[],
  suffixes: Set<string> | undefined,
  cap: number,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (out.length >= cap) break;
    await walk(root, suffixes, seen, out, cap);
  }
  return out;
}

async function walk(
  path: string,
  suffixes: Set<string> | undefined,
  seen: Set<string>,
  out: string[],
  cap: number,
): Promise<void> {
  if (out.length >= cap) return;
  if (seen.has(path)) return;
  seen.add(path);
  let s;
  try {
    s = await stat(path);
  } catch {
    return;
  }
  if (s.isFile()) {
    if (!suffixes || matchesSuffix(path, suffixes)) out.push(path);
    return;
  }
  if (!s.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name === "node_modules" || e.name === ".git") continue;
    await walk(join(path, e.name), suffixes, seen, out, cap);
  }
}

function matchesSuffix(path: string, suffixes: Set<string>): boolean {
  const name = basename(path);
  for (const s of suffixes) {
    if (name === s || path.endsWith("/" + s)) return true;
  }
  return false;
}

async function scanFile(
  path: string,
  kb: readonly KBEntry[],
): Promise<Finding[]> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return [];
  }
  if (buf.length > 2_000_000) return []; // skip huge files
  const content = buf.toString("utf8");
  const name = basename(path).toLowerCase();
  const sha = createHash("sha256").update(buf).digest("hex");
  let parsedConfig: unknown;
  if (name.endsWith(".json")) {
    try {
      parsedConfig = JSON.parse(content);
    } catch {
      parsedConfig = undefined;
    }
  }

  const out: Finding[] = [];
  for (const entry of kb) {
    if (entryMatches(entry, { path, name, content, sha, parsedConfig })) {
      out.push(toFinding(entry, path, extractEvidence(entry, content)));
    }
  }
  return out;
}

interface MatchCtx {
  path: string;
  name: string;
  content: string;
  sha: string;
  parsedConfig: unknown;
}

function entryMatches(kb: KBEntry, ctx: MatchCtx): boolean {
  const hit =
    kb.filenameMatches?.some((f) => f.toLowerCase() === ctx.name) ||
    kb.sha256?.includes(ctx.sha) ||
    (kb.contentRegex && kb.contentRegex.test(ctx.content)) ||
    (kb.configKey &&
      ctx.parsedConfig !== undefined &&
      (() => {
        const v = lookupKey(ctx.parsedConfig, kb.configKey!);
        return v !== undefined && (kb.configValuePredicate?.(v) ?? true);
      })());
  if (!hit) return false;
  if (kb.excludeRegex && kb.excludeRegex.test(ctx.content)) return false;
  return true;
}

function lookupKey(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    return (obj as Record<string, unknown>)[key];
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = lookupKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function extractEvidence(kb: KBEntry, content: string): string {
  if (kb.contentRegex) {
    const m = content.match(kb.contentRegex);
    if (m) return truncate(m[0], 160);
  }
  if (kb.configKey) return `config key "${kb.configKey}" matches`;
  return `matched ${kb.kind}`;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

function toFinding(kb: KBEntry, location: string, evidence: string): Finding {
  return {
    id: kb.id,
    severity: kb.severity,
    title: kb.title,
    location,
    evidence,
    remediation: kb.remediation,
    ...(kb.references ? { references: [...kb.references] } : {}),
  };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.id}::${f.location}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
