#!/usr/bin/env bash
# Offline demo of the provenance control specified in specification/provenance.md.
# Zero dependencies (stdlib Python only). No network, no keys.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"

echo "================================================================"
echo " 1. NO provenance — point judgment only (what a deployment"
echo "    without this control sees today)"
echo "================================================================"
"$PY" evaluate_provenance.py policy.json episode.json --no-provenance

echo
echo "================================================================"
echo " 2. provenance, WITHOUT the optional 'sources' field — trust"
echo "    derived from message roles alone"
echo "================================================================"
"$PY" evaluate_provenance.py policy.json episode.json --no-sources

echo
echo "================================================================"
echo " 3. provenance WITH 'sources' — the producer says the tool"
echo "    result was an email whose DMARC failed"
echo "================================================================"
"$PY" evaluate_provenance.py policy.json episode.json

echo
echo "----------------------------------------------------------------"
echo " Same three steps, three outcomes on the payment:"
echo "   1. ALLOW  — nothing in that payload looks like an attack,"
echo "               because nothing in it is one"
echo "   2. FLAG   — the action is derived from untrusted content"
echo "   3. BLOCK  — from content nobody vouched for"
echo
echo " Note where the edge is carried: step 3 is a NEW session four"
echo " days later whose payload holds no external content at all."
echo " The only route back to the email is the memory key, and the"
echo " ledger that remembers it lives in the runtime."
echo "----------------------------------------------------------------"
echo
echo "demo done."
