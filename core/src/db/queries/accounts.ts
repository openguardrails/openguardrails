import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { accounts } from "../schema.js";
import type { Account, AccountPlan } from "../../types.js";

const PLAN_QUOTAS: Record<AccountPlan, number> = {
  free: 30_000,
  starter: 100_000,
  pro: 300_000,
  business: 2_000_000,
};

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    email: row.email,
    plan: row.plan as AccountPlan,
    quotaTotal: row.quotaTotal,
    quotaUsed: row.quotaUsed,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function accountQueries(db: Db) {
  return {
    async findByEmail(email: string): Promise<Account | null> {
      const row = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, email))
        .get();
      return row ? toAccount(row) : null;
    },

    async findOrCreate(email: string): Promise<Account> {
      const existing = await db
        .select()
        .from(accounts)
        .where(eq(accounts.email, email))
        .get();
      if (existing) return toAccount(existing);

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await db.insert(accounts).values({
        id,
        email,
        plan: "free",
        quotaTotal: PLAN_QUOTAS.free,
        quotaUsed: 0,
        createdAt: now,
        updatedAt: now,
      });
      const row = await db.select().from(accounts).where(eq(accounts.id, id)).get();
      return toAccount(row!);
    },

    async findByStripeCustomerId(customerId: string): Promise<Account | null> {
      const row = await db
        .select()
        .from(accounts)
        .where(eq(accounts.stripeCustomerId!, customerId))
        .get();
      return row ? toAccount(row) : null;
    },

    async consumeQuota(email: string): Promise<boolean> {
      const row = await db
        .select({ quotaTotal: accounts.quotaTotal, quotaUsed: accounts.quotaUsed })
        .from(accounts)
        .where(eq(accounts.email, email))
        .get();
      if (!row) return false;
      if (row.quotaUsed >= row.quotaTotal) return false;

      await db
        .update(accounts)
        .set({ quotaUsed: row.quotaUsed + 1, updatedAt: new Date().toISOString() })
        .where(eq(accounts.email, email));
      return true;
    },

    async getQuota(email: string): Promise<{ total: number; used: number; remaining: number } | null> {
      const row = await db
        .select({ quotaTotal: accounts.quotaTotal, quotaUsed: accounts.quotaUsed })
        .from(accounts)
        .where(eq(accounts.email, email))
        .get();
      if (!row) return null;
      return { total: row.quotaTotal, used: row.quotaUsed, remaining: row.quotaTotal - row.quotaUsed };
    },

    async setStripeCustomer(email: string, stripeCustomerId: string): Promise<void> {
      await db
        .update(accounts)
        .set({ stripeCustomerId, updatedAt: new Date().toISOString() })
        .where(eq(accounts.email, email));
    },

    async activateSubscription(
      stripeCustomerId: string,
      plan: AccountPlan,
      stripeSubscriptionId: string,
    ): Promise<void> {
      const quota = PLAN_QUOTAS[plan];
      await db
        .update(accounts)
        .set({
          plan,
          quotaTotal: quota,
          quotaUsed: 0,
          stripeSubscriptionId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(accounts.stripeCustomerId!, stripeCustomerId));
    },

    async cancelSubscription(stripeSubscriptionId: string): Promise<void> {
      await db
        .update(accounts)
        .set({
          plan: "free",
          quotaTotal: PLAN_QUOTAS.free,
          stripeSubscriptionId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(accounts.stripeSubscriptionId!, stripeSubscriptionId));
    },

    /** Reset quotaUsed to 0 at the start of each billing cycle */
    async resetQuota(stripeSubscriptionId: string): Promise<void> {
      await db
        .update(accounts)
        .set({ quotaUsed: 0, updatedAt: new Date().toISOString() })
        .where(eq(accounts.stripeSubscriptionId!, stripeSubscriptionId));
    },
  };
}
