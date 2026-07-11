#!/usr/bin/env bash
# Refresh the snapshots in this directory from production:
#   - platform-proxy Worker source        -> cloudflare/platform-proxy.worker.js
#   - Worker routes for the zone           -> cloudflare/worker-routes.json
#   - origin nginx vhost (via SSH)         -> nginx/openguardrails-ogr.conf
#
# Requires: CLOUDFLARE_API_TOKEN (Workers Scripts:Read + Workers Routes:Read),
#           and SSH access to the origin (ssh host alias below).
set -euo pipefail

ACCOUNT_ID="fa2c697b640341b45724ecc98aeb61d7"
ZONE_ID="b7d9a7d1dc3e1c070e4485f8b6d1ab3f"
SCRIPT_NAME="platform-proxy"
SSH_HOST="${OGR_SSH_HOST:-Alisv}"        # ssh config alias for root/ecs-user on the origin
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
api() { curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }

echo "==> Worker source"
# The script download comes back as a multipart body; extract the JS payload.
api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
  | awk 'f{print} /^export default|^addEventListener|^import /{if(!f){f=1;print}}' \
  | sed '/^--/d' > "$HERE/cloudflare/platform-proxy.worker.js"
# Fallback: if the awk heuristic produced nothing, keep the existing file.
[ -s "$HERE/cloudflare/platform-proxy.worker.js" ] || echo "    (warn) worker body empty; left file unchanged"

echo "==> Worker routes"
api "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(sorted([r['pattern'] for r in d['result']]),indent=2))" \
  > "$HERE/cloudflare/worker-routes.json"

echo "==> Origin nginx vhost (ssh $SSH_HOST)"
ssh "$SSH_HOST" 'sudo cat /etc/nginx/sites-available/ogr' > "$HERE/nginx/openguardrails-ogr.conf"

echo "==> Done. Review with: git diff"
