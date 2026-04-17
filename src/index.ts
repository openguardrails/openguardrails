/*
 * Copyright (c) 2026 OpenGuardrails.com
 * Author: thomas-security <thomas@openguardrails.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export * as scan from "./scan/index.ts";
export * as redteam from "./redteam/index.ts";
export { OpenGuardrailsClient } from "./integrations/sdk.ts";
export {
  createMoltguardPlugin,
  moltguardManifest,
} from "./integrations/moltguard/index.ts";
export { VERSION, PROJECT, HOMEPAGE, REPO } from "./header.ts";
export type { Finding, RunResult, Severity } from "./utils/types.ts";
