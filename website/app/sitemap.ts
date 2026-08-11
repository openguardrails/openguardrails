import type { MetadataRoute } from "next";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-static";

const BASE = "https://openguardrails.com";

/** Walk app/ at build time and emit one sitemap entry per page route. */
function collectRoutes(dir: string, prefix: string): string[] {
  const routes: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && /^page\.(tsx|mdx)$/.test(e.name))) {
    routes.push(prefix === "" ? "/" : `${prefix}/`);
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name === "404") continue;
    routes.push(...collectRoutes(path.join(dir, e.name), `${prefix}/${e.name}`));
  }
  return routes;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const appDir = path.join(process.cwd(), "app");
  return collectRoutes(appDir, "")
    .sort()
    .map((route) => ({
      url: `${BASE}${route}`,
      changeFrequency: route === "/" ? "weekly" : "monthly",
      priority: route === "/" ? 1 : route.startsWith("/api/docs") ? 0.8 : 0.6,
    }));
}
