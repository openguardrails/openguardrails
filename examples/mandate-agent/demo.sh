#!/usr/bin/env bash
# Offline demo of the mandate check specified in specification/mandate.md.
# Zero dependencies (stdlib Python only). No network, no keys.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"

echo "================================================================"
echo " equities desk mandate — clock: Tue 10:00 America/New_York (RTH)"
echo "================================================================"
"$PY" evaluate_mandate.py equities-mandate.json sample_calls.json

echo
echo "================================================================"
echo " web-app engagement mandate — clock: Tue 03:00 (maintenance win)"
echo "================================================================"
"$PY" evaluate_mandate.py pentest-mandate.json pentest_calls.json --now=2026-08-04T03:00:00

echo
echo "demo done."
