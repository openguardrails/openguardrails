#!/bin/bash
set -euo pipefail

# Build script for the openguardrails CLI npm package.
# Compiles the CLI, bundles the dashboard API (inlining workspace deps),
# copies the web frontend, migrations, and gateway.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$CLI_DIR")"

echo "=== Building openguardrails CLI package ==="
echo ""

# ─── 1. Build dashboard monorepo ──────────────────────────────────
echo "[1/6] Building dashboard monorepo..."
cd "$REPO_ROOT/dashboard"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
echo "  Dashboard monorepo built."

# ─── 2. Build web frontend ───────────────────────────────────────
echo "[2/6] Building web frontend..."
cd "$REPO_ROOT/dashboard/apps/web"
npx vite build
echo "  Web frontend built."

# ─── 3. Build gateway ────────────────────────────────────────────
echo "[3/6] Building gateway..."
cd "$REPO_ROOT/gateway"
npm install
npm run build
echo "  Gateway built."

# ─── 4. Compile CLI TypeScript ────────────────────────────────────
echo "[4/6] Compiling CLI..."
cd "$CLI_DIR"
npx tsc
echo "  CLI compiled."

# ─── 5. Bundle dashboard API with esbuild ─────────────────────────
# Inlines @og/shared and @og/db workspace deps, keeps npm packages external
echo "[5/6] Bundling dashboard API..."
mkdir -p "$CLI_DIR/bundled/dashboard/api"

npx esbuild "$REPO_ROOT/dashboard/apps/api/dist/index.js" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile="$CLI_DIR/bundled/dashboard/api/index.js" \
  --alias:@og/shared="$REPO_ROOT/dashboard/packages/shared/dist/index.js" \
  --alias:@og/db="$REPO_ROOT/dashboard/packages/db/dist/index.js" \
  --external:express \
  --external:cors \
  --external:helmet \
  --external:morgan \
  --external:express-rate-limit \
  --external:better-sqlite3 \
  --external:drizzle-orm \
  --external:drizzle-orm/better-sqlite3 \
  --external:drizzle-orm/better-sqlite3/migrator \
  --external:drizzle-orm/mysql2 \
  --external:drizzle-orm/mysql2/migrator \
  --external:drizzle-orm/postgres-js \
  --external:drizzle-orm/postgres-js/migrator \
  --external:nodemailer \
  --external:mysql2 \
  --external:mysql2/promise \
  --external:postgres

echo "  Dashboard API bundled."

# ─── 6. Assemble bundled assets ───────────────────────────────────
echo "[6/6] Assembling bundled assets..."

# Web frontend (Vite build output)
mkdir -p "$CLI_DIR/bundled/dashboard/web"
if [ -d "$REPO_ROOT/dashboard/apps/web/dist" ]; then
  cp -r "$REPO_ROOT/dashboard/apps/web/dist/"* "$CLI_DIR/bundled/dashboard/web/"
  echo "  Copied web frontend."
fi

# Drizzle migration SQL files
mkdir -p "$CLI_DIR/bundled/dashboard/drizzle"
if [ -d "$REPO_ROOT/dashboard/packages/db/drizzle" ]; then
  cp -r "$REPO_ROOT/dashboard/packages/db/drizzle/"* "$CLI_DIR/bundled/dashboard/drizzle/"
  echo "  Copied migration files."
fi

# Gateway
mkdir -p "$CLI_DIR/bundled/gateway"
cp -r "$REPO_ROOT/gateway/dist/"* "$CLI_DIR/bundled/gateway/"
echo "  Copied gateway."

echo ""
echo "=== Build complete ==="
echo "  CLI:       $CLI_DIR/dist/"
echo "  Bundled:   $CLI_DIR/bundled/"
echo ""
echo "To test locally: node $CLI_DIR/dist/index.js --help"
echo "To publish:      cd $CLI_DIR && npm publish"
