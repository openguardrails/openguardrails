import { eq, and, desc, sql, count } from "drizzle-orm";
import type { Database } from "../client.js";
import { gatewayActivity } from "../schema/index.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function gatewayActivityQueries(db: Database) {
  return {
    async create(data: {
      eventId: string;
      requestId: string;
      timestamp: string;
      type: string;
      direction: string;
      backend: string;
      endpoint: string;
      model?: string | null;
      redactionCount?: number;
      categories?: Record<string, number>;
      durationMs?: number | null;
      tenantId?: string;
    }) {
      await db.insert(gatewayActivity).values({
        ...data,
        tenantId: data.tenantId ?? DEFAULT_TENANT_ID,
        redactionCount: data.redactionCount ?? 0,
        categories: data.categories ?? {},
      });
    },

    async findRecent(options: {
      tenantId: string;
      limit?: number;
      type?: "sanitize" | "restore";
    }) {
      const conditions = [eq(gatewayActivity.tenantId, options.tenantId)];
      if (options.type) {
        conditions.push(eq(gatewayActivity.type, options.type));
      }

      return db
        .select()
        .from(gatewayActivity)
        .where(and(...conditions))
        .orderBy(desc(gatewayActivity.timestamp))
        .limit(options.limit ?? 100);
    },

    async stats(tenantId: string) {
      // Get all events for aggregation
      const events = await db
        .select()
        .from(gatewayActivity)
        .where(eq(gatewayActivity.tenantId, tenantId))
        .orderBy(desc(gatewayActivity.timestamp))
        .limit(1000);

      // Calculate stats
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let sanitizeCount = 0;
      let restoreCount = 0;
      let totalRedactions = 0;
      let sanitizeLast24h = 0;
      let restoreLast24h = 0;
      let redactionsLast24h = 0;
      const categoryTotals: Record<string, number> = {};
      const backendCounts: Record<string, number> = {};

      for (const event of events) {
        const isRecent = event.timestamp >= cutoff;

        if (event.type === "sanitize") {
          sanitizeCount++;
          totalRedactions += event.redactionCount;
          if (isRecent) {
            sanitizeLast24h++;
            redactionsLast24h += event.redactionCount;
          }

          // Aggregate categories
          const cats = event.categories as Record<string, number>;
          if (cats) {
            for (const [cat, cnt] of Object.entries(cats)) {
              categoryTotals[cat] = (categoryTotals[cat] || 0) + cnt;
            }
          }
        } else {
          restoreCount++;
          if (isRecent) {
            restoreLast24h++;
          }
        }

        // Count by backend
        backendCounts[event.backend] = (backendCounts[event.backend] || 0) + 1;
      }

      return {
        last24Hours: {
          sanitizeCount: sanitizeLast24h,
          restoreCount: restoreLast24h,
          totalRedactions: redactionsLast24h,
        },
        allTime: {
          sanitizeCount,
          restoreCount,
          totalRedactions,
          categories: categoryTotals,
          backends: backendCounts,
        },
      };
    },
  };
}
