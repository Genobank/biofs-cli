#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${RUN_DIR:-$(cat "$ROOT/.last_run_dir" 2>/dev/null || echo "$ROOT/runs/manual")}"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/01_profiles.log"
exec > >(tee -a "$LOG") 2>&1

echo "== profiles =="
export BIOFS_PROFILE=patient
P=$(biofs whoami --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("wallet") or d.get("wallet_address") or "")' 2>/dev/null || true)
if [ -z "$P" ]; then
  # fallback text whoami
  P=$(biofs whoami 2>/dev/null | grep -Eo '0x[a-fA-F0-9]{40}' | head -1 || true)
fi
echo "patient wallet: ${P:-NOT_LOGGED_IN}"

export BIOFS_PROFILE=researcher
R=$(biofs whoami --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("wallet") or d.get("wallet_address") or "")' 2>/dev/null || true)
if [ -z "$R" ]; then
  R=$(biofs whoami 2>/dev/null | grep -Eo '0x[a-fA-F0-9]{40}' | head -1 || true)
fi
echo "researcher wallet: ${R:-NOT_LOGGED_IN}"

if [ -z "$P" ] || [ -z "$R" ]; then
  echo "FAIL: both profiles must be authenticated"
  echo "  BIOFS_PROFILE=patient biofs login"
  echo "  BIOFS_PROFILE=researcher biofs researcher register --provider orcid"
  exit 1
fi
if [ "${P,,}" = "${R,,}" ]; then
  echo "FAIL: patient and researcher wallets must differ (consent requires two principals)"
  exit 1
fi
echo "P=$P" > "$RUN_DIR/wallets.env"
echo "R=$R" >> "$RUN_DIR/wallets.env"
echo "PROFILES_OK"
