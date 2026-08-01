#!/usr/bin/env bash
# Preflight: genobank-production surfaces + Sequentia RPC + patient inventory hint.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/runs/$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/00_preflight.log"
exec > >(tee -a "$LOG") 2>&1

echo "== Researcher Biodata Room E2E · preflight =="
echo "RUN_DIR=$RUN_DIR"

API="${GENOBANK_API_URL:-https://genobank.app}"
RPC="${SEQUENTIA_RPC_URL:-https://seqrpc.genobank.app}"
PATIENT="${PATIENT_WALLET:-0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a}"

echo "-- biofs-node health (via api_biofs_node if proxied) --"
curl -fsS -m 15 "$API/api_biofs_node/../" -o /dev/null || true
# Prefer clara health or healthz through known paths
if curl -fsS -m 15 "$API/api/v1/clara/health" >/dev/null 2>&1; then
  echo "OK clara health via $API"
else
  echo "WARN: clara health not reachable via $API (may still be OK if nginx path differs)"
fi

echo "-- Sequentia RPC --"
CHAIN=$(curl -fsS -m 15 -X POST "$RPC" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result",""))')
echo "chainId=$CHAIN (expect 0xe6d779 = 15132025)"
test -n "$CHAIN"

echo "-- CLI --"
command -v biofs >/dev/null
biofs --version || true

echo "-- dual profile dirs --"
mkdir -p "$HOME/.biofs/profiles/patient" "$HOME/.biofs/profiles/researcher"
echo "patient profile dir ready; researcher profile dir ready"
echo "PATIENT_WALLET=$PATIENT"
echo "PREFLIGHT_OK" | tee "$RUN_DIR/00_preflight.ok"
echo "$RUN_DIR" > "$ROOT/.last_run_dir"
