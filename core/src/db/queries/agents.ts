import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { registeredAgents, usageLogs } from "../schema.js";
import type { RegisteredAgent } from "../../types.js";

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
        quotaTotal: 100000,
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

    // Called when user clicks email verification link
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
      return toAgent({ ...row, status: "active", emailToken: null });
    },

    // Increment quota_used and log usage. Returns false if quota exceeded.
    async consumeQuota(id: string, endpoint: string, latencyMs: number): Promise<boolean> {
      const row = await db
        .select({ quotaTotal: registeredAgents.quotaTotal, quotaUsed: registeredAgents.quotaUsed })
        .from(registeredAgents)
        .where(eq(registeredAgents.id, id))
        .get();
      if (!row) return false;
      if (row.quotaUsed >= row.quotaTotal) return false;

      await db
        .update(registeredAgents)
        .set({ quotaUsed: row.quotaUsed + 1, updatedAt: new Date().toISOString() })
        .where(eq(registeredAgents.id, id));

      await db.insert(usageLogs).values({
        id: crypto.randomUUID(),
        agentId: id,
        endpoint,
        latencyMs,
        createdAt: new Date().toISOString(),
      });

      return true;
    },

    async getQuota(id: string): Promise<{ total: number; used: number; remaining: number } | null> {
      const row = await db
        .select({ quotaTotal: registeredAgents.quotaTotal, quotaUsed: registeredAgents.quotaUsed })
        .from(registeredAgents)
        .where(eq(registeredAgents.id, id))
        .get();
      if (!row) return null;
      return { total: row.quotaTotal, used: row.quotaUsed, remaining: row.quotaTotal - row.quotaUsed };
    },
  };
}
