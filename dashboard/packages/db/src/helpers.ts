import { eq } from "drizzle-orm";
import { getDialect } from "./dialect.js";

/**
 * Cross-dialect insert with returning.
 * PostgreSQL and SQLite support .returning(), MySQL does not.
 * All dialects generate UUID client-side for predictability.
 */
export async function insertReturning<T>(
  db: any,
  table: any,
  values: Record<string, unknown>
): Promise<T> {
  const dialect = getDialect();
  const id = crypto.randomUUID();
  const row = { ...values, id };

  if (dialect === "mysql") {
    await db.insert(table).values(row);
    const result = await db.select().from(table).where(eq(table.id, id)).limit(1);
    return result[0] as T;
  }

  const result = await db.insert(table).values(row).returning();
  return result[0] as T;
}

/**
 * Cross-dialect update with returning.
 */
export async function updateReturning<T>(
  db: any,
  table: any,
  where: any,
  values: Record<string, unknown>
): Promise<T | null> {
  const dialect = getDialect();

  if (dialect === "mysql") {
    await db.update(table).set(values).where(where);
    const result = await db.select().from(table).where(where).limit(1);
    return (result[0] as T) ?? null;
  }

  const result = await db.update(table).set(values).where(where).returning();
  return (result[0] as T) ?? null;
}
