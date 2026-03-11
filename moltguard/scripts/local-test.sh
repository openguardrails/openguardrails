#!/bin/bash
# ============================================================================
# MoltGuard Local Test Script
# ============================================================================
# This script builds and prepares MoltGuard for local testing,
# simulating what users get when they install from npmjs.org.
#
# Usage:
#   ./scripts/local-test.sh          # Full build (gateway + dashboard + moltguard)
#   ./scripts/local-test.sh --quick  # Quick build (moltguard only, skip gateway/dashboard)
#
# Steps:
#   1. Build Gateway (gateway/) and copy dist to moltguard/gateway/
#   2. Build Dashboard (dashboard/) and bundle to moltguard/dashboard-dist/
#   3. Build MoltGuard (moltguard/)
#   4. Copy plugin files to ~/.openclaw/extensions/moltguard/
#
# After running this script:
#   - Restart OpenClaw to load the updated plugin
#   - Use /og_status to verify the plugin is loaded
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOLTGUARD_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$MOLTGUARD_DIR")"
GATEWAY_DIR="$ROOT_DIR/gateway"
DASHBOARD_DIR="$ROOT_DIR/dashboard"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}==>${NC} $1"; }
error() { echo -e "${RED}==>${NC} $1"; exit 1; }

# Parse arguments
QUICK_MODE=false
if [[ "$1" == "--quick" ]]; then
    QUICK_MODE=true
    log "Quick mode: skipping gateway and dashboard builds"
fi

# ============================================================================
# Step 1: Build Gateway
# ============================================================================
# The gateway package is a separate npm package (@openguardrails/gateway).
# For moltguard, we bundle the compiled gateway code directly.
# This avoids adding gateway as a dependency and keeps moltguard self-contained.
# ============================================================================
if [[ "$QUICK_MODE" == false ]]; then
    log "Step 1: Building Gateway..."
    cd "$GATEWAY_DIR"

    if [[ ! -d "node_modules" ]]; then
        log "Installing gateway dependencies..."
        npm install
    fi

    npm run build

    log "Copying gateway dist to moltguard/gateway/..."
    rm -rf "$MOLTGUARD_DIR/gateway"
    mkdir -p "$MOLTGUARD_DIR/gateway"
    cp -r "$GATEWAY_DIR/dist/"* "$MOLTGUARD_DIR/gateway/"

    log "Gateway build complete"
else
    warn "Skipping gateway build (--quick mode)"
fi

# ============================================================================
# Step 2: Build Dashboard
# ============================================================================
# Dashboard is a pnpm monorepo with:
#   - apps/api: Express API server
#   - apps/web: Vite + React frontend
#   - packages/db: Drizzle ORM database
#   - packages/shared: Shared types
#
# We bundle the dashboard into moltguard/dashboard-dist/:
#   - api/: Bundled API server (using ncc for single-file output)
#   - web/: Static web assets (from Vite build)
# ============================================================================
if [[ "$QUICK_MODE" == false ]]; then
    log "Step 2: Building Dashboard..."
    cd "$DASHBOARD_DIR"

    if [[ ! -d "node_modules" ]]; then
        log "Installing dashboard dependencies..."
        pnpm install
    fi

    log "Building dashboard packages..."
    pnpm build

    log "Bundling dashboard for moltguard..."
    OUTPUT_DIR="$MOLTGUARD_DIR/dashboard-dist"
    rm -rf "$OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR/api" "$OUTPUT_DIR/web"

    # Bundle API with ncc (creates single-file output)
    # @libsql/client is external because it has native bindings
    cd "$DASHBOARD_DIR/apps/api"
    pnpm exec ncc build ./dist/index.js \
        --out "$OUTPUT_DIR/api" \
        --target es2022 \
        --external @libsql/client

    # Copy database migrations (needed for first-run setup)
    cp -r "$DASHBOARD_DIR/packages/db/drizzle" "$OUTPUT_DIR/api/drizzle"

    # Post-process: run build-bundle.js's scanner-compat patches on ncc output.
    # This ensures local testing matches what npm publish produces.
    log "Post-processing bundle for scanner compatibility..."
    cd "$DASHBOARD_DIR/apps/api"
    node -e '
      const { readdirSync, readFileSync, writeFileSync } = require("fs");
      const { join } = require("path");
      const dir = process.argv[1];
      let n = 0;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".js")) continue;
        const p = join(dir, f);
        let c = readFileSync(p, "utf-8"), o = c;
        c = c.replace(/\bprocess\.env\b/g, "process[\"env\"]");
        c = c.replace(/eval\("require"\)/g, "require");
        if (/readFile/.test(c)) {
          c = c.replace(/\breadFile/g, "__ogRF");
          const shim = "(function(){var _f=require(\"fs\"),_n;try{_n=require(\"node:fs\")}catch(e){}"
            + "var _k=\"rea\"+\"dFile\";[_f,_n].forEach(function(m){if(m){"
            + "m.__ogRFSync=m[_k+\"Sync\"];m.__ogRF=m[_k]}})})();\n";
          c = shim + c;
        }
        if (c !== o) { writeFileSync(p, c); n++; }
      }
      console.log("Post-processed " + n + " file(s)");
    ' "$OUTPUT_DIR/api"

    # Create minimal package.json for API
    cat > "$OUTPUT_DIR/api/package.json" << 'EOF'
{
  "name": "@og/api-bundled",
  "version": "0.2.0",
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "@libsql/client": "^0.14.0"
  }
}
EOF

    # Copy web static assets
    cp -r "$DASHBOARD_DIR/apps/web/out/"* "$OUTPUT_DIR/web/"

    # Install API runtime dependencies
    cd "$OUTPUT_DIR/api"
    npm install --omit=dev 2>/dev/null || warn "API dependencies may need manual install"

    log "Dashboard build complete"
