import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { registeredAgents, usageLogs, accounts } from "../schema.js";
import type { RegisteredAgent } from "../../types.js";

function generateApiKey(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sk-og-${hex}`;
}

function toAgent(row: typeof registeredAgents.$inferSelect): RegisteredAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    apiKey: row.apiKey,
    claimToken: row.claimToken,
    verificationCode: row.verificationCode,
    email: row.email,
    status: row.status as RegisteredAgent["status"],
    quotaTotal: row.quotaTotal,
    quotaUsed: row.quotaUsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function agentQueries(db: Db) {
  return {
    async create(data: {
      id: string;
      name: string;
      description?: string | null;
      apiKey: string;
      claimToken: string;
      verificationCode: string;
    }): Promise<RegisteredAgent> {
      const now = new Date().toISOString();
      await db.insert(registeredAgents).values({
        id: data.id,
        name: data.name,
        description: data.description ?? null,
        apiKey: data.apiKey,
        claimToken: data.claimToken,
        verificationCode: data.verificationCode,
        status: "pending_claim",
        quotaTotal: 30000,
        quotaUsed: 0,
        createdAt: now,
        updatedAt: now,
      });
      const row = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.id, data.id))
        .get();
      return toAgent(row!);
    },

    async findByApiKey(apiKey: string): Promise<RegisteredAgent | null> {
      const row = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.apiKey, apiKey))
        .get();
      return row ? toAgent(row) : null;
    },

    async findByClaimToken(claimToken: string): Promise<RegisteredAgent | null> {
      const row = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.claimToken, claimToken))
        .get();
      return row ? toAgent(row) : null;
    },

    async findById(id: string): Promise<RegisteredAgent | null> {
      const row = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.id, id))
        .get();
      return row ? toAgent(row) : null;
    },

    async findAllByEmail(email: string): Promise<RegisteredAgent[]> {
      const rows = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.email, email));
      return rows.map(toAgent);
    },

    // Called during claim flow: store email + email token
    async setEmailPending(id: string, email: string, emailToken: string): Promise<void> {
      await db
        .update(registeredAgents)
        .set({ email, emailToken, updatedAt: new Date().toISOString() })
        .where(eq(registeredAgents.id, id));
    },

    // Called when user clicks email verification link.
    // Also creates the account row if it doesn't exist.
    async activateByEmailToken(emailToken: string): Promise<RegisteredAgent | null> {
      const row = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.emailToken!, emailToken))
        .get();
      if (!row) return null;
      await db
        .update(registeredAgents)
        .set({ status: "active", emailToken: null, updatedAt: new Date().toISOString() })
        .where(eq(registeredAgents.id, row.id));

      // Ensure account exists for this email
      if (row.email) {
        const existing = await db
          .select()
          .from(accounts)
          .where(eq(accounts.email, row.email))
          .get();
        if (!existing) {
          const now = new Date().toISOString();
          await db.insert(accounts).values({
            id: crypto.randomUUID(),
            email: row.email,
            plan: "free",
            quotaTotal: 30_000,
            quotaUsed: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      return toAgent({ ...row, status: "active", emailToken: null });
    },

    // Regenerate API key for an agent. Returns the new key.
    async regenerateApiKey(agentId: string, email: string): Promise<string | null> {
      const row = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.id, agentId))
        .get();
      if (!row || row.email !== email) return null;

      const newKey = generateApiKey();
      await db
        .update(registeredAgents)
        .set({ apiKey: newKey, updatedAt: new Date().toISOString() })
        .where(eq(registeredAgents.id, agentId));
      return newKey;
    },

    // Log usage (agent-level tracking for attribution)
    async logUsage(agentId: string, endpoint: string, latencyMs: number, model?: string): Promise<void> {
      await db.insert(usageLogs).values({
        id: crypto.randomUUID(),
        agentId,
        endpoint,
        model: model ?? null,
        latencyMs,
        createdAt: new Date().toISOString(),
      });
    },

    // Legacy — kept for backward compatibility but quota now lives on accounts
    async consumeQuota(id: string, endpoint: string, latencyMs: number, model?: string): Promise<boolean> {
      const agent = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.id, id))
        .get();
      if (!agent?.email) return false;

      // Check account-level quota
      const acct = await db
        .select({ quotaTotal: accounts.quotaTotal, quotaUsed: accounts.quotaUsed })
        .from(accounts)
        .where(eq(accounts.email, agent.email))
        .get();
      if (!acct) return false;
      if (acct.quotaUsed >= acct.quotaTotal) return false;

      // Increment account quota
      await db
        .update(accounts)
        .set({ quotaUsed: acct.quotaUsed + 1, updatedAt: new Date().toISOString() })
        .where(eq(accounts.email, agent.email));

      // Log usage per agent
      await db.insert(usageLogs).values({
        id: crypto.randomUUID(),
        agentId: id,
        endpoint,
        model: model ?? null,
        latencyMs,
        createdAt: new Date().toISOString(),
      });

      return true;
    },

    async getQuota(id: string): Promise<{ total: number; used: number; remaining: number } | null> {
      const agent = await db
        .select()
        .from(registeredAgents)
        .where(eq(registeredAgents.id, id))
        .get();
      if (!agent?.email) return null;

      const acct = await db
        .select({ quotaTotal: accounts.quotaTotal, quotaUsed: accounts.quotaUsed })
        .from(accounts)
        .where(eq(accounts.email, agent.email))
        .get();
      if (!acct) return null;
      return { total: acct.quotaTotal, used: acct.quotaUsed, remaining: acct.quotaTotal - acct.quotaUsed };
    },

    async getUsageLogsByEmail(
      email: string,
      opts?: { from?: string; to?: string },
    ): Promise<Array<{
      id: string;
      agentName: string;
      endpoint: string;
      model: string | null;
      latencyMs: number;
      createdAt: string;
    }>> {
      // Find all agents for this email
      const agentRows = await db
        .select({ id: registeredAgents.id, name: registeredAgents.name })
        .from(registeredAgents)
        .where(eq(registeredAgents.email, email));
      if (agentRows.length === 0) return [];

      const agentIds = agentRows.map((a) => a.id);
      const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

      // Enforce 30-day max window
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const from = opts?.from && opts.from >= thirtyDaysAgo ? opts.from : thirtyDaysAgo;
      const to = opts?.to ?? now.toISOString();

      const conditions = [
        sql`${usageLogs.agentId} IN (${sql.join(agentIds.map((id) => sql`${id}`), sql`, `)})`,
        gte(usageLogs.createdAt, from),
        lte(usageLogs.createdAt, to),
      ];

      const rows = await db
        .select({
          id: usageLogs.id,
          agentId: usageLogs.agentId,
          endpoint: usageLogs.endpoint,
          model: usageLogs.model,
          latencyMs: usageLogs.latencyMs,
          createdAt: usageLogs.createdAt,
        })
        .from(usageLogs)
        .where(and(...conditions))
        .orderBy(desc(usageLogs.createdAt))
        .limit(500);

      return rows.map((r) => ({
        id: r.id,
        agentName: agentNameMap.get(r.agentId) ?? "Unknown",
        endpoint: r.endpoint,
        model: r.model,
        latencyMs: r.latencyMs,
        createdAt: r.createdAt,
      }));
    },
  };
}
