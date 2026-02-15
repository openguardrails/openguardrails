import { eq, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { detectionResults } from "../schema/index.js";

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
    }) {
      await db.insert(detectionResults).values(data);
    },

    async findAll(options?: { limit?: number; offset?: number }) {
      let query = db
        .select()
        .from(detectionResults)
        .orderBy(desc(detectionResults.createdAt));

      if (options?.limit) {
        query = query.limit(options.limit) as typeof query;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as typeof query;
      }
      return query;
    },

    async findByAgentId(agentId: string, options?: { limit?: number; offset?: number }) {
      let query = db
        .select()
        .from(detectionResults)
        .where(eq(detectionResults.agentId, agentId))
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
