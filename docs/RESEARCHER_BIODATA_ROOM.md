# Researcher Biodata Room

**Investor data room, for bioinformatics.**  
Time-bounded, identity-checked, consent-gated access to a patient’s **anonymized** vault (biocids only), with deep-dive tools (stream / annotate / Claude Desktop MCP) and Telegram signing for the patient.

## Cast (E2E)

| Role | Profile | Wallet |
|---|---|---|
| Patient (owner) | `BIOFS_PROFILE=patient` | `0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a` (production vault) |
| Researcher | `BIOFS_PROFILE=researcher` | **New** Research Biowallet via ORCID / LinkedIn / X / Google / MetaMask |

Never use the same credentials for both roles. Consent requires subject ≠ requester.

## Login / known identity

**Patient / general:** [genobank.io/login](https://genobank.io/login)  
Google, Microsoft, ORCID, Login.gov, NIH, eRA, email, MetaMask, WalletConnect.

**Researcher:** [genobank.io/researcher/register](https://genobank.io/researcher/register) or:

```bash
export BIOFS_PROFILE=researcher
biofs researcher register --provider orcid   # or linkedin, twitter, google, metamask
biofs researcher status
```

## Dual profiles on one laptop

```bash
biofs profile use patient
export BIOFS_PROFILE=patient
biofs login
biofs whoami

biofs profile use researcher
export BIOFS_PROFILE=researcher
biofs researcher register --provider linkedin
biofs whoami   # must differ from patient
```

Shell shortcut:

```bash
eval "$(biofs profile use researcher --print)"
```

## Happy path (CLI)

```bash
# ── Patient shell ──────────────────────────────────────────
export BIOFS_PROFILE=patient
biofs room create \
  --biocids 'biocid://0x5f5a60…/vcf/…' \
  --purpose 'ACMG germline deep dive' \
  --skills list,resolve,stream,htsget,annotate \
  --days 7
# → room_id, signing_url

# ── Researcher shell ───────────────────────────────────────
export BIOFS_PROFILE=researcher
biofs room request room-… --purpose 'ACMG germline deep dive'
# → pending; patient notified

# Optional Telegram (operator MCP or CLI helper):
# telegram_send_consent_request(
#   chat=@patient, owner_wallet=0x5f5a…, researcher_wallet=0xR…,
#   researcher_name=…, linkedin_url=…, serial_number=…,
#   room_id=room-…, purpose=…, signing_url=https://genobank.app/consent/sign?…)

# ── Patient admits ─────────────────────────────────────────
export BIOFS_PROFILE=patient
biofs room admit room-…
# or sign via signing_url / Telegram Mini App (Slice B closes full Mini App loop)

# ── Researcher deep dive ───────────────────────────────────
export BIOFS_PROFILE=researcher
biofs room enter room-…
biofs room files
biofs stream <biocid> | bcftools stats -
biofs annotate submit <serial>
biofs room leave

# ── Patient revoke ─────────────────────────────────────────
export BIOFS_PROFILE=patient
biofs room revoke room-…
```

## Node HTTP surface

Proxied as `https://genobank.app/api_biofs_node/room/*` → `/agent/room/*`:

| Method | Path | Who |
|---|---|---|
| POST | `/room/create` | Owner |
| POST | `/room/request` | Researcher |
| GET | `/room/status` | Member (full) / other (minimal) |
| POST | `/room/admit` | Owner |
| POST | `/room/revoke` | Owner or researcher |
| GET | `/room/list` | Caller |
| GET | `/room/files` | Member (open for researcher) |
| GET | `/room/signing_url` | Member |

Mongo: `biofs_node.rooms`, `biofs_node.room_audit`.

## Claude Desktop MCP

Use `bio_authenticate` with the **researcher** signature, then prefer:

- `bio_resolve` / `bio_run_skill` for compute next to data  
- Room capabilities will land in `bio_invoke` catalog as `room.*` (Slice A CLI/node first)

Do **not** ask for or paste `gs://` paths. Address everything by `biocid://`.

## Design principles

1. Patient always admits (signature); node does not mint consent about them.  
2. Scope is an explicit biocid list (safer than whole vault).  
3. Default skills: list, resolve, stream, view, htsget, annotate.  
4. Default TTL: 7 days (max 30).  
5. Laptop never bulk-downloads WGS; use node-side annotate / skills.

## Status (2026-08-01 Slice B)

- [x] Dual profiles (`biofs profile`)  
- [x] Room API + CLI (`create|request|status|admit|revoke|list|enter|leave|files|signing-url`)  
- [x] Telegram consent fields: room_id, purpose, signing_url, orcid  
- [x] Web signing page `genobank.io/consent/sign/` (personal_sign admit message → room/admit)  
- [x] Researcher passport (`biofs researcher passport`, node `/agent/researcher/passport`)  
- [x] Workspace re-homed (`/agent/workspace/*` unlocked + HTTP router)  
- [x] list_inventory room ACL for researchers  
- [x] Fuse defaults → `https://genobank.app/api_biofs_fuse`  
- [x] Claude Desktop MCP: `~/Downloads/biofs-room-mcp/`  
- [ ] Mini App posts signature (web page is primary; Mini App deep link still opens TG)  
- [ ] LabNFT on-chain mint automation (passport stores ga4gh_level off-chain for now)  
- [x] Deploy node + consent/sign page to production hosts (2026-08-01 19:30 UTC)  

### Rollback

Local trees: `~/Downloads/_rollback_biodata_room_20260801_122308/`

Host (genobank-production):
- `/opt/biofs-node-v0.4/src/index.js.bkp.pre_room_deploy_20260801_122948`
- `/opt/biofs-node-v0.4/src/lib.bkp.pre_room_deploy_20260801_122948/`

Host restore:
```bash
sudo cp -p /opt/biofs-node-v0.4/src/index.js.bkp.pre_room_deploy_20260801_122948 \
  /opt/biofs-node-v0.4/src/index.js
sudo rsync -a /opt/biofs-node-v0.4/src/lib.bkp.pre_room_deploy_20260801_122948/ \
  /opt/biofs-node-v0.4/src/lib/
sudo systemctl restart biofs-node-v0.4.service
```

### Deploy (production) — DONE 2026-08-01

1. Host backup: `index.js.bkp.pre_room_deploy_20260801_122948` + `lib.bkp…`  
2. Installed `rooms.js`, `workspace.js`, `workspace_http.js`, updated `index.js`  
3. Restarted `biofs-node-v0.4.service` (active, mongo connected)  
4. Static: `/home/ubuntu/Genobank_APIs/genobank.io/consent/sign/index.html` (public 200)  
5. Smoke:  
   - `GET https://genobank.app/api_biofs_node/room/public?…` → JSON 404 invalid token (route live)  
   - `POST …/workspace/open` → durable case  
   - `https://genobank.io/consent/sign/` → 200  
6. Optional: configure Claude Desktop with `biofs-room-mcp/server.py`  


See plan: session `plan.md` · Researcher Biodata Room E2E Protocol.

## TeleBioinformatics

See [TELEBIOINFORMATICS.md](./TELEBIOINFORMATICS.md) for `biofs tele` (stats, region, IGV, jupyter).

