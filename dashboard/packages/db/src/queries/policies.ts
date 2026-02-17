import { eq, and } from "drizzle-orm";
import type { Database } from "../client.js";
import { policies } from "../schema/index.js";
import { insertReturning, updateReturning } from "../helpers.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function policyQueries(db: Database) {
  return {
    async findAll(tenantId: string = DEFAULT_TENANT_ID) {
      return db.select().from(policies).where(eq(policies.tenantId, tenantId)).orderBy(policies.createdAt);
    },

    async findById(id: string, tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db.select().from(policies).where(and(eq(policies.id, id), eq(policies.tenantId, tenantId))).limit(1);
      return result[0] ?? null;
    },

    async create(data: {
      name: string;
      description?: string | null;
      scannerIds: string[];
      action: string;
      sensitivityThreshold?: number;
      tenantId?: string;
    }) {
      return insertReturning(db, policies, {
        ...data,
        sensitivityThreshold: data.sensitivityThreshold ?? 0.5,
        tenantId: data.tenantId ?? DEFAULT_TENANT_ID,
      });
    },

    async update(id: string, data: Partial<{
      name: string;
      description: string | null;
      scannerIds: string[];
      action: string;
      sensitivityThreshold: number;
      isEnabled: boolean;
    }>, tenantId: string = DEFAULT_TENANT_ID) {
      return updateReturning(db, policies, and(eq(policies.id, id), eq(policies.tenantId, tenantId)), {
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },

    async delete(id: string, tenantId: string = DEFAULT_TENANT_ID) {
      await db.delete(policies).where(and(eq(policies.id, id), eq(policies.tenantId, tenantId)));
    },

    /** Get all enabled policies for detection flow */
    async getEnabled(tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select()
        .from(policies)
        .where(and(eq(policies.isEnabled, true), eq(policies.tenantId, tenantId)));
    },
  };
}
