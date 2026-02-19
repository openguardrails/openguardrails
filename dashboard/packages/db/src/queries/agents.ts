import { eq, and, count } from "drizzle-orm";
import type { Database } from "../client.js";
import { agents } from "../schema/index.js";
import { insertReturning, updateReturning } from "../helpers.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function agentQueries(db: Database) {
  return {
    async findById(id: string, tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.tenantId, tenantId))).limit(1);
      return result[0] ?? null;
    },

    async findByName(name: string, tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db.select().from(agents).where(and(eq(agents.name, name), eq(agents.tenantId, tenantId))).limit(1);
      return result[0] ?? null;
    },

    async findAll(tenantId: string = DEFAULT_TENANT_ID) {
      return db.select().from(agents).where(eq(agents.tenantId, tenantId)).orderBy(agents.createdAt);
    },

    async countAll(tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db.select({ count: count() }).from(agents).where(eq(agents.tenantId, tenantId));
      return result[0]?.count ?? 0;
    },

    async create(data: {
      name: string;
      description?: string | null;
      provider?: string;
      metadata?: Record<string, unknown>;
      tenantId?: string;
    }) {
      return insertReturning(db, agents, {
        ...data,
        provider: data.provider ?? "custom",
        metadata: data.metadata ?? {},
        tenantId: data.tenantId ?? DEFAULT_TENANT_ID,
      });
    },

    async update(id: string, data: Partial<{
      name: string;
      description: string | null;
      provider: string;
      status: string;
      lastSeenAt: Date | string;
      metadata: Record<string, unknown>;
    }>, tenantId: string = DEFAULT_TENANT_ID) {
      return updateReturning(db, agents, and(eq(agents.id, id), eq(agents.tenantId, tenantId)), {
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },

    async delete(id: string, tenantId: string = DEFAULT_TENANT_ID) {
      await db.delete(agents).where(and(eq(agents.id, id), eq(agents.tenantId, tenantId)));
    },

    async heartbeat(id: string, tenantId: string = DEFAULT_TENANT_ID) {
      await db
        .update(agents)
        .set({ status: "active", lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(agents.id, id), eq(agents.tenantId, tenantId)));
    },
  };
}
