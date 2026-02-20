import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";
import { accountQueries } from "../db/queries/accounts.js";
import type { Account, AccountPlan } from "../types.js";

const agents = agentQueries(db);
const accts = accountQueries(db);
const DASHBOARD_URL = process.env.DASHBOARD_URL || process.env.PLATFORM_URL || "https://platform.openguardrails.com";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const PLATFORM_URL = process.env.PLATFORM_URL || "https://platform.openguardrails.com";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const PRICE_IDS: Record<string, { plan: AccountPlan; label: string }> = {
  [process.env.STRIPE_PRICE_STARTER || "price_starter"]: { plan: "starter", label: "Starter" },
  [process.env.STRIPE_PRICE_PRO || "price_pro"]: { plan: "pro", label: "Pro" },
  [process.env.STRIPE_PRICE_BUSINESS || "price_business"]: { plan: "business", label: "Business" },
};

export const portalRouter = Router();

// ─── Session store ──────────────────────────────────────────────────

interface PortalSession {
  email: string;
  apiKey: string;
  notice?: string; // flash message, cleared after first read
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map<string, PortalSession>();

function createSession(email: string, apiKey: string): string {
  // Lazy cleanup of expired sessions
  if (sessions.size > 100) {
    const now = Date.now();
    for (const [key, sess] of sessions) {
      if (sess.expiresAt < now) sessions.delete(key);
    }
  }

  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  sessions.set(token, { email, apiKey, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSessionToken(req: Request): string | null {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  const match = cookies.split(";").find((c) => c.trim().startsWith("og_session="));
  return match?.split("=")[1]?.trim() ?? null;
}

function getSession(req: Request): PortalSession | null {
  const token = getSessionToken(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie("og_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie("og_session", { path: "/" });
}

function flashNotice(session: PortalSession): string | undefined {
  const notice = session.notice;
  if (notice) session.notice = undefined;
  return notice;
}

// ─── Helpers ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 16) return apiKey.slice(0, 6) + "...";
  return apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "k";
  return n.toString();
}

// ─── Routes ─────────────────────────────────────────────────────────

/**
 * GET /login — sign-in page (redirects to /account if already logged in)
 */
portalRouter.get("/login", (req, res) => {
  const session = getSession(req);
  if (session) {
    res.redirect(302, "/account");
    return;
  }
  res.send(loginPage({}));
});

/**
 * POST /login — validate email + API key, create session, redirect to /account
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

    const token = createSession(agent.email, apiKey);
    setSessionCookie(res, token);
    res.redirect(303, "/account");
  } catch (err) {
    next(err);
  }
});

/**
 * GET /account — account portal (session required)
 */
portalRouter.get("/account", async (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session) {
      res.redirect(302, "/login");
      return;
    }

    const allAgents = await agents.findAllByEmail(session.email);
    const account = await accts.findOrCreate(session.email);
    const notice = flashNotice(session);

    const dashboardAutoLogin = `${DASHBOARD_URL}?email=${encodeURIComponent(session.email)}&apiKey=${encodeURIComponent(session.apiKey)}`;
    res.send(accountPage({ email: session.email, dashboardUrl: dashboardAutoLogin, agents: allAgents, account, notice }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /account/usage — usage logs page (session required)
 */
portalRouter.get("/account/usage", async (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session) {
      res.redirect(302, "/login");
      return;
    }

    const { from, to } = req.query as { from?: string; to?: string };
    const logs = await agents.getUsageLogsByEmail(session.email, { from, to });
    res.send(usagePage({ email: session.email, logs, from, to }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /account/regenerate-key — regenerate API key for an agent
 */
portalRouter.post("/account/regenerate-key", async (req, res, next) => {
  try {
    const session = getSession(req);
    if (!session) {
      res.redirect(302, "/login");
      return;
    }

    const { agentId } = req.body as { agentId?: string };
    if (!agentId) {
      res.redirect(303, "/account");
      return;
    }

    const newKey = await agents.regenerateApiKey(agentId, session.email);
    if (!newKey) {
      session.notice = "Could not regenerate key.";
      res.redirect(303, "/account");
      return;
    }

    // If the regenerated key was the login key, update the session
    const sessionAgent = await agents.findByApiKey(session.apiKey);
    if (!sessionAgent) {
      // Old key no longer exists — it was the one just regenerated
      session.apiKey = newKey;
    }

    session.notice = `API key regenerated for agent. New key: ${newKey}`;
    res.redirect(303, "/account");
  } catch (err) {
    next(err);
  }
});

/**
 * POST /account/checkout — portal-initiated Stripe checkout
 */
portalRouter.post("/account/checkout", async (req, res, next) => {
  try {
    if (!stripe) {
      res.status(503).send(loginPage({ error: "Billing not configured." }));
      return;
    }

    const session = getSession(req);
    if (!session) {
      res.redirect(302, "/login");
      return;
    }

    const { plan } = req.body as { plan?: string };
    const priceEntry = Object.entries(PRICE_IDS).find(([, v]) => v.plan === plan);
    if (!priceEntry) {
      session.notice = "Invalid plan selected.";
      res.redirect(303, "/account");
      return;
    }
    const [priceId] = priceEntry;

    const account = await accts.findOrCreate(session.email);
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: session.email });
      customerId = customer.id;
      await accts.setStripeCustomer(session.email, customerId);
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PLATFORM_URL}/account?checkout=success`,
      cancel_url: `${PLATFORM_URL}/account?checkout=cancel`,
    });

    if (checkoutSession.url) {
      res.redirect(303, checkoutSession.url);
    } else {
      session.notice = "Failed to create checkout session.";
      res.redirect(303, "/account");
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /logout — clear session, redirect to login
 */
portalRouter.get("/logout", (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.redirect(302, "/login");
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
    button { width: 100%; padding: 12px; background: #2563eb; color: white; border: none;
             border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer;
             transition: background .15s; margin-top: 4px; }
    button:hover { background: #1d4ed8; }
    .error { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626;
             padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem; }
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
  </div>
</body>
</html>`;
}

// ─── Account page HTML ────────────────────────────────────────────

function accountPage(opts: {
  email: string;
  dashboardUrl: string;
  agents: Array<{
    id: string;
    name: string;
    description: string | null;
    apiKey: string;
    status: string;
    quotaTotal: number;
    quotaUsed: number;
  }>;
  account: Account;
  notice?: string;
}): string {
  const { email, dashboardUrl, agents: agentList, account, notice } = opts;

  const quotaRemaining = Math.max(0, account.quotaTotal - account.quotaUsed);
  const quotaPct = account.quotaTotal > 0 ? Math.round((account.quotaUsed / account.quotaTotal) * 100) : 0;

  const rows = agentList.map((a, i) => `
    <tr>
      <td>
        <strong>${esc(a.name)}</strong>
        ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ""}
      </td>
      <td>
        <div class="key-cell">
          <code id="key-masked-${i}">${esc(maskApiKey(a.apiKey))}</code>
          <code id="key-full-${i}" style="display:none; word-break:break-all;">${esc(a.apiKey)}</code>
          <button type="button" class="btn-key" onclick="toggleKey(${i})" id="key-toggle-${i}">Show</button>
          <button type="button" class="btn-key" onclick="copyKey('${esc(a.apiKey)}')">Copy</button>
        </div>
      </td>
      <td><span class="badge badge-${a.status === "active" ? "active" : "pending"}">${esc(a.status)}</span></td>
      <td>
        <form method="POST" action="/account/regenerate-key" style="margin:0">
          <input type="hidden" name="agentId" value="${esc(a.id)}">
          <button type="submit" class="btn-regen" onclick="return confirm('Regenerate API key for ${esc(a.name)}? The old key will stop working immediately.')">Regenerate</button>
        </form>
      </td>
    </tr>`).join("");

  const planLabel: Record<string, string> = { free: "Free", starter: "Starter", pro: "Pro", business: "Business" };
  const currentPlan = planLabel[account.plan] || account.plan;

  const plans = [
    { id: "starter",  name: "Starter",  price: "$19",  calls: "100k", callsNum: "100,000" },
    { id: "pro",      name: "Pro",      price: "$49",  calls: "300k", callsNum: "300,000" },
    { id: "business", name: "Business", price: "$199", calls: "2M",   callsNum: "2,000,000" },
  ];

  const pricingCards = plans.map((p) => {
    const isCurrent = account.plan === p.id;
    return `
      <div class="plan-card ${isCurrent ? "plan-current" : ""}">
        <div class="plan-name">${p.name}</div>
        <div class="plan-price">${p.price}<span>/mo</span></div>
        <div class="plan-calls">${p.callsNum} calls/mo</div>
        ${isCurrent
          ? `<div class="plan-badge">Current plan</div>`
          : `<form method="POST" action="/account/checkout" style="margin:0">
              <input type="hidden" name="plan" value="${p.id}">
              <button type="submit" class="plan-btn">Upgrade</button>
            </form>`
        }
      </div>`;
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
    .page { max-width: 720px; width: 100%; }
    .card { background: white; border-radius: 12px; padding: 28px 32px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05);
            margin-bottom: 20px; }
    h2 { font-size: 1.3rem; font-weight: 700; margin-bottom: 4px; }
    .email { color: #64748b; font-size: 0.9rem; margin-bottom: 4px; }
    .plan-label { font-size: 0.8rem; color: #2563eb; font-weight: 600; margin-bottom: 16px; }
    h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 12px; color: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #e2e8f0;
         color: #64748b; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    td { padding: 10px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .desc { color: #94a3b8; font-size: 0.8rem; margin-top: 2px; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px;
             font-size: 0.75rem; font-weight: 600; }
    .badge-active { background: #dcfce7; color: #15803d; }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .btn-regen { padding: 4px 10px; font-size: 0.75rem; font-weight: 500;
                 background: white; border: 1px solid #e2e8f0; border-radius: 6px;
                 cursor: pointer; color: #64748b; transition: all .15s; }
    .btn-regen:hover { border-color: #f97316; color: #f97316; }

    /* API Key cell */
    .key-cell { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .btn-key { padding: 2px 8px; font-size: 0.7rem; font-weight: 500;
               background: white; border: 1px solid #e2e8f0; border-radius: 4px;
               cursor: pointer; color: #64748b; transition: all .15s; white-space: nowrap; }
    .btn-key:hover { border-color: #2563eb; color: #2563eb; }

    /* Quota */
    .quota-section { margin-bottom: 8px; }
    .quota-bar { width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; margin: 8px 0; }
    .quota-fill { height: 100%; background: #2563eb; border-radius: 4px; transition: width .3s; }
    .quota-text { font-size: 0.8rem; color: #64748b; }

    /* Pricing */
    .pricing { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .plan-card { background: white; border: 1.5px solid #e2e8f0; border-radius: 10px;
                 padding: 24px 20px; text-align: center; transition: border-color .15s; }
    .plan-card:hover { border-color: #2563eb; }
    .plan-current { border-color: #2563eb; background: #eff6ff; }
    .plan-name { font-weight: 700; font-size: 1rem; margin-bottom: 4px; }
    .plan-price { font-size: 1.8rem; font-weight: 800; color: #1e293b; }
    .plan-price span { font-size: 0.85rem; font-weight: 500; color: #64748b; }
    .plan-calls { font-size: 0.8rem; color: #64748b; margin: 8px 0 16px; }
    .plan-badge { font-size: 0.75rem; font-weight: 600; color: #2563eb; }
    .plan-btn { padding: 8px 20px; background: #2563eb; color: white; border: none;
                border-radius: 6px; font-size: 0.85rem; font-weight: 600;
                cursor: pointer; transition: background .15s; }
    .plan-btn:hover { background: #1d4ed8; }

    /* Actions */
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    .btn { display: inline-block; padding: 10px 20px; border-radius: 8px;
           font-size: 0.9rem; font-weight: 600; text-decoration: none;
           transition: all .15s; }
    .btn-outline { background: white; color: #334155; border: 1.5px solid #e2e8f0; }
    .btn-outline:hover { border-color: #2563eb; color: #2563eb; }
    .notice { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d;
              padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.85rem;
              word-break: break-all; }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <h2>Your Account</h2>
      <p class="email">${esc(email)}</p>
      <p class="plan-label">${esc(currentPlan)} plan</p>
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}

      <div class="quota-section">
        <h3>Account Quota</h3>
        <div class="quota-bar"><div class="quota-fill" style="width:${quotaPct}%"></div></div>
        <span class="quota-text">${account.quotaUsed.toLocaleString()} / ${account.quotaTotal.toLocaleString()} calls used (${quotaRemaining.toLocaleString()} remaining)</span>
      </div>
    </div>

    <div class="card">
      <h3>Agents</h3>
      <table>
        <thead><tr><th>Agent</th><th>API Key</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="card">
      <h3>Plans</h3>
      <div class="pricing">
        ${pricingCards}
      </div>
    </div>

    <div class="actions">
      <a class="btn btn-outline" href="/account/usage">Usage Logs</a>
      <a class="btn btn-outline" href="${esc(dashboardUrl)}">Open Dashboard</a>
      <a class="btn btn-outline" href="/logout">Sign Out</a>
    </div>
  </div>
  <script>
    function toggleKey(i) {
      var masked = document.getElementById('key-masked-' + i);
      var full = document.getElementById('key-full-' + i);
      var btn = document.getElementById('key-toggle-' + i);
      if (full.style.display === 'none') {
        masked.style.display = 'none';
        full.style.display = 'inline';
        btn.textContent = 'Hide';
      } else {
        masked.style.display = 'inline';
        full.style.display = 'none';
        btn.textContent = 'Show';
      }
    }
    function copyKey(key) {
      navigator.clipboard.writeText(key).then(function() {
        // brief visual feedback
        var el = event.target;
        var orig = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(function() { el.textContent = orig; }, 1500);
      });
    }
  </script>
</body>
</html>`;
}

// ─── Usage page HTML ──────────────────────────────────────────────

function usagePage(opts: {
  email: string;
  logs: Array<{
    id: string;
    agentName: string;
    endpoint: string;
    model: string | null;
    latencyMs: number;
    createdAt: string;
  }>;
  from?: string;
  to?: string;
}): string {
  const { email, logs, from, to } = opts;

  // Default date range: last 7 days
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const defaultFrom = sevenDaysAgo.toISOString().slice(0, 10);
  const defaultTo = now.toISOString().slice(0, 10);
  const filterFrom = from ?? defaultFrom;
  const filterTo = to ?? defaultTo;

  // Summary stats
  const totalRequests = logs.length;
  const endpointCounts: Record<string, number> = {};
  let totalLatency = 0;
  for (const log of logs) {
    endpointCounts[log.endpoint] = (endpointCounts[log.endpoint] ?? 0) + 1;
    totalLatency += log.latencyMs;
  }
  const avgLatency = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;

  const breakdownHtml = Object.entries(endpointCounts)
    .map(([ep, count]) => `<span class="stat-chip">${esc(ep)}: ${count}</span>`)
    .join(" ");

  const rows = logs.map((log) => {
    const ts = new Date(log.createdAt);
    const dateStr = ts.toISOString().replace("T", " ").slice(0, 19);
    return `
      <tr>
        <td><code>${esc(log.id.slice(0, 8))}</code></td>
        <td>${esc(log.agentName)}</td>
        <td>${esc(log.endpoint)}</td>
        <td>${log.model ? esc(log.model) : "&mdash;"}</td>
        <td>${log.latencyMs}ms</td>
        <td>${esc(dateStr)}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenGuardrails — Usage Logs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #f8fafc; color: #1e293b; min-height: 100vh;
           display: flex; align-items: flex-start; justify-content: center; padding: 40px 24px; }
    .page { max-width: 900px; width: 100%; }
    .card { background: white; border-radius: 12px; padding: 28px 32px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 12px rgba(0,0,0,.05);
            margin-bottom: 20px; }
    h2 { font-size: 1.3rem; font-weight: 700; margin-bottom: 4px; }
    .email { color: #64748b; font-size: 0.9rem; margin-bottom: 16px; }
    h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 12px; color: #334155; }
    .summary { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 8px; }
    .summary-item { font-size: 0.85rem; color: #64748b; }
    .summary-item strong { color: #1e293b; font-size: 1.1rem; }
    .stat-chip { display: inline-block; background: #f1f5f9; padding: 2px 8px;
                 border-radius: 4px; font-size: 0.8rem; color: #475569; }
    .filter-form { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 16px; }
    .filter-form label { display: flex; flex-direction: column; gap: 4px;
                         font-weight: 500; font-size: 0.8rem; color: #64748b; }
    .filter-form input[type="date"] { padding: 8px 10px; border: 1.5px solid #e2e8f0;
                                       border-radius: 6px; font-size: 0.85rem; }
    .filter-form button { padding: 8px 16px; background: #2563eb; color: white; border: none;
                           border-radius: 6px; font-size: 0.85rem; font-weight: 600;
                           cursor: pointer; align-self: flex-end; }
    .filter-form button:hover { background: #1d4ed8; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #e2e8f0;
         color: #64748b; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; }
    td { padding: 10px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
    .empty { text-align: center; color: #94a3b8; padding: 40px 0; }
    .actions { display: flex; gap: 10px; margin-top: 20px; }
    .btn { display: inline-block; padding: 10px 20px; border-radius: 8px;
           font-size: 0.9rem; font-weight: 600; text-decoration: none;
           transition: all .15s; border: none; cursor: pointer; }
    .btn-outline { background: white; color: #334155; border: 1.5px solid #e2e8f0; }
    .btn-outline:hover { border-color: #2563eb; color: #2563eb; }
  </style>
</head>
<body>
  <div class="page">
    <div class="card">
      <h2>Usage Logs</h2>
      <p class="email">${esc(email)}</p>

      <div class="summary">
        <div class="summary-item"><strong>${totalRequests}</strong> requests</div>
        <div class="summary-item"><strong>${avgLatency}ms</strong> avg latency</div>
        <div class="summary-item">${breakdownHtml || "<span class='stat-chip'>No data</span>"}</div>
      </div>
    </div>

    <div class="card">
      <h3>Filter by Date</h3>
      <form method="GET" action="/account/usage" class="filter-form">
        <label>From <input type="date" name="from" value="${esc(filterFrom)}"></label>
        <label>To <input type="date" name="to" value="${esc(filterTo)}"></label>
        <button type="submit">Filter</button>
      </form>
    </div>

    <div class="card">
      <h3>Request Log</h3>
      ${logs.length > 0 ? `
      <table>
        <thead>
          <tr>
            <th>Request ID</th>
            <th>Agent</th>
            <th>Endpoint</th>
            <th>Model</th>
            <th>Latency</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="empty">No usage logs found for this date range.</div>`}
    </div>

    <div class="actions">
      <a class="btn btn-outline" href="/account">Back to Account</a>
    </div>
  </div>
</body>
</html>`;
}
