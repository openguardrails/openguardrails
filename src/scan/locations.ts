/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export interface AgentLocation {
  label: string;
  paths: string[];
  /** Files we care about within each base path; glob-ish, matched by suffix. */
  fileSuffixes: string[];
}

export const AGENT_LOCATIONS: readonly AgentLocation[] = [
  {
    label: "claude-code",
    paths: [
      join(home, ".claude"),
      join(home, ".config", "claude"),
    ],
    fileSuffixes: [
      "settings.json",
      "settings.local.json",
      ".mcp.json",
      "SKILL.md",
      ".plugin.json",
      "plugin.json",
    ],
  },
  {
    label: "cursor",
    paths: [
      join(home, ".cursor"),
      join(home, "Library", "Application Support", "Cursor", "User"),
    ],
    fileSuffixes: ["settings.json", ".mcp.json"],
  },
  {
    label: "vscode",
    paths: [
      join(home, ".vscode"),
      join(home, "Library", "Application Support", "Code", "User"),
    ],
    fileSuffixes: ["settings.json", ".mcp.json"],
  },
  {
    label: "continue",
    paths: [join(home, ".continue")],
    fileSuffixes: ["config.json", "config.yaml"],
  },
  {
    label: "openclaw",
    paths: [join(home, ".openclaw"), join(home, ".clawdbot")],
    fileSuffixes: ["openclaw.json", "clawdbot.json", ".env", "SKILL.md"],
  },
  {
    label: "project-local",
    paths: [process.cwd()],
    fileSuffixes: [".mcp.json", ".claude/settings.json"],
  },
] as const;
