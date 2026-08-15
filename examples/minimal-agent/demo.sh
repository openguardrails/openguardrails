#!/usr/bin/env bash
# Offline demo: both mocks + the minimal agent + the streaming variant.
# Zero third-party dependencies except `requests` (pip install requests).
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"

"$PY" mock_runtime.py &
RUNTIME_PID=$!
"$PY" mock_llm.py &
LLM_PID=$!
trap 'kill "$RUNTIME_PID" "$LLM_PID" 2>/dev/null || true' EXIT

# wait for both mocks to come up
"$PY" - <<'EOF'
import time, requests
for url in ("http://127.0.0.1:8471/v1/health", "http://127.0.0.1:8472"):
    for _ in range(50):
        try:
            requests.get(url, timeout=0.2); break
        except requests.RequestException:
            time.sleep(0.1)
EOF

echo
echo "================================================================"
echo " agent.py — two evaluates per model call; ends with a real block"
echo "================================================================"
"$PY" agent.py

echo
echo "================================================================"
echo " streaming_agent.py — hold the tail, judge once (allow, then cut)"
echo "================================================================"
"$PY" streaming_agent.py
echo
echo "demo done."
