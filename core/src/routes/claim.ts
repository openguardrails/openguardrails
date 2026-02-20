import { Router } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";
import { generateEmailToken } from "../lib/tokens.js";
import { sendVerificationEmail } from "../services/email.js";

const agents = agentQueries(db);

export const claimRouter = Router();

/**
 * GET /claim/:claimToken
 *
 * User-facing HTML page (served at platform.openguardrails.com/claim/:token).
 * Shows a form where the user enters:
 *   1. The verification_code (proves they received it from the agent)
 *   2. Their email
 *
 * On submission → POST /claim/:claimToken
 */
claimRouter.get("/:claimToken", async (req, res, next) => {
  try {
    const agent = await agents.findByClaimToken(req.params.claimToken!);
    if (!agent) {
      res.status(404).send(claimPage({ error: "Claim link not found or already used." }));
      return;
    }
    if (agent.status === "active") {
      res.send(claimPage({ alreadyActivated: true, agentName: agent.name }));
      return;
    }
    res.send(claimPage({ agentName: agent.name, claimToken: req.params.claimToken! }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /claim/:claimToken
 *
 * Processes the claim form submission.
 * Validates the verification code and email, then sends a verification email.
 */
claimRouter.post("/:claimToken", async (req, res, next) => {
  try {
    const { verification_code, email } = req.body as {
      verification_code?: string;
      email?: string;
    };

    const agent = await agents.findByClaimToken(req.params.claimToken!);
    if (!agent) {
      res.status(404).send(claimPage({ error: "Claim link not found." }));
      return;
    }
    if (agent.status === "active") {
      res.send(claimPage({ alreadyActivated: true, agentName: agent.name }));
      return;
    }

    if (!verification_code || verification_code.trim() !== agent.verificationCode) {
      res.send(
        claimPage({
          agentName: agent.name,
          claimToken: req.params.claimToken!,
          error: "Incorrect verification code. Check the code displayed in your OpenClaw.",
        }),
      );
      return;
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.send(
        claimPage({
          agentName: agent.name,
          claimToken: req.params.claimToken!,
          error: "Please enter a valid email address.",
        }),
      );
      return;
    }

    const emailToken = generateEmailToken();
    await agents.setEmailPending(agent.id, email.toLowerCase().trim(), emailToken);
    await sendVerificationEmail({ email, agentName: agent.name, emailToken, apiKey: agent.apiKey });

    res.send(claimPage({ emailSent: true, email, agentName: agent.name }));
  } catch (err) {
    next(err);
  }
});

// ─── Minimal inline HTML ─────────────────────────────────────────

function claimPage(opts: {
  agentName?: string;
  claimToken?: string;
  error?: string;
  emailSent?: boolean;
  email?: string;
  alreadyActivated?: boolean;
}): string {
  const { agentName, claimToken, error, emailSent, email, alreadyActivated } = opts;

  let body = "";

  if (alreadyActivated) {
    body = `
      <div class="card success">
        <h2>✅ Already activated</h2>
        <p>Agent <strong>${esc(agentName ?? "")}</strong> is already active.</p>
      </div>`;
  } else if (emailSent) {
    body = `
      <div class="card success">
        <h2>📧 Check your email</h2>
        <p>We sent a verification link to <strong>${esc(email ?? "")}</strong>.</p>
        <p>Click the link in the email to activate your agent <strong>${esc(agentName ?? "")}</strong>
           and unlock your 30,000 free security checks.</p>
      </div>`;
  } else {
    body = `
      <div class="card">
        <h2>Claim your OpenGuardrails agent</h2>
        ${agentName ? `<p>Agent: <strong>${esc(agentName)}</strong></p>` : ""}
        ${error ? `<div class="error">${esc(error)}</div>` : ""}
        <form method="POST" action="/claim/${esc(claimToken ?? "")}">
          <label>
            Verification code
            <input type="text" name="verification_code" placeholder="e.g. reef-X4B2"
              autocomplete="off" required>
            <small>Find this in your OpenClaw terminal after the plugin loads.</small>
          </label>
          <label>
            Your email
            <input type="email" name="email" placeholder="you@example.com" required>
            <small>Used to log in to the dashboard and receive alerts.</small>
          </label>
          <button type="submit">Verify &amp; Activate</button>
        </form>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenGuardrails — Claim Agent</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f8fafc; color: #1e293b; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 12px; padding: 40px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05);
            max-width: 440px; width: 100%; }
    h2 { font-size: 1.4rem; font-weight: 700; margin-bottom: 16px; }
    p { color: #475569; line-height: 1.6; margin-bottom: 12px; }
    label { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px;
            font-weight: 500; font-size: 0.9rem; }
    input { padding: 10px 14px; border: 1.5px solid #e2e8f0; border-radius: 8px;
            font-size: 1rem; outline: none; transition: border-color .15s; }
    input:focus { border-color: #2563eb; }
    small { color: #94a3b8; font-weight: 400; }
    button { width: 100%; padding: 12px; background: #2563eb; color: white; border: none;
             border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;
             transition: background .15s; }
    button:hover { background: #1d4ed8; }
    .error { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626;
             padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.9rem; }
    .success h2 { color: #15803d; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

