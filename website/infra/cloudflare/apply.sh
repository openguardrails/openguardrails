#!/usr/bin/env bash
# Reconcile the Cloudflare routing for openguardrails.com from the snapshots in
# this directory: deploy the platform-proxy Worker and ensure the Worker routes
# match worker-routes.json exactly (adds missing, deletes extras).
#
# Requires: CLOUDFLARE_API_TOKEN with Workers Scripts:Edit + Workers Routes:Edit.
# Usage:    CLOUDFLARE_API_TOKEN=... ./apply.sh [--dry-run]
set -euo pipefail

ACCOUNT_ID="fa2c697b640341b45724ecc98aeb61d7"
ZONE_ID="b7d9a7d1dc3e1c070e4485f8b6d1ab3f"
SCRIPT_NAME="platform-proxy"
COMPAT_DATE="2024-11-01"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY="${1:-}"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
api() { curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }

echo "==> Deploy Worker '$SCRIPT_NAME'"
if [ "$DRY" = "--dry-run" ]; then
  echo "    (dry-run) would PUT $HERE/platform-proxy.worker.js"
else
  api -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
    -F "metadata={\"main_module\":\"platform-proxy.js\",\"compatibility_date\":\"$COMPAT_DATE\"};type=application/json" \
    -F "platform-proxy.js=@$HERE/platform-proxy.worker.js;type=application/javascript+module" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('    deploy:', 'ok' if d['success'] else d['errors'])"
fi

echo "==> Reconcile Worker routes"
DESIRED=$(python3 -c "import json;print('\n'.join(json.load(open('$HERE/worker-routes.json'))))")
CURRENT_JSON=$(api "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes")

# Add any desired route that is missing.
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  if ! echo "$CURRENT_JSON" | python3 -c "import sys,json;pats=[r['pattern'] for r in json.load(sys.stdin)['result']];sys.exit(0 if '$pat' in pats else 1)"; then
    if [ "$DRY" = "--dry-run" ]; then echo "    (dry-run) would ADD $pat"; else
      api -X POST -H "Content-Type: application/json" \
        "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
        --data "{\"pattern\":\"$pat\",\"script\":\"$SCRIPT_NAME\"}" >/dev/null && echo "    added   $pat"
    fi
  fi
done <<< "$DESIRED"

# Delete any route bound to this script that is not in the desired set.
echo "$CURRENT_JSON" | python3 -c "
import sys,json
cur=json.load(sys.stdin)['result']
desired=set(json.load(open('$HERE/worker-routes.json')))
for r in cur:
    if r.get('script')=='$SCRIPT_NAME' and r['pattern'] not in desired:
        print(r['id'], r['pattern'])
" | while read -r id pat; do
  if [ "$DRY" = "--dry-run" ]; then echo "    (dry-run) would DELETE $pat"; else
    api -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes/$id" >/dev/null && echo "    deleted $pat"
  fi
done

echo "==> Done"
