import { eq, and, desc, count, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { toolCallObservations, agentPermissions } from "../schema/index.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

// ─── Tool name → category / access pattern inference ────────────

const ACCESS_READ_PREFIXES = ["list", "get", "search", "read", "fetch", "find", "query", "check", "view"];
const ACCESS_WRITE_PREFIXES = ["create", "send", "write", "update", "edit", "post", "put", "add", "set"];
const ACCESS_ADMIN_PREFIXES = ["delete", "remove", "execute", "run", "admin", "destroy", "revoke", "drop"];

export function inferCategory(toolName: string): string {
  // "github_create_issue" → "github"
  // "slack_send_message" → "slack"
  // "read_file" → "filesystem"
  const lower = toolName.toLowerCase();

  if (lower.startsWith("read_file") || lower.startsWith("write_file") || lower.startsWith("list_dir")) {
    return "filesystem";
  }
  if (lower.startsWith("execute_command") || lower.startsWith("run_command") || lower === "bash") {
    return "shell";
  }

  const underscoreIdx = lower.indexOf("_");
  if (underscoreIdx > 0) {
    return lower.slice(0, underscoreIdx);
  }
  return lower;
}

export function inferAccessPattern(toolName: string): "read" | "write" | "admin" | "unknown" {
  const lower = toolName.toLowerCase();

  // Strip category prefix: "github_create_issue" → "create_issue"
  const underscoreIdx = lower.indexOf("_");
  const action = underscoreIdx > 0 ? lower.slice(underscoreIdx + 1) : lower;

  for (const prefix of ACCESS_ADMIN_PREFIXES) {
    if (action.startsWith(prefix)) return "admin";
  }
  for (const prefix of ACCESS_WRITE_PREFIXES) {
    if (action.startsWith(prefix)) return "write";
  }
  for (const prefix of ACCESS_READ_PREFIXES) {
    if (action.startsWith(prefix)) return "read";
  }
  return "unknown";
}

// ─── Query Functions ────────────────────────────────────────────

export function observationQueries(db: Database) {
  return {
    /**
     * Record a tool call observation.
     */
    async record(data: {
      agentId: string;
      sessionKey?: string;
      toolName: string;
      params?: Record<string, unknown>;
      phase: "before" | "after";
      result?: unknown;
      error?: string;
      durationMs?: number;
      blocked?: boolean;
      blockReason?: string;
      tenantId?: string;
    }) {
      const category = inferCategory(data.toolName);
      const accessPattern = inferAccessPattern(data.toolName);
      const tenantId = data.tenantId ?? DEFAULT_TENANT_ID;

      await db.insert(toolCallObservations).values({
        agentId: data.agentId,
        sessionKey: data.sessionKey ?? null,
        toolName: data.toolName,
        category,
        accessPattern,
        paramsJson: data.params ?? null,
        phase: data.phase,
        resultJson: data.result ?? null,
        error: data.error ?? null,
        durationMs: data.durationMs ?? null,
        blocked: data.blocked ?? false,
        blockReason: data.blockReason ?? null,
        tenantId,
      });

      // Upsert permission on "after" phase (or "before" if blocked)
      if (data.phase === "after" || data.blocked) {
        await this.upsertPermission({
          agentId: data.agentId,
          toolName: data.toolName,
          category,
          accessPattern,
          params: data.params,
          hasError: !!data.error,
          tenantId,
        });
      }
    },

    /**
     * Upsert an agent permission entry based on observed tool call.
     */
    async upsertPermission(data: {
      agentId: string;
      toolName: string;
      category: string;
      accessPattern: string;
      params?: Record<string, unknown>;
      hasError: boolean;
      tenantId: string;
    }) {
      const now = new Date().toISOString();

      // Check if permission already exists
      const existing = await db
        .select()
        .from(agentPermissions)
        .where(
          and(
            eq(agentPermissions.tenantId, data.tenantId),
            eq(agentPermissions.agentId, data.agentId),
            eq(agentPermissions.toolName, data.toolName),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        const perm = existing[0]!;
        const targets = (perm.targetsJson as string[]) || [];
        const newTargets = extractTargets(data.params);
        const mergedTargets = mergeTargets(targets, newTargets);

        await db
          .update(agentPermissions)
          .set({
            callCount: (perm.callCount ?? 0) + 1,
            errorCount: (perm.errorCount ?? 0) + (data.hasError ? 1 : 0),
            lastSeen: now,
            targetsJson: mergedTargets,
          })
          .where(eq(agentPermissions.id, perm.id));
      } else {
        const targets = extractTargets(data.params);
        await db.insert(agentPermissions).values({
          tenantId: data.tenantId,
          agentId: data.agentId,
          toolName: data.toolName,
          category: data.category,
          accessPattern: data.accessPattern,
          targetsJson: targets,
          callCount: 1,
          errorCount: data.hasError ? 1 : 0,
          firstSeen: now,
          lastSeen: now,
        });
      }
    },

    /**
     * Get recent observations, optionally filtered by agentId.
     */
    async findRecent(opts: {
      agentId?: string;
      limit?: number;
      tenantId?: string;
    } = {}) {
      const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
      const limit = opts.limit ?? 50;

      const conditions = [eq(toolCallObservations.tenantId, tenantId)];
      if (opts.agentId) {
        conditions.push(eq(toolCallObservations.agentId, opts.agentId));
      }

      return db
        .select()
        .from(toolCallObservations)
        .where(and(...conditions))
        .orderBy(desc(toolCallObservations.timestamp))
        .limit(limit);
    },

    /**
     * Get the aggregated permission profile for an agent.
     */
    async getPermissions(agentId: string, tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select()
        .from(agentPermissions)
        .where(
          and(
            eq(agentPermissions.tenantId, tenantId),
            eq(agentPermissions.agentId, agentId),
          ),
        )
        .orderBy(desc(agentPermissions.callCount));
    },

    /**
     * Get permissions for all agents (overview).
     */
    async getAllPermissions(tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select()
        .from(agentPermissions)
        .where(eq(agentPermissions.tenantId, tenantId))
        .orderBy(agentPermissions.agentId, desc(agentPermissions.callCount));
    },

    /**
     * Find first-seen tool calls (anomalies) — permissions with callCount = 1.
     */
    async findAnomalies(tenantId: string = DEFAULT_TENANT_ID, limit: number = 20) {
      return db
        .select()
        .from(agentPermissions)
        .where(
          and(
            eq(agentPermissions.tenantId, tenantId),
            eq(agentPermissions.callCount, 1),
          ),
        )
        .orderBy(desc(agentPermissions.firstSeen))
        .limit(limit);
    },

    /**
     * Get observation count summary per agent.
     */
    async summary(tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select({
          agentId: toolCallObservations.agentId,
          totalCalls: count(),
          blockedCalls: sql<number>`sum(case when ${toolCallObservations.blocked} = true then 1 else 0 end)`,
          uniqueTools: sql<number>`count(distinct ${toolCallObservations.toolName})`,
        })
        .from(toolCallObservations)
        .where(eq(toolCallObservations.tenantId, tenantId))
        .groupBy(toolCallObservations.agentId);
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/** Extract likely target identifiers from tool call params. */
function extractTargets(params?: Record<string, unknown>): string[] {
  if (!params) return [];
  const targets: string[] = [];

  const targetKeys = ["repo", "repository", "channel", "to", "email", "path", "file", "url", "owner", "user", "org"];
  for (const key of targetKeys) {
    const val = params[key];
    if (typeof val === "string" && val.length > 0 && val.length < 200) {
      targets.push(val);
    }
  }
  return targets;
}

/** Merge new targets into existing list, capped at 50 entries. */
function mergeTargets(existing: string[], incoming: string[]): string[] {
  const set = new Set(existing);
  for (const t of incoming) {
    set.add(t);
  }
  const merged = [...set];
  return merged.length > 50 ? merged.slice(-50) : merged;
}
