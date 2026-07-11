#!/usr/bin/env bash
# Enforce an approved OGR policy for this session.
#
# Run ONLY after your operator has approved the policy. This validates the file,
# points the runtime at it, and enables the sandbox. `source` it so the exports
# persist in your shell:
#
#     source scripts/enforce.sh ogr.policy.json [srt|openshell]
#
set -euo pipefail

POLICY="${1:-ogr.policy.json}"
BACKEND="${2:-srt}"

if [ ! -f "$POLICY" ]; then
  echo "✗ policy not found: $POLICY" >&2
  return 1 2>/dev/null || exit 1
fi

# Validate JSON before enforcing.
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$POLICY" 2>/dev/null; then
  echo "✗ policy is not valid JSON: $POLICY" >&2
  return 1 2>/dev/null || exit 1
fi

export OGR_POLICY="$(cd "$(dirname "$POLICY")" && pwd)/$(basename "$POLICY")"
export OGR_SANDBOX="$BACKEND"

echo "✓ OGR enforcing"
echo "  OGR_POLICY=$OGR_POLICY"
echo "  OGR_SANDBOX=$OGR_SANDBOX"
echo "  every exec/tool call is now checked at the agent hook and sandbox boundary."
