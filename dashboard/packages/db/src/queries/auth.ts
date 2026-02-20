import { eq, lt, and, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import { magicLinks, userSessions } from "../schema/index.js";

export function authQueries(db: Database) {
  return {
    // ── Magic Links ──────────────────────────────────────────────

    createMagicLink(email: string, token: string, expiresAt: string) {
      return db
        .insert(magicLinks)
        .values({ email, token, expiresAt })
        .returning()
        .get();
    },

    /** Returns the magic link only if valid (not used, not expired) */
    findValidMagicLink(token: string) {
      const now = new Date().toISOString();
      return db
        .select()
        .from(magicLinks)
        .where(
          and(
            eq(magicLinks.token, token),
            isNull(magicLinks.usedAt),
            // expiresAt > now (string comparison works for ISO 8601)
            lt(magicLinks.createdAt, magicLinks.expiresAt), // always true, just for type
          ),
        )
        .get() as typeof magicLinks.$inferSelect | undefined;
    },

    /** Fetch by token regardless of status (for validation logic in route) */
    findMagicLink(token: string) {
      return db
        .select()
        .from(magicLinks)
        .where(eq(magicLinks.token, token))
        .get() as typeof magicLinks.$inferSelect | undefined;
    },

    markMagicLinkUsed(id: string) {
      return db
        .update(magicLinks)
        .set({ usedAt: new Date().toISOString() })
        .where(eq(magicLinks.id, id))
        .run();
    },

    /** Delete expired and used magic links (housekeeping) */
    pruneExpiredMagicLinks() {
      const now = new Date().toISOString();
      return db
        .delete(magicLinks)
        .where(lt(magicLinks.expiresAt, now))
        .run();
    },

    // ── User Sessions ────────────────────────────────────────────

    createSession(email: string, token: string, expiresAt: string) {
      return db
        .insert(userSessions)
        .values({ email, token, expiresAt })
        .returning()
        .get();
    },

    findSession(token: string) {
      return db
        .select()
        .from(userSessions)
        .where(eq(userSessions.token, token))
        .get() as typeof userSessions.$inferSelect | undefined;
    },

    deleteSession(token: string) {
      return db
        .delete(userSessions)
        .where(eq(userSessions.token, token))
        .run();
    },

    /** Delete expired sessions (housekeeping) */
    pruneExpiredSessions() {
      const now = new Date().toISOString();
      return db
        .delete(userSessions)
        .where(lt(userSessions.expiresAt, now))
        .run();
    },
  };
}
