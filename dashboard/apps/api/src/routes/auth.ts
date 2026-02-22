import { Router } from "express";

export const authRouter = Router();

const CORE_URL = process.env.OG_CORE_URL || "http://localhost:53666";

interface CoreAccount {
  success: boolean;
  agentId: string;
  name: string;
  email: string | null;
  status: string;
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
}

interface CoreAgentSummary {
  agentId: string;
  name: string;
  apiKeyMasked: string;
  status: string;
  quotaTotal: number;
  quotaUsed: number;
  quotaRemaining: number;
}

interface CoreAccounts {
  success: boolean;
  email: string;
  agents: CoreAgentSummary[];
}

async function fetchCoreAccount(apiKey: string): Promise<CoreAccount | null> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return res.json() as Promise<CoreAccount>;
  } catch {
    return null;
  }
}

async function fetchCoreAccounts(apiKey: string): Promise<CoreAccounts | null> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/accounts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return res.json() as Promise<CoreAccounts>;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/login
 *
 * Validates an email + API key pair against the core.
 * The client stores the API key in localStorage and sends it as
 * Authorization: Bearer on subsequent requests.
 */
authRouter.post("/login", async (req, res, next) => {
  try {
    const { apiKey, email } = req.body as { apiKey?: string; email?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, error: "Valid email required" });
      return;
    }

    if (!apiKey || !apiKey.startsWith("sk-og-")) {
      res.status(400).json({ success: false, error: "Valid API key required (sk-og-...)" });
      return;
    }

    const account = await fetchCoreAccount(apiKey);

    if (!account?.success) {
      res.status(401).json({ success: false, error: "Invalid API key" });
      return;
    }
    if (!account.email) {
      res.status(403).json({ success: false, error: "Agent not yet activated. Complete email verification first." });
      return;
    }

    // Verify email matches (case-insensitive)
    if (account.email.toLowerCase() !== email.toLowerCase()) {
      res.status(401).json({ success: false, error: "Email does not match this API key" });
      return;
    }

    // Fetch all agents under this email
    const accounts = await fetchCoreAccounts(apiKey);
    const agents = accounts?.agents ?? [];

    res.json({
      success: true,
      email: account.email,
      agentId: account.agentId,
      name: account.name,
      quotaTotal: account.quotaTotal,
      quotaUsed: account.quotaUsed,
      quotaRemaining: account.quotaRemaining,
      agents,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 *
 * Restores session on page load — validates stored API key.
 * Same as login but via GET with Authorization header.
 */
authRouter.get("/me", async (req, res, next) => {
  try {
    const apiKey = req.headers.authorization?.replace("Bearer ", "");

    if (!apiKey?.startsWith("sk-og-")) {
      res.status(401).json({ success: false, error: "Not authenticated" });
      return;
    }

    const account = await fetchCoreAccount(apiKey);
    if (!account?.success || !account.email) {
      res.status(401).json({ success: false, error: "Invalid or inactive API key" });
      return;
    }

    // Fetch all agents under this email
    const accounts = await fetchCoreAccounts(apiKey);
    const agents = accounts?.agents ?? [];

    res.json({
      success: true,
      email: account.email,
      agentId: account.agentId,
      name: account.name,
      quotaTotal: account.quotaTotal,
      quotaUsed: account.quotaUsed,
      quotaRemaining: account.quotaRemaining,
      agents,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 *
 * No server-side state — client just clears localStorage.
 */
authRouter.post("/logout", (_req, res) => {
  res.json({ success: true });
});
