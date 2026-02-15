import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/sqlite.ts",
  out: "./drizzle/sqlite",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL || "file:./data/openguardrails.db",
  },
});
