import { eq, and } from "drizzle-orm";
import type { Database } from "../client.js";
import { scannerDefinitions } from "../schema/index.js";
import { insertReturning } from "../helpers.js";
import { DEFAULT_TENANT_ID } from "@og/shared";

export function scannerQueries(db: Database) {
  return {
    /** Get all scanners (defaults + overrides) */
    async getAll(tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select()
        .from(scannerDefinitions)
        .where(eq(scannerDefinitions.tenantId, tenantId))
        .orderBy(scannerDefinitions.scannerId);
    },

    /** Get all system default scanners */
    async getDefaults(tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select()
        .from(scannerDefinitions)
        .where(and(eq(scannerDefinitions.isDefault, true), eq(scannerDefinitions.tenantId, tenantId)))
        .orderBy(scannerDefinitions.scannerId);
    },

    /** Get enabled scanners for detection */
    async getEnabled(tenantId: string = DEFAULT_TENANT_ID) {
      return db
        .select()
        .from(scannerDefinitions)
        .where(and(eq(scannerDefinitions.isEnabled, true), eq(scannerDefinitions.tenantId, tenantId)))
        .orderBy(scannerDefinitions.scannerId);
    },

    /** Upsert a scanner override */
    async upsert(data: {
      scannerId: string;
      name: string;
      description: string;
      isEnabled: boolean;
      tenantId?: string;
    }) {
      const tid = data.tenantId ?? DEFAULT_TENANT_ID;
      // Delete existing non-default with same scannerId for this tenant
      await db
        .delete(scannerDefinitions)
        .where(
          and(
            eq(scannerDefinitions.scannerId, data.scannerId),
            eq(scannerDefinitions.isDefault, false),
            eq(scannerDefinitions.tenantId, tid)
          )
        );
      return insertReturning(db, scannerDefinitions, {
        scannerId: data.scannerId,
        name: data.name,
        description: data.description,
        isEnabled: data.isEnabled,
        isDefault: false,
        tenantId: tid,
      });
    },

    /** Create a system default scanner */
    async createDefault(data: { scannerId: string; name: string; description: string; tenantId?: string }) {
      return insertReturning(db, scannerDefinitions, {
        ...data,
        isDefault: true,
        tenantId: data.tenantId ?? DEFAULT_TENANT_ID,
      });
    },
  };
}
