#!/bin/bash
# ============================================================================
# MoltGuard Enterprise Unenroll Script
# ============================================================================
# Removes enterprise configuration from OpenClaw, restoring default behavior.
# The moltguard plugin remains enabled but without enterprise config.
#
# Usage:
#   ./scripts/enterprise-unenroll.sh
#
# What it does:
#   Removes the "config" block from moltguard plugin in ~/.openclaw/openclaw.json:
#     Before:
#       "moltguard": { "enabled": true, "config": { "plan": "enterprise", "coreUrl": "..." } }
#     After:
#       "moltguard": { "enabled": true }
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}==>${NC} $1"; }
error() { echo -e "${RED}ERROR:${NC} $1"; exit 1; }

OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"

# Check openclaw.json exists
if [[ ! -f "$OPENCLAW_JSON" ]]; then
    error "OpenClaw config not found at $OPENCLAW_JSON
Is OpenClaw installed on this machine?"
fi

# Check jq is available
if ! command -v jq &>/dev/null; then
    error "jq is required but not installed.
Install it with: brew install jq (macOS) or apt install jq (Linux)"
fi

# Check if enterprise config exists
CURRENT_PLAN=$(jq -r '.plugins.entries.moltguard.config.plan // empty' "$OPENCLAW_JSON" 2>/dev/null)
if [[ -z "$CURRENT_PLAN" ]]; then
    warn "No enterprise config found. Nothing to remove."
    exit 0
fi

CURRENT_URL=$(jq -r '.plugins.entries.moltguard.config.coreUrl // empty' "$OPENCLAW_JSON" 2>/dev/null)
log "Removing enterprise config..."
log "  Current plan:    $CURRENT_PLAN"
log "  Current coreUrl: $CURRENT_URL"

# Remove the config block from moltguard plugin
TEMP_FILE=$(mktemp)
jq 'del(.plugins.entries.moltguard.config)' "$OPENCLAW_JSON" > "$TEMP_FILE"

# Validate the output is valid JSON before overwriting
if ! jq empty "$TEMP_FILE" 2>/dev/null; then
    rm -f "$TEMP_FILE"
    error "Failed to generate valid JSON. Original config is unchanged."
fi

mv "$TEMP_FILE" "$OPENCLAW_JSON"

log "Enterprise unenrollment complete!"
echo ""
echo "Config updated: $OPENCLAW_JSON"
echo "MoltGuard will use the default public Core on next restart."
echo ""
echo "Next steps:"
echo "  Restart OpenClaw to apply the change."
