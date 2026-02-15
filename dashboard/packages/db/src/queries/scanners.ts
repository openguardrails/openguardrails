import { eq, and } from "drizzle-orm";
import type { Database } from "../client.js";
import { scannerDefinitions } from "../schema/index.js";
import { insertReturning } from "../helpers.js";

export function scannerQueries(db: Database) {
  return {
    /** Get all scanners (defaults + overrides) */
    async getAll() {
      return db
        .select()
        .from(scannerDefinitions)
        .orderBy(scannerDefinitions.scannerId);
    },

    /** Get all system default scanners */
    async getDefaults() {
      return db
        .select()
        .from(scannerDefinitions)
        .where(eq(scannerDefinitions.isDefault, true))
        .orderBy(scannerDefinitions.scannerId);
    },

    /** Get enabled scanners for detection */
    async getEnabled() {
      return db
        .select()
        .from(scannerDefinitions)
        .where(eq(scannerDefinitions.isEnabled, true))
        .orderBy(scannerDefinitions.scannerId);
    },

    /** Upsert a scanner override */
    async upsert(data: {
      scannerId: string;
      name: string;
      description: string;
      isEnabled: boolean;
    }) {
      // Delete existing non-default with same scannerId
      await db
        .delete(scannerDefinitions)
        .where(
          and(
            eq(scannerDefinitions.scannerId, data.scannerId),
            eq(scannerDefinitions.isDefault, false)
          )
        );
      return insertReturning(db, scannerDefinitions, {
        ...data,
        isDefault: false,
      });
    },

    /** Create a system default scanner */
    async createDefault(data: { scannerId: string; name: string; description: string }) {
      return insertReturning(db, scannerDefinitions, {
        ...data,
        isDefault: true,
      });
    },
  };
}
