/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generates a portable SKILL.md for Claude Code and other
 * skill-consuming agents. The emitted file is the same one shipped under
 * skills/openguardrails/SKILL.md — this exists so that
 * `ogr integrate skill` can print it on demand.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = resolve(here, "../../../skills/openguardrails/SKILL.md");

export async function renderSkill(): Promise<string> {
  return await readFile(skillPath, "utf8");
}
