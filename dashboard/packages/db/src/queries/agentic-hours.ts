import { eq, and, gte, lte, sql, desc } from "drizzle-orm";
import type { Database } from "../client.js";
import { agenticHoursLocal } from "../schema/index.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function agenticHoursQueries(db: Database) {
  return {
    /** Accumulate hours for a specific agent on a specific date */
    async accumulate(data: {
      agentId: string;
      date: string; // YYYY-MM-DD
      toolCallDurationMs?: number;
      llmDurationMs?: number;
      totalDurationMs?: number;
      toolCallCount?: number;
      llmCallCount?: number;
      sessionCount?: number;
      blockCount?: number;
      riskEventCount?: number;
      tenantId?: string;
    }): Promise<void> {
      const tenantId = data.tenantId ?? DEFAULT_TENANT_ID;
      const now = new Date().toISOString();

      // Try to find existing row
      const existing = await db
        .select()
        .from(agenticHoursLocal)
        .where(and(
          eq(agenticHoursLocal.tenantId, tenantId),
          eq(agenticHoursLocal.agentId, data.agentId),
          eq(agenticHoursLocal.date, data.date),
        ))
        .get();

      if (existing) {
        await db.update(agenticHoursLocal)
          .set({
            toolCallDurationMs: existing.toolCallDurationMs + (data.toolCallDurationMs ?? 0),
            llmDurationMs: existing.llmDurationMs + (data.llmDurationMs ?? 0),
            totalDurationMs: existing.totalDurationMs + (data.totalDurationMs ?? 0),
            toolCallCount: existing.toolCallCount + (data.toolCallCount ?? 0),
            llmCallCount: existing.llmCallCount + (data.llmCallCount ?? 0),
            sessionCount: existing.sessionCount + (data.sessionCount ?? 0),
            blockCount: existing.blockCount + (data.blockCount ?? 0),
            riskEventCount: existing.riskEventCount + (data.riskEventCount ?? 0),
            updatedAt: now,
          })
          .where(eq(agenticHoursLocal.id, existing.id));
      } else {
        await db.insert(agenticHoursLocal).values({
          tenantId,
          agentId: data.agentId,
          date: data.date,
          toolCallDurationMs: data.toolCallDurationMs ?? 0,
          llmDurationMs: data.llmDurationMs ?? 0,
          totalDurationMs: data.totalDurationMs ?? 0,
          toolCallCount: data.toolCallCount ?? 0,
          llmCallCount: data.llmCallCount ?? 0,
          sessionCount: data.sessionCount ?? 0,
          blockCount: data.blockCount ?? 0,
          riskEventCount: data.riskEventCount ?? 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    },

    /** Get today's summary across all agents */
    async todaySummary(tenantId: string = DEFAULT_TENANT_ID): Promise<{
      totalDurationMs: number;
      toolCallDurationMs: number;
      llmDurationMs: number;
      toolCallCount: number;
      llmCallCount: number;
      sessionCount: number;
      blockCount: number;
      riskEventCount: number;
    }> {
      const today = new Date().toISOString().slice(0, 10);
      const result = await db
        .select({
          totalDurationMs: sql<number>`COALESCE(SUM(${agenticHoursLocal.totalDurationMs}), 0)`,
          toolCallDurationMs: sql<number>`COALESCE(SUM(${agenticHoursLocal.toolCallDurationMs}), 0)`,
          llmDurationMs: sql<number>`COALESCE(SUM(${agenticHoursLocal.llmDurationMs}), 0)`,
          toolCallCount: sql<number>`COALESCE(SUM(${agenticHoursLocal.toolCallCount}), 0)`,
          llmCallCount: sql<number>`COALESCE(SUM(${agenticHoursLocal.llmCallCount}), 0)`,
          sessionCount: sql<number>`COALESCE(SUM(${agenticHoursLocal.sessionCount}), 0)`,
          blockCount: sql<number>`COALESCE(SUM(${agenticHoursLocal.blockCount}), 0)`,
          riskEventCount: sql<number>`COALESCE(SUM(${agenticHoursLocal.riskEventCount}), 0)`,
        })
        .from(agenticHoursLocal)
        .where(and(
          eq(agenticHoursLocal.tenantId, tenantId),
          eq(agenticHoursLocal.date, today),
        ));

      const r = result[0];
      return {
        totalDurationMs: Number(r?.totalDurationMs ?? 0),
        toolCallDurationMs: Number(r?.toolCallDurationMs ?? 0),
        llmDurationMs: Number(r?.llmDurationMs ?? 0),
        toolCallCount: Number(r?.toolCallCount ?? 0),
        llmCallCount: Number(r?.llmCallCount ?? 0),
        sessionCount: Number(r?.sessionCount ?? 0),
        blockCount: Number(r?.blockCount ?? 0),
        riskEventCount: Number(r?.riskEventCount ?? 0),
      };
    },

    /** Get daily breakdown for a date range */
    async daily(
      start: string,
      end: string,
      tenantId: string = DEFAULT_TENANT_ID,
    ): Promise<Array<{
      date: string;
      totalDurationMs: number;
      toolCallCount: number;
      llmCallCount: number;
      sessionCount: number;
    }>> {
      const rows = await db
        .select({
          date: agenticHoursLocal.date,
          totalDurationMs: sql<number>`SUM(${agenticHoursLocal.totalDurationMs})`,
          toolCallCount: sql<number>`SUM(${agenticHoursLocal.toolCallCount})`,
          llmCallCount: sql<number>`SUM(${agenticHoursLocal.llmCallCount})`,
          sessionCount: sql<number>`SUM(${agenticHoursLocal.sessionCount})`,
        })
        .from(agenticHoursLocal)
        .where(and(
          eq(agenticHoursLocal.tenantId, tenantId),
          gte(agenticHoursLocal.date, start),
          lte(agenticHoursLocal.date, end),
        ))
        .groupBy(agenticHoursLocal.date)
        .orderBy(agenticHoursLocal.date);

      return rows.map((r: typeof rows[number]) => ({
        date: r.date,
        totalDurationMs: Number(r.totalDurationMs ?? 0),
        toolCallCount: Number(r.toolCallCount ?? 0),
        llmCallCount: Number(r.llmCallCount ?? 0),
        sessionCount: Number(r.sessionCount ?? 0),
      }));
    },

    /** Get per-agent breakdown for a date range */
    async byAgent(
      start: string,
      end: string,
      tenantId: string = DEFAULT_TENANT_ID,
    ): Promise<Array<{
      agentId: string;
      totalDurationMs: number;
      toolCallDurationMs: number;
      llmDurationMs: number;
      toolCallCount: number;
      llmCallCount: number;
      sessionCount: number;
      blockCount: number;
      riskEventCount: number;
    }>> {
      const rows = await db
        .select({
          agentId: agenticHoursLocal.agentId,
          totalDurationMs: sql<number>`SUM(${agenticHoursLocal.totalDurationMs})`,
          toolCallDurationMs: sql<number>`SUM(${agenticHoursLocal.toolCallDurationMs})`,
          llmDurationMs: sql<number>`SUM(${agenticHoursLocal.llmDurationMs})`,
          toolCallCount: sql<number>`SUM(${agenticHoursLocal.toolCallCount})`,
          llmCallCount: sql<number>`SUM(${agenticHoursLocal.llmCallCount})`,
          sessionCount: sql<number>`SUM(${agenticHoursLocal.sessionCount})`,
          blockCount: sql<number>`SUM(${agenticHoursLocal.blockCount})`,
          riskEventCount: sql<number>`SUM(${agenticHoursLocal.riskEventCount})`,
        })
        .from(agenticHoursLocal)
        .where(and(
          eq(agenticHoursLocal.tenantId, tenantId),
          gte(agenticHoursLocal.date, start),
          lte(agenticHoursLocal.date, end),
        ))
        .groupBy(agenticHoursLocal.agentId)
        .orderBy(desc(sql`SUM(${agenticHoursLocal.totalDurationMs})`));

      return rows.map((r: typeof rows[number]) => ({
        agentId: r.agentId,
        totalDurationMs: Number(r.totalDurationMs ?? 0),
        toolCallDurationMs: Number(r.toolCallDurationMs ?? 0),
        llmDurationMs: Number(r.llmDurationMs ?? 0),
        toolCallCount: Number(r.toolCallCount ?? 0),
        llmCallCount: Number(r.llmCallCount ?? 0),
        sessionCount: Number(r.sessionCount ?? 0),
        blockCount: Number(r.blockCount ?? 0),
        riskEventCount: Number(r.riskEventCount ?? 0),
      }));
    },
  };
}
