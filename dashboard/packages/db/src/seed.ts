import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: resolve(__dirname, "../../../.env") });

async function seed() {
  const { db } = await import("./client.js");
  const { scannerDefinitions } = await import("./schema/index.js");
  const { DEFAULT_SCANNERS, DEFAULT_TENANT_ID } = await import("@og/shared");
  const { getDialect } = await import("./dialect.js");
  const { eq } = await import("drizzle-orm");

  console.log(`Seeding default scanners (dialect: ${getDialect()})...`);

  for (const scanner of DEFAULT_SCANNERS) {
    const id = crypto.randomUUID();
    const values = {
      id,
      scannerId: scanner.scannerId,
      name: scanner.name,
      description: scanner.description,
      isEnabled: true,
      isDefault: true,
      tenantId: DEFAULT_TENANT_ID,
    };

    try {
      const existing = await db
        .select()
        .from(scannerDefinitions)
        .where(eq(scannerDefinitions.scannerId, scanner.scannerId))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(scannerDefinitions).values(values);
        console.log(`  Seeded ${scanner.scannerId}: ${scanner.name}`);
      } else {
        console.log(`  Skipped ${scanner.scannerId}: already exists`);
      }
    } catch (err) {
      console.warn(`  Warning: ${scanner.scannerId} seed failed:`, err);
    }
  }

  console.log("Seeding complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
