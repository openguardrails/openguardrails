import { eq, and, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { detectionResults } from "../schema/index.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function detectionResultQueries(db: Database) {
  return {
    async create(data: {
      agentId?: string | null;
      safe: boolean;
      categories: string[];
      sensitivityScore: number;
      findings: unknown[];
      latencyMs: number;
      requestId: string;
      tenantId?: string;
    }) {
      await db.insert(detectionResults).values({
        ...data,
        tenantId: data.tenantId ?? DEFAULT_TENANT_ID,
      });
    },

    async findAll(options?: { limit?: number; offset?: number; tenantId?: string }) {
      const tenantId = options?.tenantId ?? DEFAULT_TENANT_ID;
      let query = db
        .select()
        .from(detectionResults)
        .where(eq(detectionResults.tenantId, tenantId))
        .orderBy(desc(detectionResults.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }
      return query;
    },

    async findByAgentId(agentId: string, options?: { limit?: number; offset?: number; tenantId?: string }) {
      const tenantId = options?.tenantId ?? DEFAULT_TENANT_ID;
      let query = db
        .select()
        .from(detectionResults)
        .where(and(eq(detectionResults.agentId, agentId), eq(detectionResults.tenantId, tenantId)))
        .orderBy(desc(detectionResults.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }
      return query;
    },
  };
}
