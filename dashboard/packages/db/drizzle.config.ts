// Legacy config - use dialect-specific configs instead:
//   drizzle.config.sqlite.ts
//   drizzle.config.mysql.ts
//   drizzle.config.pg.ts

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/pg.ts",
  out: "./drizzle/postgresql",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
