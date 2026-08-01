# Owner dashboard: fine-grain consent for GA4GH NFT Visa Passport

## Goal
Let the biodata owner (`0x5f5a60…`) select individual biocids or serial-scoped sets from the full vault inventory, then mint/bind a time-boxed GA4GH-style researcher Passport (LabNFT + room + BioPIL) that admits only those files.

## Surfaces already live
1. **Cancer map twin**: https://genoclaw.genobank.app/cancer-map/0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/ (case TN25-336147)
2. **Biodata room protocol** (biofs-node): create → request → admit (EIP-191) → list_inventory scoped → revoke
3. **htsget inventory fallback**: any `bioroutes.inventory` VCF/BAM/CRAM is streamable by filename or biocid last segment (owner or open-room researcher)
4. **submit_cravat room ACL**: admitted researcher with skill `annotate` and serial in room.biocids
5. **CLI**: `biofs room *`, `biofs passport`, `biofs stream`, `biofs annotate`
6. **Owner biofile UI**: `genobank.io/consent/biofile/` (masterDetails inventory)

## Inventory truth (2026-08-01)
| Source | Count |
| Mongo `bioroutes.inventory` owner wallet | 105,572 |
| htsget-eligible (vcf/bam/cram/gvcf) | ~880 |
| Mongo `biorouter.biocid_registry` | 93 |
| CLI export cap used in E2E | 5,000 |
| Unique serials in export | 350 |
| Cancer twin agents in registry | caris 16, epic 37, genobank 33, ucsf 4, somos 3 |

## UX path (implement next, in order)
### A. Inventory picker (owner dashboard)
1. Extend `consent/biofile` (or new `/consent/passport/`) with a multi-select tree:
   - Group by **serial** → filetype → individual biocid
   - Filters: genomic-only, cancer-map case TN25-336147, PENDING_REGISTRATION vs REGISTERED
   - Selection model: `{ biocids: string[], serials: string[], skills: ('stream'|'annotate'|'view')[] }`
2. Data API (already partially exists):
   - `list_inventory` with room_id OR owner signature (full vault)
   - Prefer server-side pagination over 100k-row browser load (cursor by `_id`)

### B. Admit / Passport bind
1. Owner selects set → Create room with those biocids + skills + TTL
2. Researcher passport (`biofs passport` / LabNFT GA4GH level) is **display + identity**, not the ACL:
   - ACL remains room (revocable) + optional BioPIL license token
3. Signing: MetaMask personal_sign of `admit_message` (already works) or Telegram Mini App deep link
4. Output: signing_url, telegram_deep_link, room_id, GA4GH visa card JSON for researcher wallet

### C. Runtime enforcement (done / partial)
| Verb | Gate |
| `biofs stream` / htsget | owner OR room_allows(biocid/serial) |
| `biofs annotate submit` | owner OR operator OR roomOk(annotate+serial) |
| `list_inventory` as researcher | openRoomBiocidsFor(wallet) |

### D. Cancer-map bridge
1. "Share twin files" button on cancer-map loads the 16 Caris (+ Natera/Invitae/Langebio when registry-complete) biocids into the picker pre-selected
2. Keep clinical names off; case_id TN25-336147 and biocids only in clinical-scope exports

## Implementation slices
1. **Slice D0 (done this session)**: htsget inventory + stream CLI stdout fix + worker gcsfuse download + room ACL code path
2. **Slice D1**: paginated inventory API for owner picker (`/agent/inventory?cursor=&types=vcf,bam`)
3. **Slice D2**: biofile UI multi-select → `POST /agent/room/create` with selected biocids
4. **Slice D3**: passport card UI showing room-scoped visa + revoke
5. **Slice D4**: registry completeness for Natera/Invitae/Langebio biocids (HTML shows them; registry partial)

## Non-goals
- Do not hand signed GCS URLs to researchers
- Do not load 100k files into the browser at once
- Do not use genobank.io mail identity for litigation (unrelated but absolute elsewhere)
