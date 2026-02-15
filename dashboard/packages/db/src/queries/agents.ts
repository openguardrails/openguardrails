import { eq, count } from "drizzle-orm";
import type { Database } from "../client.js";
import { agents } from "../schema/index.js";
import { insertReturning, updateReturning } from "../helpers.js";

export function agentQueries(db: Database) {
  return {
    async findById(id: string) {
      const result = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      return result[0] ?? null;
    },

    async findAll() {
      return db.select().from(agents).orderBy(agents.createdAt);
    },

    async countAll() {
      const result = await db.select({ count: count() }).from(agents);
      return result[0]?.count ?? 0;
    },

    async create(data: {
      name: string;
      description?: string | null;
      provider?: string;
      metadata?: Record<string, unknown>;
    }) {
      return insertReturning(db, agents, {
        ...data,
        provider: data.provider ?? "custom",
        metadata: data.metadata ?? {},
      });
    },

    async update(id: string, data: Partial<{
      name: string;
      description: string | null;
      provider: string;
      status: string;
      lastSeenAt: Date | string;
      metadata: Record<string, unknown>;
    }>) {
      return updateReturning(db, agents, eq(agents.id, id), {
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },

    async delete(id: string) {
      await db.delete(agents).where(eq(agents.id, id));
    },

    async heartbeat(id: string) {
      await db
        .update(agents)
        .set({ status: "active", lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(eq(agents.id, id));
    },
  };
}
