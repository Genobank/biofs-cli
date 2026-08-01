#!/usr/bin/env bash
# create → request → admit → enter/files → revoke on real API
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="${RUN_DIR:-$(cat "$ROOT/.last_run_dir" 2>/dev/null || echo "$ROOT/runs/manual")}"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/02_room_lifecycle.log"
exec > >(tee -a "$LOG") 2>&1

if [ -z "${DEMO_BIOCIDS:-}" ]; then
  echo "FAIL: set DEMO_BIOCIDS to a comma-separated biocid:// list owned by the patient"
  exit 1
fi

source "$RUN_DIR/wallets.env" 2>/dev/null || true
ROOM_ID=""

cleanup() {
  if [ -n "${ROOM_ID:-}" ]; then
    echo "== trap revoke $ROOM_ID =="
    export BIOFS_PROFILE=patient
    biofs room revoke "$ROOM_ID" --quiet --json || true
  fi
}
trap cleanup EXIT

echo "== create (patient) =="
export BIOFS_PROFILE=patient
CREATE_JSON=$(biofs room create --biocids "$DEMO_BIOCIDS" --purpose "E2E biodata room deep dive" --days 1 --json)
echo "$CREATE_JSON" | tee "$RUN_DIR/create.json"
ROOM_ID=$(echo "$CREATE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("room_id",""))')
test -n "$ROOM_ID"
echo "ROOM_ID=$ROOM_ID" | tee "$RUN_DIR/room.env"

echo "== request (researcher) =="
export BIOFS_PROFILE=researcher
biofs room request "$ROOM_ID" --purpose "E2E ACMG-style deep dive" --json | tee "$RUN_DIR/request.json"

if [ "${E2E_TELEGRAM:-0}" = "1" ] && [ -n "${PATIENT_TELEGRAM_CHAT:-}" ]; then
  echo "== optional Telegram notify (manual MCP / external) =="
  SIGNING=$(python3 -c 'import json; print(json.load(open("'"$RUN_DIR"'/request.json")).get("signing_url",""))')
  echo "signing_url=$SIGNING (send via telegram_send_consent_request)"
fi

echo "== admit (patient) =="
export BIOFS_PROFILE=patient
biofs room admit "$ROOM_ID" --json | tee "$RUN_DIR/admit.json"

echo "== enter + files (researcher) =="
export BIOFS_PROFILE=researcher
biofs room enter "$ROOM_ID" --json | tee "$RUN_DIR/enter.json"
biofs room files --json | tee "$RUN_DIR/files.json"
biofs room leave --json | tee "$RUN_DIR/leave.json"

echo "== revoke (patient) =="
export BIOFS_PROFILE=patient
biofs room revoke "$ROOM_ID" --json | tee "$RUN_DIR/revoke.json"
ROOM_ID=""  # prevent double revoke in trap

echo "== assert denied (researcher status shows revoked) =="
export BIOFS_PROFILE=researcher
biofs room status "$(python3 -c 'import json; print(json.load(open("'"$RUN_DIR"'/create.json"))["room_id"])')" --json | tee "$RUN_DIR/status_after.json" || true

echo "ROOM_LIFECYCLE_OK"
