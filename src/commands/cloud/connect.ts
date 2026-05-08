// `thomas cloud connect <agent>` — wire a local agent through thomas-cloud
// instead of a local provider.
//
// Flow:
//   1. preflight: device-login present, gatewayApiKey known (from --api-key
//      or already persisted on cloud.json from a prior call)
//   2. run the standard local-connect (shim install, agent restart hook,
//      proxy daemon) with --no-import — credentials live on the cloud side
//      now, not locally
//   3. override the route to the special "thomas-cloud" sentinel so the
//      proxy hot path forwards to the cloud gateway instead of a real
//      provider
//
// `thomas disconnect <agent>` already handles tear-down generically (shim
// removal + route delete) — no special cloud-aware path needed.

import { ThomasError, runJson } from "../../cli/json.js";
import type { ConnectData } from "../../cli/output.js";
import { readIdentity, writeIdentity } from "../../cloud/identity.js";
import { THOMAS_CLOUD_PROVIDER_ID } from "../../cloud/types.js";
import { setRoute } from "../../config/routes.js";
import { doConnect } from "../connect.js";

export type CloudConnectOptions = {
  agentId: string;
  apiKey?: string;
  noImport?: boolean;
  noProxy?: boolean;
  restartAgent?: boolean;
  json: boolean;
};

export async function cloudConnect(opts: CloudConnectOptions): Promise<number> {
  return runJson({
    command: "cloud.connect",
    json: opts.json,
    fetch: () => doCloudConnect(opts),
    printHuman: (d) => printCloudConnect(d, opts),
  });
}

async function doCloudConnect(opts: CloudConnectOptions): Promise<ConnectData> {
  const identity = await readIdentity();
  if (!identity) {
    throw new ThomasError({
      code: "E_CLOUD_NOT_LOGGED_IN",
      message: "not logged in to thomas-cloud",
      remediation: "Run `thomas cloud login` first, then re-run this command",
    });
  }

  if (opts.apiKey) {
    const trimmed = opts.apiKey.trim();
    if (!trimmed.startsWith("tc_gw_")) {
      throw new ThomasError({
        code: "E_INVALID_ARG",
        message: `--api-key must be a thomas-cloud gateway key (starts with 'tc_gw_'); got '${trimmed.slice(0, 12)}…'`,
        remediation:
          "Create one in the dashboard at /dashboard/api-keys, then pass it as --api-key.",
      });
    }
    await writeIdentity({ ...identity, gatewayApiKey: trimmed });
  } else if (!identity.gatewayApiKey) {
    throw new ThomasError({
      code: "E_CLOUD_NO_GATEWAY_KEY",
      message: "no thomas-cloud gateway API key stored",
      remediation:
        "Pass --api-key <tc_gw_…> with one created at /dashboard/api-keys. The key is then persisted in ~/.thomas/cloud.json for subsequent connects.",
    });
  }

  // Run the normal connect flow but skip credential import — the cloud holds
  // upstream secrets now, and importing them locally would only confuse
  // `thomas runs` / `thomas explain` later.
  const result = await doConnect({
    agentId: opts.agentId,
    noImport: true,
    noProxy: opts.noProxy,
    restartAgent: opts.restartAgent,
    json: opts.json,
  });

  // Override the route the proxy reads on every request. The model field is
  // a placeholder — the cloud picks the actual model from the agent binding.
  await setRoute(opts.agentId, {
    provider: THOMAS_CLOUD_PROVIDER_ID,
    model: "via-binding",
  });

  return result;
}

function printCloudConnect(d: ConnectData, opts: CloudConnectOptions): void {
  process.stdout.write(`✓ ${d.agent} now routes through thomas-cloud.\n`);
  if (d.shimPath) {
    process.stdout.write(`  shim:   ${d.shimPath}\n`);
  }
  process.stdout.write(
    `  route:  ${THOMAS_CLOUD_PROVIDER_ID} (provider+model decided by cloud binding)\n`,
  );
  if (opts.apiKey) {
    process.stdout.write("  api key: stored at ~/.thomas/cloud.json\n");
  }
  if (d.notes.length > 0) {
    for (const n of d.notes) process.stdout.write(`  note:   ${n}\n`);
  }
}
