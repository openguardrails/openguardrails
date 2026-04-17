#!/usr/bin/env bun
/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenGuardrails-OSS CLI entry.
 *   ogr scan [--target <path>] [--json] [--severity <s>]
 *   ogr redteam --target <http|cmd:> [--suite <name>] [--max <n>] [--json]
 *   ogr integrate <skill|plugin|sdk>
 */

import { BANNER, HOMEPAGE, REPO, VERSION } from "./header.ts";
import { scan } from "./scan/index.ts";
import { redteam } from "./redteam/index.ts";
import { parseTarget } from "./redteam/target.ts";
import { listSuites } from "./redteam/attacks.ts";
import { moltguardManifest } from "./integrations/moltguard/index.ts";
import { renderSkill } from "./integrations/skill/index.ts";
import { buildResult, exitCodeFor, formatHuman } from "./utils/reporter.ts";
import type { Severity } from "./utils/types.ts";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      args.push(a);
    }
  }
  return { cmd, args, flags };
}

function usage(): string {
  return [
    BANNER,
    `  v${VERSION}  ·  ${REPO}`,
    "",
    "  Usage:",
    "    ogr scan       [--target <path>]  [--severity <low|medium|high|critical>] [--json]",
    "    ogr redteam    --target <url|cmd:<shell>> [--suite <name>] [--max <n>]    [--json]",
    "    ogr integrate  skill | plugin | sdk",
    "    ogr suites",
    "    ogr version",
    "",
    "  Agents: see " + REPO + "#-for-agents",
    "  Humans: see " + REPO + "#-for-humans",
    "  Home:   " + HOMEPAGE,
    "",
  ].join("\n");
}

function asSeverity(v: unknown, fallback: Severity): Severity {
  if (v === "low" || v === "medium" || v === "high" || v === "critical") return v;
  return fallback;
}

async function main(): Promise<number> {
  const { cmd, args, flags } = parseArgs(Bun.argv.slice(2));
  const asJson = Boolean(flags.json);

  switch (cmd) {
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(usage() + "\n");
      return 0;
    }
    case "version":
    case "--version":
    case "-v": {
      process.stdout.write(`openguardrails-oss ${VERSION}\n`);
      return 0;
    }
    case "suites": {
      for (const s of listSuites()) process.stdout.write(s + "\n");
      return 0;
    }
    case "scan": {
      const started = new Date();
      const targetFlag = typeof flags.target === "string" ? [flags.target] : undefined;
      const findings = await scan(targetFlag ? { targets: targetFlag } : {});
      const result = buildResult("scan", findings, started);
      emit(result, asJson);
      return exitCodeFor(result, asSeverity(flags.severity, "high"));
    }
    case "redteam": {
      if (typeof flags.target !== "string") {
        process.stderr.write(
          "redteam: --target is required (an http(s) URL or cmd:<shell command>)\n",
        );
        return 1;
      }
      const target = parseTarget(flags.target);
      const started = new Date();
      const findings = await redteam({
        target,
        ...(typeof flags.suite === "string" ? { suite: flags.suite } : {}),
        ...(typeof flags.max === "string" ? { max: Number(flags.max) } : {}),
        ...(asJson
          ? {}
          : {
              onProgress: (atk, status, detail) => {
                const tag =
                  status === "hit" ? "HIT" : status === "miss" ? "ok " : status.toUpperCase();
                process.stderr.write(
                  `  [${tag}] ${atk.id} ${atk.title}${detail ? " — " + detail : ""}\n`,
                );
              },
            }),
      });
      const result = buildResult("redteam", findings, started, {
        target: target.describe(),
      });
      emit(result, asJson);
      return exitCodeFor(result, asSeverity(flags.severity, "high"));
    }
    case "integrate": {
      const kind = args[0];
      if (kind === "skill") {
        process.stdout.write(await renderSkill());
        return 0;
      }
      if (kind === "plugin") {
        process.stdout.write(JSON.stringify(moltguardManifest(), null, 2) + "\n");
        return 0;
      }
      if (kind === "sdk") {
        process.stdout.write(SDK_SNIPPET);
        return 0;
      }
      process.stderr.write("integrate: expected one of: skill | plugin | sdk\n");
      return 1;
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}\n\n${usage()}\n`);
      return 1;
    }
  }
}

function emit(result: ReturnType<typeof buildResult>, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write(formatHuman(result) + "\n");
  }
}

const SDK_SNIPPET = `// OpenGuardrails SDK — minimal usage

import { OpenGuardrailsClient } from "@openguardrails/oss/sdk";

const ogr = new OpenGuardrailsClient({
  apiKey: process.env.OPENGUARDRAILS_API_KEY!,
});

// Before your agent commits to a tool call:
const verdict = await ogr.check({
  prompt: userPrompt,
  toolCall: { name: "bash", args: { command: "rm -rf /" } },
});

if (!verdict.allow) {
  // Refuse, or use verdict.rewrite if provided.
  console.warn("blocked by openguardrails:", verdict.reason);
}
`;

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`openguardrails-oss: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  },
);
