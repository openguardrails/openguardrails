#!/bin/bash
# ============================================================================
# MoltGuard Enterprise Enroll Script
# ============================================================================
# Configures OpenClaw to connect to a private enterprise Core deployment.
# Designed to be executed by enterprise EDR systems for managed devices.
#
# Usage:
#   ./scripts/enterprise-enroll.sh <core-url>
#
# Example:
#   ./scripts/enterprise-enroll.sh https://core.company.com
#
# What it does:
#   Sets moltguard plugin config in ~/.openclaw/openclaw.json:
#     "moltguard": {
#       "enabled": true,
#       "config": {
#         "plan": "enterprise",
#         "coreUrl": "<core-url>"
#       }
#     }
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

# Validate arguments
if [[ -z "$1" ]]; then
    error "Usage: $0 <core-url>

Example:
  $0 https://core.company.com
  $0 http://10.0.1.100:53666"
fi

CORE_URL="$1"
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

log "Enrolling in enterprise plan..."
log "Core URL: $CORE_URL"

# Update moltguard plugin config
TEMP_FILE=$(mktemp)
jq --arg url "$CORE_URL" '
  .plugins.entries.moltguard.enabled = true |
  .plugins.entries.moltguard.config = {
    "plan": "enterprise",
    "coreUrl": $url
  }
' "$OPENCLAW_JSON" > "$TEMP_FILE"

# Validate the output is valid JSON before overwriting
if ! jq empty "$TEMP_FILE" 2>/dev/null; then
    rm -f "$TEMP_FILE"
    error "Failed to generate valid JSON. Original config is unchanged."
fi

mv "$TEMP_FILE" "$OPENCLAW_JSON"

log "Enterprise enrollment complete!"
echo ""
echo "Config updated: $OPENCLAW_JSON"
echo "  plan:    enterprise"
echo "  coreUrl: $CORE_URL"
echo ""
echo "Next steps:"
echo "  Restart OpenClaw to apply the new configuration."
