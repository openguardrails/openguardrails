import { eq, gte, lte, sql, count, and } from "drizzle-orm";
import type { Database } from "../client.js";
import { usageLogs } from "../schema/index.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function usageQueries(db: Database) {
  return {
    async log(data: {
      agentId?: string | null;
      endpoint: string;
      statusCode: number;
      responseSafe: boolean | null;
      categories?: string[];
      latencyMs: number;
      requestId: string;
      tenantId?: string;
    }) {
      await db.insert(usageLogs).values({
        ...data,
        categories: data.categories ?? [],
        tenantId: data.tenantId ?? DEFAULT_TENANT_ID,
      });
    },

    async countInPeriod(start: Date | string, end: Date | string, tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db
        .select({ count: count() })
        .from(usageLogs)
        .where(and(gte(usageLogs.createdAt, start), lte(usageLogs.createdAt, end), eq(usageLogs.tenantId, tenantId)));
      return result[0]?.count ?? 0;
    },

    async summary(start: Date | string, end: Date | string, tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db
        .select({
          totalCalls: count(),
          safeCount: sql<number>`sum(case when ${usageLogs.responseSafe} = true then 1 else 0 end)`,
          unsafeCount: sql<number>`sum(case when ${usageLogs.responseSafe} = false then 1 else 0 end)`,
        })
        .from(usageLogs)
        .where(and(gte(usageLogs.createdAt, start), lte(usageLogs.createdAt, end), eq(usageLogs.tenantId, tenantId)));
      return result[0] ?? { totalCalls: 0, safeCount: 0, unsafeCount: 0 };
    },

    async daily(start: Date | string, end: Date | string, tenantId: string = DEFAULT_TENANT_ID) {
      const result = await db
        .select({
          date: sql<string>`date(${usageLogs.createdAt})`,
          count: count(),
          safeCount: sql<number>`sum(case when ${usageLogs.responseSafe} = true then 1 else 0 end)`,
          unsafeCount: sql<number>`sum(case when ${usageLogs.responseSafe} = false then 1 else 0 end)`,
        })
        .from(usageLogs)
        .where(and(gte(usageLogs.createdAt, start), lte(usageLogs.createdAt, end), eq(usageLogs.tenantId, tenantId)))
        .groupBy(sql`date(${usageLogs.createdAt})`)
        .orderBy(sql`date(${usageLogs.createdAt})`);
      return result;
    },

    async countRecent(minutes: number = 1, tenantId: string = DEFAULT_TENANT_ID) {
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const result = await db
        .select({ count: count() })
        .from(usageLogs)
        .where(and(gte(usageLogs.createdAt, since), eq(usageLogs.tenantId, tenantId)));
      return result[0]?.count ?? 0;
    },
  };
}