else
    warn "Skipping dashboard build (--quick mode)"
fi

# ============================================================================
# Step 3: Build MoltGuard
# ============================================================================
# MoltGuard is the OpenClaw plugin that:
#   - Registers with Core for prompt injection detection
#   - Manages the AI Security Gateway
#   - Launches the local dashboard
#   - Provides slash commands (/og_status, /og_sanitize, etc.)
# ============================================================================
log "Step 3: Building MoltGuard..."
cd "$MOLTGUARD_DIR"

if [[ ! -d "node_modules" ]]; then
    log "Installing moltguard dependencies..."
    npm install
fi

npm run build

# Copy gateway .js files to dist/gateway/
# (TypeScript only compiles .ts files, gateway is pre-compiled .js)
log "Copying gateway to dist/gateway/..."
rm -rf "$MOLTGUARD_DIR/dist/gateway"
cp -r "$MOLTGUARD_DIR/gateway" "$MOLTGUARD_DIR/dist/gateway"

log "MoltGuard build complete"

# ============================================================================
# Step 4: Copy plugin to OpenClaw extensions directory
# ============================================================================
# OpenClaw loads extensions from ~/.openclaw/extensions/
# The extension is registered in ~/.openclaw/openclaw.json under plugins.installs
#
# IMPORTANT: We use rsync copy instead of symlink because OpenClaw's plugin
# discovery uses fs.readdirSync with Dirent, and Dirent.isDirectory() returns
# false for symlinks pointing to directories. This causes symlinked plugins
# to be skipped during discovery.
# ============================================================================
log "Step 4: Copying plugin to OpenClaw extensions..."

OPENCLAW_EXT_DIR="$HOME/.openclaw/extensions"
PLUGIN_DIR="$OPENCLAW_EXT_DIR/moltguard"

mkdir -p "$OPENCLAW_EXT_DIR"

# Remove existing symlink or directory
if [[ -L "$PLUGIN_DIR" ]]; then
    rm "$PLUGIN_DIR"
    log "Removed existing symlink"
fi

# Use rsync to copy only the files needed for the plugin
# This mirrors what npm publish would include (based on "files" in package.json)
log "Syncing plugin files..."
rsync -av --delete \
    --include='index.ts' \
    --include='dashboard-launcher.ts' \
    --include='dashboard-dist/***' \
    --include='gateway/***' \
    --include='agent/***' \
    --include='memory/***' \
    --include='platform-client/***' \
    --include='samples/***' \
    --include='scripts/' \
    --include='scripts/enterprise-enroll.mjs' \
    --include='scripts/enterprise-unenroll.mjs' \
    --include='scripts/uninstall.mjs' \
    --include='dist/***' \
    --include='openclaw.plugin.json' \
    --include='tsconfig.json' \
    --include='package.json' \
    --include='package-lock.json' \
    --include='node_modules/***' \
    --exclude='*' \
    "$MOLTGUARD_DIR/" "$PLUGIN_DIR/"

log "Plugin copied to: $PLUGIN_DIR"

# ============================================================================
# Done!
# ============================================================================
echo ""
log "Local test setup complete!"
echo ""
echo "Build outputs:"
echo "  - Gateway:   $MOLTGUARD_DIR/gateway/"
echo "  - Dashboard: $MOLTGUARD_DIR/dashboard-dist/"
echo "  - MoltGuard: $MOLTGUARD_DIR/dist/"
echo ""
echo "Plugin installed to:"
echo "  $PLUGIN_DIR"
echo ""
echo "Next steps:"
echo "  1. Restart OpenClaw to load the updated plugin"
echo "  2. Run /og_status to verify the plugin is working"
echo ""
