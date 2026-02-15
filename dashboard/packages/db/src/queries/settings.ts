import { eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { settings } from "../schema/index.js";

export function settingsQueries(db: Database) {
  return {
    async get(key: string): Promise<string | null> {
      const result = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
      return result[0]?.value ?? null;
    },

    async set(key: string, value: string) {
      const existing = await this.get(key);
      if (existing !== null) {
        await db.update(settings).set({ value, updatedAt: new Date().toISOString() }).where(eq(settings.key, key));
      } else {
        await db.insert(settings).values({ key, value });
      }
    },

    async getAll(): Promise<Record<string, string>> {
      const rows = await db.select().from(settings);
      const result: Record<string, string> = {};
      for (const row of rows) {
        result[row.key] = row.value;
      }
      return result;
    },

    async delete(key: string) {
      await db.delete(settings).where(eq(settings.key, key));
    },
  };
}
