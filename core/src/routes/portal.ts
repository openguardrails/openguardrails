import { Router } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";

const agents = agentQueries(db);
const DASHBOARD_URL = process.env.DASHBOARD_URL || process.env.PLATFORM_URL || "https://platform.openguardrails.com";

export const portalRouter = Router();

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 16) return apiKey.slice(0, 6) + "...";
  return apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
}

/**
 * GET /login — sign-in page (email + API key)
 */
portalRouter.get("/login", (_req, res) => {
  res.send(loginPage({}));
});

/**
 * POST /login — validate email + API key, show account portal
 */
portalRouter.post("/login", async (req, res, next) => {
  try {
    const { email, apiKey } = req.body as { email?: string; apiKey?: string };

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.send(loginPage({ error: "Please enter a valid email address." }));
      return;
    }
    if (!apiKey || !apiKey.startsWith("sk-og-")) {
      res.send(loginPage({ error: "Please enter a valid API key (sk-og-...).", email }));
      return;
    }

    const agent = await agents.findByApiKey(apiKey);
    if (!agent) {
      res.send(loginPage({ error: "Invalid API key.", email }));
      return;
    }
    if (!agent.email) {
      res.send(loginPage({ error: "Agent not yet activated. Complete email verification first.", email }));
      return;
    }
    if (agent.email.toLowerCase() !== email.toLowerCase()) {
      res.send(loginPage({ error: "Email does not match this API key.", email }));
      return;
    }

    // Fetch all agents under this email
    const allAgents = await agents.findAllByEmail(agent.email);

    res.send(accountPage({ email: agent.email, apiKey, agents: allAgents }));
  } catch (err) {
    next(err);
  }
});

// ─── Login page HTML ──────────────────────────────────────────────

function loginPage(opts: { error?: string; email?: string }): string {
  const { error, email } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenGuardrails — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f8fafc; color: #1e293b; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 12px; padding: 40px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05);
            max-width: 440px; width: 100%; }
    h2 { font-size: 1.4rem; font-weight: 700; margin-bottom: 6px; text-align: center; }
    .sub { color: #64748b; font-size: 0.9rem; margin-bottom: 24px; text-align: center; }
    label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px;
            font-weight: 500; font-size: 0.9rem; }
    input { padding: 10px 14px; border: 1.5px solid #e2e8f0; border-radius: 8px;
            font-size: 1rem; outline: none; transition: border-color .15s; }
    input:focus { border-color: #2563eb; }
    small { color: #94a3b8; font-weight: 400; }
    button { width: 100%; padding: 12px; background: #2563eb; color: white; border: none;
             border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;
             transition: background .15s; margin-top: 4px; }
    button:hover { background: #1d4ed8; }
    .error { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626;
             padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem; }
    .back { display: block; text-align: center; margin-top: 16px; color: #64748b;
            font-size: 0.85rem; text-decoration: none; }
    .back:hover { color: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h2>OpenGuardrails</h2>
    <p class="sub">Sign in with your email and API key</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <form method="POST" action="/login">
      <label>
        Email
        <input type="email" name="email" placeholder="you@example.com" value="${esc(email ?? "")}" required autofocus>
      </label>
      <label>
        API Key
        <input type="text" name="apiKey" placeholder="sk-og-..." autocomplete="off" spellcheck="false" required>
      </label>
      <button type="submit">Sign In</button>
    </form>
    <a class="back" href="/">&larr; Back</a>
  </div>
</body>
</html>`;
}

// ─── Account page HTML ────────────────────────────────────────────

function accountPage(opts: {
  email: string;
  apiKey: string;
  agents: Array<{
    id: string;
    name: string;
    apiKey: string;
    status: string;
    quotaTotal: number;
    quotaUsed: number;
  }>;
}): string {
  const { email, apiKey, agents: agentList } = opts;
  const dashboardAutoLogin = `${DASHBOARD_URL}?email=${encodeURIComponent(email)}&apiKey=${encodeURIComponent(apiKey)}`;

  const rows = agentList.map((a) => {
    const remaining = Math.max(0, a.quotaTotal - a.quotaUsed);
    const pct = a.quotaTotal > 0 ? Math.round((a.quotaUsed / a.quotaTotal) * 100) : 0;
    return `
      <tr>
        <td><strong>${esc(a.name)}</strong></td>
        <td><code>${esc(maskApiKey(a.apiKey))}</code></td>
        <td><span class="badge badge-${a.status === "active" ? "active" : "pending"}">${esc(a.status)}</span></td>
        <td>
          <div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div>
          <span class="quota-text">${a.quotaUsed.toLocaleString()} / ${a.quotaTotal.toLocaleString()} (${remaining.toLocaleString()} left)</span>
        </td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenGuardrails — Account</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f8fafc; color: #1e293b; min-height: 100vh;
           display: flex; align-items: flex-start; justify-content: center; padding: 40px 24px; }
    .card { background: white; border-radius: 12px; padding: 32px 36px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05);
            max-width: 640px; width: 100%; }
    h2 { font-size: 1.3rem; font-weight: 700; margin-bottom: 4px; }
    .email { color: #64748b; font-size: 0.9rem; margin-bottom: 24px; }
    h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 12px; color: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #e2e8f0;
         color: #64748b; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    td { padding: 10px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px;
             font-size: 0.75rem; font-weight: 600; }
    .badge-active { background: #dcfce7; color: #15803d; }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .quota-bar { width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; margin-bottom: 4px; }
    .quota-fill { height: 100%; background: #2563eb; border-radius: 3px; transition: width .3s; }
    .quota-text { font-size: 0.75rem; color: #64748b; }
    .actions { display: flex; gap: 10px; margin-top: 24px; }
    .btn { display: inline-block; padding: 10px 20px; border-radius: 8px;
           font-size: 0.9rem; font-weight: 600; text-decoration: none;
           transition: background .15s; }
    .btn-primary { background: #2563eb; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-outline { background: white; color: #334155; border: 1.5px solid #e2e8f0; }
    .btn-outline:hover { border-color: #2563eb; color: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Your Account</h2>
    <p class="email">${esc(email)}</p>
    <h3>Agents</h3>
    <table>
      <thead><tr><th>Name</th><th>API Key</th><th>Status</th><th>Quota</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="actions">
      <a class="btn btn-outline" href="${esc(dashboardAutoLogin)}">Open Dashboard</a>
      <a class="btn btn-outline" href="/login">Sign Out</a>
    </div>
  </div>
</body>
</html>`;
}
