#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export RUN_DIR="${RUN_DIR:-$ROOT/runs/$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$RUN_DIR"
echo "RUN_DIR=$RUN_DIR"
bash "$ROOT/00_preflight.sh"
bash "$ROOT/01_profiles.sh"
bash "$ROOT/02_room_lifecycle.sh"
echo "ALL_OK → $RUN_DIR"
