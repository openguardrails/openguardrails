import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { policies } from "../schema/index.js";
import { insertReturning, updateReturning } from "../helpers.js";

export function policyQueries(db: Database) {
  return {
    async findAll() {
      return db.select().from(policies).orderBy(policies.createdAt);
    },

    async findById(id: string) {
      const result = await db.select().from(policies).where(eq(policies.id, id)).limit(1);
      return result[0] ?? null;
    },

    async create(data: {
      name: string;
      description?: string | null;
      scannerIds: string[];
      action: string;
      sensitivityThreshold?: number;
    }) {
      return insertReturning(db, policies, {
        ...data,
        sensitivityThreshold: data.sensitivityThreshold ?? 0.5,
      });
    },

    async update(id: string, data: Partial<{
      name: string;
      description: string | null;
      scannerIds: string[];
      action: string;
      sensitivityThreshold: number;
      isEnabled: boolean;
    }>) {
      return updateReturning(db, policies, eq(policies.id, id), {
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },

    async delete(id: string) {
      await db.delete(policies).where(eq(policies.id, id));
    },

    /** Get all enabled policies for detection flow */
    async getEnabled() {
      return db
        .select()
        .from(policies)
        .where(eq(policies.isEnabled, true));
    },
  };
}
