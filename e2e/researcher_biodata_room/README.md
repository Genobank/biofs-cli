# E2E: Researcher Biodata Room

Targets **real** `genobank-production` + Sequentia (not mocks).

## Prerequisites

1. `biofs` CLI built/linked (`@genobank/biofs` from `~/Downloads/biofs-cli`).
2. biofs-node with `/agent/room/*` deployed (or `BIOFS_NODE_URL` pointing at a node that has it).
3. Two profiles:
   - `BIOFS_PROFILE=patient` → vault `0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a`
   - `BIOFS_PROFILE=researcher` → distinct Research Biowallet
4. At least one `biocid://` the patient owns for demo scope.

## Scripts

| Script | Role |
|---|---|
| `00_preflight.sh` | Health + RPC + dirs |
| `01_profiles.sh` | Assert two wallets differ |
| `02_room_lifecycle.sh` | create → request → admit → files → revoke |
| `run_all.sh` | Orchestrate |

## Env

```bash
export PATIENT_WALLET=0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
export DEMO_BIOCIDS='biocid://0x5f5a60…/vcf/…'   # comma-separated
export GENOBANK_API_URL=https://genobank.app
# optional: BIOFS_NODE_URL=https://genobank.app/api_biofs_node
# optional: E2E_TELEGRAM=1 + patient Telegram chat for notify stage
```

## Safety

- Scope only `DEMO_BIOCIDS`.
- Always revoke at end (trap in `02_room_lifecycle.sh`).
- Never download BAM/FASTQ to the laptop in this harness.
