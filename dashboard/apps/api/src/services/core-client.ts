import type { CoreDetectRequest, CoreDetectResponse, CoreScannerDef } from "@og/shared";
import { db, settingsQueries } from "@og/db";

const settings = settingsQueries(db);

/** Get core URL from settings or env */
async function getCoreUrl(): Promise<string> {
  return (await settings.get("og_core_url")) || process.env.OG_CORE_URL || "http://localhost:53666";
}

/** Get core key from settings or env */
async function getCoreKey(): Promise<string> {
  return (await settings.get("og_core_key")) || process.env.OG_CORE_KEY || "";
}

/**
 * Call core detection API.
 * Uses core key from settings for authentication.
 */
export async function callCoreDetect(
  messages: unknown[],
  scanners: CoreScannerDef[],
  options?: { format?: string; role?: string }
): Promise<CoreDetectResponse> {
  const coreUrl = await getCoreUrl();
  const coreKey = await getCoreKey();

  const body: CoreDetectRequest = {
    messages,
    scanners,
    format: options?.format as CoreDetectRequest["format"],
    role: options?.role as CoreDetectRequest["role"],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Use Bearer token if key looks like sk-og-*, otherwise X-Internal-Key
  if (coreKey.startsWith("sk-og-")) {
    headers["Authorization"] = `Bearer ${coreKey}`;
  } else if (coreKey) {
    headers["X-Internal-Key"] = coreKey;
  }

  const res = await fetch(`${coreUrl}/v1/detect`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`core returned ${res.status}: ${text}`);
  }

  const json = await res.json() as { success: boolean; data: CoreDetectResponse; error?: string };
  if (!json.success) {
    throw new Error(`core error: ${json.error}`);
  }

  return json.data;
}

/** Check core health */
export async function checkCoreHealth(): Promise<boolean> {
  try {
    const coreUrl = await getCoreUrl();
    const res = await fetch(`${coreUrl}/health`);
    const json = await res.json() as { status: string };
    return json.status === "ok";
  } catch {
    return false;
  }
}
