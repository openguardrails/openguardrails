import { Router } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";
import type { RegisteredAgent } from "../types.js";

const agents = agentQueries(db);
const DASHBOARD_URL = process.env.DASHBOARD_URL || process.env.PLATFORM_URL || "https://platform.openguardrails.com";

export const verifyEmailRouter = Router();

/**
 * GET /api/v1/agents/verify-email/:emailToken
 *
 * User clicks this link from their verification email.
 * Activates the agent and shows a rich success page with all agents under this email.
 */
verifyEmailRouter.get("/:emailToken", async (req, res, next) => {
  try {
    const agent = await agents.activateByEmailToken(req.params.emailToken!);

    if (!agent) {
      res.status(400).send(verifyPage({
        success: false,
        message: "Verification link is invalid or has already been used.",
      }));
      return;
    }

    // Fetch all agents under this email
    const allAgents = agent.email
      ? await agents.findAllByEmail(agent.email)
      : [agent];

    res.send(verifyPage({
      success: true,
      message: `Your email <strong>${esc(agent.email ?? "")}</strong> has been verified.`,
      email: agent.email ?? undefined,
      agents: allAgents,
      dashboardUrl: DASHBOARD_URL,
    }));
  } catch (err) {
    next(err);
  }
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 16) return apiKey.slice(0, 6) + "...";
  return apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
}

function verifyPage(opts: {
  success: boolean;
  message: string;
  email?: string;
  agents?: RegisteredAgent[];
  dashboardUrl?: string;
}): string {
  const { success, message, email, agents: agentList, dashboardUrl } = opts;

  let agentsHtml = "";
  if (success && agentList && agentList.length > 0) {
    const rows = agentList.map((a) => `
      <tr>
        <td>${esc(a.name)}</td>
        <td><code>${esc(maskApiKey(a.apiKey))}</code></td>
        <td><span class="badge badge-${a.status === "active" ? "active" : "pending"}">${esc(a.status)}</span></td>
      </tr>`).join("");

    agentsHtml = `
      <div class="agents">
        <h3>Your agents</h3>
        <table>
          <thead><tr><th>Name</th><th>API Key</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  let loginHtml = "";
  if (success && email) {
    loginHtml = `
      <div class="login-info">
        <h3>How to sign in</h3>
        <p>Use your <strong>email</strong> and <strong>API key</strong> to sign in to the Core API or the Dashboard.</p>
        <p class="hint">If you register more agents with the same email, they will all appear under one account.</p>
      </div>`;
  }

  const dashboardBtn = success && dashboardUrl
    ? `<a class="btn" href="${esc(dashboardUrl)}">Go to Dashboard</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenGuardrails — Email Verification</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f8fafc; color: #1e293b; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 12px; padding: 40px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05);
            max-width: 520px; width: 100%; text-align: center; }
    h2 { font-size: 1.4rem; font-weight: 700; margin-bottom: 16px;
         color: ${success ? "#15803d" : "#dc2626"}; }
    p { color: #475569; line-height: 1.6; margin-bottom: 16px; }
    .agents { text-align: left; margin: 20px 0; }
    .agents h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 10px; color: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #e2e8f0;
         color: #64748b; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
    td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px;
             font-size: 0.75rem; font-weight: 600; }
    .badge-active { background: #dcfce7; color: #15803d; }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .login-info { text-align: left; margin: 20px 0; padding: 16px; background: #f8fafc;
                  border-radius: 8px; border: 1px solid #e2e8f0; }
    .login-info h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 8px; color: #334155; }
    .login-info p { font-size: 0.85rem; margin-bottom: 6px; }
    .login-info .hint { color: #64748b; font-size: 0.8rem; margin-bottom: 0; }
    .btn { display: inline-block; margin-top: 20px; padding: 12px 32px;
           background: #2563eb; color: white; text-decoration: none;
           border-radius: 8px; font-size: 1rem; font-weight: 600;
           transition: background .15s; }
    .btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${success ? "Email verified!" : "Verification failed"}</h2>
    <p>${message}</p>
    ${agentsHtml}
    ${loginHtml}
    ${dashboardBtn}
  </div>
</body>
</html>`;
}
