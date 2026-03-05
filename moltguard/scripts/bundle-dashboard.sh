#!/bin/bash
# Bundle Dashboard for MoltGuard
# This script creates a standalone dashboard bundle that can be included in moltguard

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOLTGUARD_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_DIR="$(dirname "$MOLTGUARD_DIR")/dashboard"
OUTPUT_DIR="$MOLTGUARD_DIR/dashboard-dist"

echo "==> Building Dashboard..."
cd "$DASHBOARD_DIR"
pnpm build

echo "==> Creating output directory..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/api" "$OUTPUT_DIR/web"

echo "==> Bundling API with esbuild..."
cd "$DASHBOARD_DIR/apps/api"

# Use ncc for better Node.js/ESM compatibility
pnpm exec ncc build ./dist/index.js \
  --out "$OUTPUT_DIR/api" \
  --target es2022 \
  --external better-sqlite3

echo "API bundled successfully"

echo "==> Copying database migrations..."
cp -r "$DASHBOARD_DIR/packages/db/drizzle" "$OUTPUT_DIR/api/drizzle"
echo "Migrations copied to $OUTPUT_DIR/api/drizzle"

echo "==> Creating API package.json..."
cat > "$OUTPUT_DIR/api/package.json" << 'EOF'
{
  "name": "@og/api-bundled",
  "version": "0.2.0",
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  }
}
EOF

echo "==> Copying Web assets..."
cp -r "$DASHBOARD_DIR/apps/web/out/"* "$OUTPUT_DIR/web/"

echo "==> Installing API dependencies..."
cd "$OUTPUT_DIR/api"
npm install --omit=dev 2>/dev/null || echo "Note: Run 'npm install' in dashboard-dist/api if needed"

echo "==> Done! Dashboard bundled to: $OUTPUT_DIR"
echo "    - API: $OUTPUT_DIR/api/index.js"
echo "    - Web: $OUTPUT_DIR/web/"
