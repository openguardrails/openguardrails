import { Router, raw } from "express";
import Stripe from "stripe";
import { db } from "../db/client.js";
import { accountQueries } from "../db/queries/accounts.js";
import type { AccountPlan } from "../types.js";

const accts = accountQueries(db);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PLATFORM_URL = process.env.PLATFORM_URL || "https://platform.openguardrails.com";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Price IDs configured in .env — created in the Stripe Dashboard
const PRICE_IDS: Record<string, { plan: AccountPlan; label: string }> = {
  [process.env.STRIPE_PRICE_STARTER || "price_starter"]: { plan: "starter", label: "Starter" },
  [process.env.STRIPE_PRICE_PRO || "price_pro"]: { plan: "pro", label: "Pro" },
  [process.env.STRIPE_PRICE_BUSINESS || "price_business"]: { plan: "business", label: "Business" },
};

export const billingRouter = Router();

/**
 * POST /api/v1/billing/checkout
 *
 * Creates a Stripe Checkout session for upgrading.
 * Body: { plan: "starter" | "pro" | "business" }
 * Requires auth (res.locals.agent).
 */
billingRouter.post("/checkout", async (req, res, next) => {
  try {
    if (!stripe) {
      res.status(503).json({ success: false, error: "Billing not configured" });
      return;
    }

    const agent = res.locals.agent;
    if (!agent?.email) {
      res.status(403).json({ success: false, error: "Agent context with email required" });
      return;
    }

    const { plan } = req.body as { plan?: string };
    const priceEntry = Object.entries(PRICE_IDS).find(([, v]) => v.plan === plan);
    if (!priceEntry) {
      res.status(400).json({ success: false, error: "Invalid plan. Choose: starter, pro, or business" });
      return;
    }
    const [priceId] = priceEntry;

    // Find or create account
    const account = await accts.findOrCreate(agent.email);

    // Reuse or create Stripe customer
    let customerId = account.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: agent.email });
      customerId = customer.id;
      await accts.setStripeCustomer(agent.email, customerId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PLATFORM_URL}/login?checkout=success`,
      cancel_url: `${PLATFORM_URL}/login?checkout=cancel`,
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/billing/portal
 *
 * Creates a Stripe Customer Portal session for managing subscription.
 * Requires auth (res.locals.agent).
 */
billingRouter.post("/portal", async (req, res, next) => {
  try {
    if (!stripe) {
      res.status(503).json({ success: false, error: "Billing not configured" });
      return;
    }

    const agent = res.locals.agent;
    if (!agent?.email) {
      res.status(403).json({ success: false, error: "Agent context with email required" });
      return;
    }

    const account = await accts.findByEmail(agent.email);
    if (!account?.stripeCustomerId) {
      res.status(400).json({ success: false, error: "No billing account found" });
      return;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${PLATFORM_URL}/login`,
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/billing/webhook
 *
 * Stripe webhook endpoint. Handles subscription events.
 * Must be mounted BEFORE json body parser (needs raw body).
 */
export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string,
): Promise<{ ok: boolean; event?: string }> {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return { ok: false };
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch {
    return { ok: false };
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription && session.customer) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        const priceId = sub.items.data[0]?.price.id;
        const planInfo = priceId ? PRICE_IDS[priceId] : undefined;
        if (planInfo) {
          await accts.activateSubscription(
            session.customer as string,
            planInfo.plan,
            session.subscription as string,
          );
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await accts.cancelSubscription(sub.id);
      break;
    }

    case "invoice.paid": {
      // Reset quota at the start of each billing cycle
      const invoiceObj = event.data.object as unknown as Record<string, unknown>;
      const subId = typeof invoiceObj.subscription === "string" ? invoiceObj.subscription : null;
      if (subId) {
        await accts.resetQuota(subId);
      }
      break;
    }
  }

  return { ok: true, event: event.type };
}
