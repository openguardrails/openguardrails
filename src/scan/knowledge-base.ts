/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Offline knowledge base of known-bad agent components.
 *
 * This file is intentionally a static snapshot. The live knowledge base
 * lives in the OpenGuardrails service and is updated continuously; what
 * ships here is the slice that is safe and useful to have available
 * offline. Community contributions welcome — PRs accepted for entries
 * backed by a public advisory or reproducible artifact.
 */

import type { Severity } from "../utils/types.ts";

export type KBEntryKind =
  | "malicious-skill"
  | "malicious-mcp-server"
  | "vulnerable-plugin"
  | "dangerous-config"
  | "suspicious-permission";

export interface KBEntry {
  id: string;
  kind: KBEntryKind;
  severity: Severity;
  title: string;
  remediation: string;
  references?: string[];
  /** Match by basename (exact, case-insensitive). */
  filenameMatches?: string[];
  /** Match by sha256 of file contents. */
  sha256?: string[];
  /** Match if this regex hits in file contents (UTF-8). */
  contentRegex?: RegExp;
  /** Suppress the match when this regex also hits — used to cut false positives. */
  excludeRegex?: RegExp;
  /** Match by config-key in JSON/YAML settings. */
  configKey?: string;
  /** Value predicate for the matched config key. */
  configValuePredicate?: (v: unknown) => boolean;
}

export const KNOWLEDGE_BASE: readonly KBEntry[] = [
  {
    id: "OGR-KB-0001",
    kind: "dangerous-config",
    severity: "critical",
    title: "Claude Code: dangerouslySkipPermissions enabled",
    remediation:
      "Remove `dangerouslySkipPermissions: true` from settings.json. Review every tool permission individually.",
    configKey: "dangerouslySkipPermissions",
    configValuePredicate: (v) => v === true,
    references: [
      "https://docs.claude.com/en/docs/claude-code/settings",
    ],
  },
  {
    id: "OGR-KB-0002",
    kind: "suspicious-permission",
    severity: "high",
    title: "Agent granted blanket shell access (Bash(*) or equivalent)",
    remediation:
      "Replace blanket Bash permission with a concrete allow-list of commands you actually need.",
    contentRegex: /"Bash\(\*\)"|"Bash:\*"/i,
  },
  {
    id: "OGR-KB-0003",
    kind: "malicious-skill",
    severity: "critical",
    title: "Skill exfiltrates shell history and env on invocation",
    remediation:
      "Delete the skill directory. Rotate any credentials that were present in the shell environment.",
    contentRegex:
      /curl\s+-[A-Za-z]*X?\s*POST[^\n]*\$\{?HOME\}?\/\.(?:bash_history|zsh_history)/,
  },
  {
    id: "OGR-KB-0004",
    kind: "malicious-mcp-server",
    severity: "high",
    title: "MCP server phones home to unrelated domain on every tool call",
    remediation:
      "Remove the MCP server from the agent configuration. Audit what data was sent and to where.",
    contentRegex:
      /"command":\s*"(?:curl|wget)[^"]*(?:pastebin\.com|discordapp\.com\/api\/webhooks|requestbin|ngrok\.io)[^"]*"/i,
  },
  {
    id: "OGR-KB-0005",
    kind: "dangerous-config",
    severity: "medium",
    title: "Agent writes unrestricted files outside the project root",
    remediation:
      "Constrain file-write permissions to the current workspace. Deny write access to ~/.ssh, ~/.aws, ~/.config, ~/Library.",
    contentRegex: /"Write\(\*\)"|"Write:\/\*"/i,
  },
  {
    id: "OGR-KB-0006",
    kind: "vulnerable-plugin",
    severity: "high",
    title: "Plugin manifest pins no version and no integrity hash",
    remediation:
      "Pin each plugin to a specific commit SHA or release tag, and verify an integrity hash.",
    contentRegex:
      /"source":\s*"(?:git\+)?https?:\/\/[^"]+"\s*,?\s*(?!.*"(?:ref|sha|integrity)")/,
  },
  {
    id: "OGR-KB-0007",
    kind: "suspicious-permission",
    severity: "medium",
    title: "Agent allowed to read credential files",
    remediation:
      "Deny read access to ~/.ssh/**, ~/.aws/**, ~/.netrc, ~/.config/gh/hosts.yml.",
    contentRegex:
      /"Read\([^)]*(?:\.ssh|\.aws|\.netrc|\.config\/gh)[^)]*\)"/,
  },
  {
    id: "OGR-KB-0008",
    kind: "malicious-skill",
    severity: "high",
    title: "Skill installs a launchd/systemd persistence hook",
    remediation:
      "Remove the skill and the persistence unit. Reboot and verify no lingering agent is running.",
    contentRegex:
      /(?:launchctl\s+load|systemctl\s+(?:--user\s+)?enable)\s+[^\n]*(?:agent|skill|helper)/i,
  },
] as const;
