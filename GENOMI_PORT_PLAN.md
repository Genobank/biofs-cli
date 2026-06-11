# Genomi -> biofs Port Plan

## 1. Executive summary

### What
This plan ports a set of proven techniques (the "Genomi" body of work) into the GenoBank biofs protocol stack across three repos: **biofs-cli** (thin client verbs), **biofs-node** (the single chokepoint that mounts GCS, schedules GPU, anchors on-chain, and assembles result manifests), and **mcp-bio-context** (the agent-facing MCP surface), plus targeted patches to the prod-side Python analyzer (`api_biofs_fuse.py` + `clinical_acmg/*.py`) that actually executes the clinical read queries the verbs call.

The work is organized into six campaigns (A through F). The first five are the headline "5+1": five that fix correctness, robustness, and self-defense, plus one (F) of standalone high-value capabilities. Every change respects the biofs protocol conventions: verbs are thin clients submitting manifests; biofs-node is the only thing that mounts GCS, schedules GPU, anchors ClaraJobNFTs, and assembles manifests; storage is GCS + AES-256 only (no IPFS, no AWS, no new S3); lineage is never UNKNOWN; cross-VM coordination is a Mongo lease, never a POSIX flock; consent surfaces are wired to real BioNFT/Bloom checks, not local booleans; and no Nebula provider signature survives the port.

### Why
The current surface has five documented, recurring failure classes:
1. **The cold-462MB-sqlite 524** (operational #1). The first cold `biofs variants`/`cohort-acmg`/`fourier-score` against an OpenCRAVAT sqlite full-scans a ~462MB immutable db with no `base__hugo` index (~130s), exceeding Cloudflare's ~100s edge timeout, returning a 524 on the first hit while work continues server-side.
2. **Evidence dishonesty.** A zero-row result is structurally indistinguishable from a clinical "no pathogenic variant found." A cold mount, a revoked consent, an unmounted route, and an unindexed gene filter all return `count:0`, and an agent can render any of them to a clinician as a negative finding. That is a HIPAA/BAA liability.
3. **Clinically wrong answers.** rsID queries filter the usually-empty VCF `base__id` column instead of resolving to a locus; a sequenced hom-ref is indistinguishable from an unsequenced site; ACMG PS/PM codes attach to low-depth/low-GQ/non-PASS calls; ties resolve nondeterministically so the same sample yields a different ClaraJobNFT result hash on re-run.
4. **Input untruth.** biofs trusts the filename and a single env default (`assembly: p.assembly || 'hg38'`) for genome build and chromosome-naming style, producing silently-empty results on mixed b37/hg38 caches and a wrong-build job nobody can audit before the agent acts.
5. **A non-self-defending surface.** The dist-only-commands trap (where `npm run build` silently strips compiled verb registrations from `dist/index.js`) has already cost rrm-*/cohort-*/fourier-score/variants registrations in production. Agents can misuse `fourier-score` as an ACMG oracle with no guardrail. A stale CLI silently answers wrong against an independently-versioned node.

### The 5+1 campaigns
- **A. Kill the cold-462MB-sqlite 524** (operational #1): submit-then-poll + dedup so the request path never blocks past Cloudflare, plus a biofs-node-managed sidecar sqlite (denormalized hot columns + partial indexes) so warm queries hit an indexed file and return ~2s.
- **B. Evidence honesty as an enforced contract**: a typed `evidence_envelope` assembled and validated at the biofs-node chokepoint so an incomplete materialization can never wear the costume of a negative finding, and the agent surface is forced to read `finding_state`/`answer_readiness` instead of `count`.
- **C. Clinical correctness** (changes answers, not ergonomics): locus-first rsID resolution, gVCF reference-block wild-type, a genotype-support gate on ACMG, deterministic best-record tie-break, and HPO-density tie-break with forced `NEEDS_CLINICAL_CONFIRMATION`.
- **D. Input truth over filenames** (b37/hg38 + no-UNKNOWN): content-sniff the format, infer build from `@SQ` MD5/length, sniff chromosome style once per mount and fan out the JOIN, echo and on-chain-anchor every assumed default with its provenance, and stamp resolver truth into `bioroutes.inventory`.
- **E. Self-defending verb/agent surface**: one canonical per-verb JSON fragment feeding `--help`, MCP `tools/list`, and an import-time referential-integrity check that FAILS the build on a stripped/duplicate/dead-endpoint verb; routing guardrails (`not_for`/`use_instead`) returned as data; a `schema_version` lifecycle gate; `next_actions` self-chaining; a materialization manifest that flips to STALE on GDPR erasure; and a skill-gated single dispatcher collapsing the visible tool budget from ~90 to ~18.
- **F. Standalone high-value**: a consent-gated multi-field FTS5 evidence search (BM25 + RRF), an offline self-contained HTML dashboard, a citation-disciplined research-finding store, and an onboarding/docs generator that unblocks the 42-lab rollout.

### Expected outcome
**The 524 dies** (Campaign A: the cold scan moves into a background `query_jobs` job; the client only ever makes sub-second poll calls; the sidecar makes warm queries ~2s). **Answers get honest and correct** (Campaign B makes a zero-row result legally incapable of reading as a negative; Campaign C makes every clinical assertion support-gated, locus-first, and deterministic). **Input becomes the source of truth** (Campaign D kills the silent-default build hardcode and the silent-empty chrom-style mismatch). **The surface self-defends** (Campaign E turns the dist-strip footgun into a hard build failure, makes verbs declare their contract, and forces agents through skill gates). **And the operator gains cross-sample search, a shareable dashboard, a disciplined research store, and a one-command lab onboarding** (Campaign F).

---

## 2. Current architecture (as-is)

A tight synthesis of the three repo maps plus the prod-side analyzer that the maps under-describe.

### The three-repo spine
- **biofs-cli** (`/Users/danieluribe/Downloads/biofs-cli`, local v3.6.0; npm-global v3.11.0; prod ~v3.12.0). Thin clients. Commands live in `src/commands/*.ts`, registered in `src/index.ts`. HTTP goes through `src/lib/api/fuse-client.ts` (`FuseAPIClient`, `baseUrl` resolves to `https://genobank.app`). Credentials via `CredentialsManager.getInstance().loadCredentials()`. The 5s/15s poll idiom already exists in `src/commands/annotate/status.ts:80-95`.
- **biofs-node** (`/Users/danieluribe/Downloads/biofs-node`, v0.4.4). The single authority. `src/index.js` holds `initMongo()` (~134-187), `verifyConsent` (lines 189-289, honors `CONSENT_ENFORCE=off|shadow|on` plus operator admin bypass), `sendJson` (lines 866-869, the single response helper), the route dispatch block (~857-1970), `anchorJobOnChain` (351-445), and the main entry (~1971-2009). Libs: `src/lib/cravat_mint.js` (`registerSqliteInInventory` 69-127, `scanner_version` line 111), `src/lib/cravat_worker.js`, `src/lib/workspace.js` (`claimLease`/`releaseLease` Mongo lease 243-286, `ws_leases`), `src/lib/sqlite_biocid.js` (deterministic biocid on `{originlab, customer_biowallet, vcf_filename}`), `src/lib/lab_paths.js` (`allocateSqlitePath`). Runs as systemd on parabricks-gpu :8787 (internal 10.128.0.6); re-verify the unit name. `/api_biofs_node` nginx prefix maps to the bare `/agent/*` routes.
- **mcp-bio-context** (`/Users/danieluribe/Downloads/bio-context-sprint/mcp-bio-context`, v0.2.0). Thin HTTP shell, no SQLite. `src/index.ts` holds the `TOOLS` array (176-471) and the dispatch switch (~928-979), `handle_bio_run_skill` (714-774), `handle_bio_load_manifest` (549), `handle_bio_resolve` (635-668). `src/workspace.ts` defines `BIOFS_NODE_BASE`. The MCP never reads CLI source; it consumes biofs-node over HTTP.

### The load-bearing nuance the maps under-describe: where clinical reads actually run
The maps imply `/agent/variants` and `/agent/cohort_acmg` live in biofs-node. **They do not.** Verified across all designs: `biofs variants` / `cohort-acmg` / `fourier-score` / `clinical` are thin clients that GET/POST `https://genobank.app/api_biofs_fuse/{variants,cohort_acmg,clinical_acmg}`, served by the **prod-side Python analyzer** `api_biofs_fuse.py` (the file MEMORY's dual-root fix backed up as `api_biofs_fuse.py.bkp.gcsmnt_dualroot.*`) plus `clinical_acmg/clinical_acmg.py`, under `/home/ubuntu/Genobank_APIs/production_api/...`. biofs-node serves only `/agent/submit_cravat` and friends for the annotate path. **This file is not in any local clone**; it must be pulled via scp before patching. Per CLAUDE.md it is normally diagnostic-only, but the 524 root cause and the clinical-read logic both live there, so the sanctioned approach is: patch the analyzer AND keep it reachable only through the existing verbs (never a direct curl entry point), then re-run through the verb.

Two routing facts that follow from this:
- **biofs-node JS owns**: annotate submit lifecycle (`/agent/submit_cravat`, lines ~1316-1419), the oc_jobs table and CRAVAT worker, inventory registration (`cravat_mint.js`), on-chain anchoring (`anchorJobOnChain`), consent (`verifyConsent`), and the Mongo lease.
- **The prod Python analyzer owns**: the actual filtered sqlite read for `/variants`, `/cohort_acmg`, `/fourier_score`, `/clinical_acmg` (the 462MB-scan hot path and the ACMG assignment logic).

### Key file:line anchors (the audit set)
| Concern | File | Anchor |
|---|---|---|
| Single response helper | biofs-node `src/index.js` | `sendJson` 866-869 |
| Consent gate (CONSENT_ENFORCE) | biofs-node `src/index.js` | `verifyConsent` 189-289 |
| Mongo init | biofs-node `src/index.js` | `initMongo()` 134-187 |
| On-chain anchor | biofs-node `src/index.js` | `anchorJobOnChain` 351-445 |
| submit_cravat + silent `hg38` default | biofs-node `src/index.js` | 1316-1383 (default at 1375) |
| cravat_status (the existing chokepoint) | biofs-node `src/index.js` | 1429-1452 |
| Main entry (setInterval start point) | biofs-node `src/index.js` | 1971-2009 |
| Inventory registration | biofs-node `src/lib/cravat_mint.js` | `registerSqliteInInventory` 69-127, scanner_version 111 |
| Mongo lease primitive | biofs-node `src/lib/workspace.js` | `claimLease`/`releaseLease` 243-286 |
| Deterministic biocid | biofs-node `src/lib/sqlite_biocid.js` | keyed on {originlab, customer_biowallet, vcf_filename} |
| FuseVariantsResponse (`job_id` nullable) | biofs-cli `src/lib/api/fuse-client.ts` | line 61 (job_id), `variants()` 215, `cohortAcmg()` 277 |
| Poll idiom (5s/15s) | biofs-cli `src/commands/annotate/status.ts` | 80-95 |
| Variants verb | biofs-cli `src/commands/variants.ts` | `api.variants(...)` 179-200 |
| MCP TOOLS + dispatch | mcp-bio-context `src/index.ts` | TOOLS 176-471, switch ~928-979 |
| MCP skill runner | mcp-bio-context `src/index.ts` | `handle_bio_run_skill` 714-774 |
| Clinical read hot path (prod-only) | `api_biofs_fuse.py` | re-verify on prod under production_api/ |
| ACMG assignment (prod-only) | `clinical_acmg/clinical_acmg.py` | re-verify on prod |

---

## 3. Cross-cutting design decisions

Five shapes are shared by multiple campaigns. They are defined ONCE here. Each campaign references this section rather than redefining.

### 3.1 The `evidence_envelope` shape (owned by Campaign B; consumed by C, E, F)
Returned **alongside, never replacing**, the existing `{columns,rows,count}` / `{results}` payload. Defined canonically in biofs-node `src/lib/evidence_envelope.js`.

```jsonc
{
  "schema_version": 1,
  "finding_state": "positive_findings"        // data_returned AND rows>0
                 | "true_negative_supported"  // negative ONLY if callable+covered+genotyped
                 | "empty_consulted_scope"    // queried, in-scope, zero rows, NOT a clinical negative
                 | "out_of_scope_for_input"   // gene/region not in this assay/build
                 | "materialization_incomplete", // cold/524/unmounted/consent/build-mismatch
  "answer_readiness": "ready" | "retry" | "blocked" | "unsupported",
  "negative_inference_permitted": false,       // DEFAULT false; ONLY true_negative_supported flips it
  "coverage_status": "data_returned" | "in_scope_empty" | "out_of_scope_for_input",
  "source_coverage": [
    { "source": "opencravat_sqlite",
      "biocid": "biocid://lab/wallet/sqlite/...",  // NEVER UNKNOWN (lineage rule)
      "sample_serial": "TN25-336147",
      "state": "consulted_and_returned" | "consulted_but_unavailable" | "in_scope_empty" | "out_of_scope",
      "reason_code": null }
  ],
  "negative_support": {                         // all three required for negative_inference_permitted
    "callability": null,                        // null | true | false
    "library_coverage": null,
    "genotype_support": null
  },
  "guidance_code": null,                         // typed; see 3.4
  "query": { "gene": "KRAS", "region": null, "build": "hg38", "max_af": 0.01 },
  "assembled_by": "biofs-node",
  "assembled_at": "2026-06-03T...Z"
}
```

Constructors (`positiveFindings`, `trueNegativeSupported`, `emptyConsultedScope`, `materializationIncomplete`, `outOfScopeForInput`) force the gate at construction time: `trueNegativeSupported` silently downgrades to `emptyConsultedScope` unless the full `negative_support` triplet is satisfied. The validator (`validateEnvelope`) runs on every envelope before `sendJson` and enforces four invariants: (1) `negative_inference_permitted` requires `finding_state==='true_negative_supported'`; (2) any `consulted_but_unavailable` source forbids a `ready` non-positive answer; (3) no `biocid` may be missing or match `/unknown/i`; (4) guidance codes are whitespace-free `<state>:<imperative>`.

### 3.2 The sidecar sqlite DDL (owned by Campaign A; the `end`/`chrom_sort` columns consumed by C2)
A biofs-node-managed denormalized hot-column derivative of the 462MB CRAVAT db, written to the **same GCS prefix and AES-256 bucket** (no new bucket, GCS-only), filename `<base_root>.sidecar.v<SIDECAR_SCHEMA_VERSION>.sqlite`, registered as a derivative child in `bioroutes.inventory`. Build pragmas are write-side only (`journal_mode=OFF`, `synchronous=OFF`, `temp_store=MEMORY`), split from the read pragmas in 3.x hardening.

```sql
CREATE TABLE hot AS
SELECT
  v.chrom, v.pos, v.ref_base, v.alt_base,
  CASE WHEN v.alt_base != '' AND v.alt_base != v.ref_base THEN 1 ELSE 0 END AS is_variant,
  s.dp AS DP, s.gq AS GQ,
  v."base__so" AS so,
  v.pos + length(v.ref_base) - 1 AS "end",        -- consumed by Campaign C2 refblock
  v."base__hugo" AS info_genes,
  v."base__cchange" AS cchange,
  v."base__clinvar" AS clinvar,
  v."dbsnp__rsid" AS rsid,
  (CASE substr(v.chrom,4)                          -- karyotype ordering; consumed by C4 / ORDER BY
     WHEN 'X' THEN 23 WHEN 'Y' THEN 24 WHEN 'M' THEN 25 WHEN 'MT' THEN 25
     ELSE CAST(substr(v.chrom,4) AS INTEGER) END) AS chrom_sort
FROM variant v
LEFT JOIN sample s ON s.base__uid = v.base__uid;

CREATE INDEX idx_hot_gene    ON hot(info_genes) WHERE is_variant = 1;
CREATE INDEX idx_hot_locus   ON hot(chrom, pos) WHERE is_variant = 1;
CREATE INDEX idx_hot_rsid    ON hot(rsid)       WHERE rsid IS NOT NULL;
CREATE INDEX idx_hot_clinvar ON hot(clinvar)    WHERE clinvar IS NOT NULL;
CREATE INDEX idx_hot_sort    ON hot(chrom_sort, pos) WHERE is_variant = 1;
PRAGMA user_version = 1;                            -- == SIDECAR_SCHEMA_VERSION
```

> The exact CRAVAT column names (`base__so`, `base__hugo`, `dbsnp__rsid`, `sample.dp/gq`, `base__uid`) MUST be re-verified via `PRAGMA table_info(variant)`/`table_info(sample)` on a real prod sqlite before the build is trusted; CRAVAT module versions rename columns. Absent columns emit `NULL`, never crash the build.

Read-path hardening (used by both A's read path and C's analyzer):
```python
def open_ro(sqlite_fs_path):
    uri = f"file:{sqlite_fs_path}?mode=ro&immutable=1&nolock=1"  # NEVER locking_mode=exclusive on gcsfuse
    conn = sqlite3.connect(uri, uri=True, timeout=30, check_same_thread=False)
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA temp_store=MEMORY")   # in-RAM temp tables for loci joins
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA mmap_size=0")         # mmap on FUSE is a footgun
    return conn
```

### 3.3 The Mongo job + lease model (owned by Campaign A; reused by C/F batch paths)
**All cross-VM coordination is a Mongo lease, never a POSIX fcntl flock** (meaningless across the genobank-production + parabricks-gpu fleet). Reuse/generalize `workspace.js`'s `claimLease`/`releaseLease` (lines 243-286) or add dedicated `sidecar_leases`/`research_findings` collections in the same style.

**Job table** (`query_jobs`, init alongside `oc_jobs` in `initMongo()`):
```jsonc
{
  "query_job_id": "qj_<uuid>",
  "dedup_key": "0xabc...:9f3c...",   // sha256(verb|serial|sorted-params), prefixed by lowercased biowallet; UNIQUE index
  "verb": "variants",                 // variants | cohort_acmg | fourier_score
  "serial": "AUG-12345",
  "biowallet": "0x...",               // operator-private; never the patient name
  "owner_wallet": "0x...",            // consent gate
  "params": { "gene": "KRAS", "max_af": "0.01", "so": "missense" },
  "status": "in_progress",            // queued | in_progress | done | failed | failed:stalled
  "result_ref": null,                 // gs:// of result fragment when large
  "result_inline": null,              // small result sets inline {columns,rows,count,evidence_envelope}
  "error": null,
  "heartbeat_at": 1730000000,         // worker bumps every 10s
  "stale_after_sec": 60,              // staleness window
  "created_at": 1730000000, "updated_at": 1730000000,
  "schema_version": 1
}
```

Dedup key (stable under param reordering):
```js
function dedupKey({ biowallet, verb, serial, params }) {
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  const h = crypto.createHash('sha256').update(`${verb}|${serial}|${sorted}`).digest('hex');
  return `${biowallet.toLowerCase()}:${h}`;
}
```

`submitOrJoin` upserts with `{$setOnInsert}` so a 524-retry rejoins an in-flight job; `sweepStalled` (a `setInterval`, plus opportunistic on each status poll) flips any `in_progress` whose `heartbeat_at < now - stale_after_sec` to `failed:stalled` (a SIGKILLed spot-GPU worker becomes terminal, not eternal). The lease serializes sidecar/index builders.

**Freshness token**: a derivative's freshness is the **GCS object generation** of its base captured at build time vs. current. `resolveSidecar`/`resolveIndex` treats a generation mismatch (or a bumped schema version) as not-fresh and triggers a rebuild under lease (clean forward migration, no manual backfill).

### 3.4 The typed guidance-code vocabulary (owned by Campaign B; consumed by C, D, E, F)
Whitespace-free `<state>:<imperative>` codes, driven by string-match classification of the thrown error/status, **NOT by row count**. This is the single error->code map.

```js
export const ERROR_CODE_MAP = [
  { match:/524|gateway time-?out|cold|full[- ]?scan|warm/i,
    guidanceCode:'source_unavailable_cold_mount:retry_after_warm', readiness:'retry',   sourceState:'consulted_but_unavailable' },
  { match:/not mounted|gcsfuse|no such file|ENOENT.*gcsmnt/i,
    guidanceCode:'needs_mount:heal_route_then_retry',             readiness:'retry',   sourceState:'consulted_but_unavailable' },
  { match:/consent|revoked|403|forbidden|bionft|bloom/i,
    guidanceCode:'blocked_missing_consent:ask_user_for_bionft_grant', readiness:'blocked', sourceState:'consulted_but_unavailable' },
  { match:/reference|hs37d5|assembly(19|38)|missing ref/i,
    guidanceCode:'needs_reference:upload_build_ref_to_gcs',       readiness:'blocked', sourceState:'consulted_but_unavailable' },
  { match:/contig|build mismatch|b37.*hg38|hg38.*b37|chrom/i,
    guidanceCode:'build_mismatch:resubmit_with_correct_assembly', readiness:'retry',   sourceState:'consulted_but_unavailable' },
];
// fail-safe default -> 'source_unavailable_cold_mount:retry_after_warm' (never a negative)
```
Plus `scope_out_of_assay:do_not_infer_negative` (emitted by `outOfScopeForInput`). Campaign D's build-mismatch path, Campaign A's cold-mount path, and Campaign F's consent-timeout path all map into this same vocabulary so the agent ask is uniform.

### 3.5 The tool-catalog JSON-fragment schema (owned by Campaign E; consumed by F, MCP)
One `*.verb.json` per verb, colocated with the command, is the single source of truth feeding `biofs --help`, the MCP `tools/list`, and the build-failing referential-integrity check. Catalog `schema_version` is its own value (the cli<->node<->mcp contract), independent of each repo's npm version.

```jsonc
{
  "schema_version": "1.0.0",
  "verb": "annotate submit",
  "summary": "Submit an OpenCRAVAT annotation job for a biosample serial.",
  "privacy_scope": "clinical",          // clinical | public (gates name-redaction + SKILL.md tier)
  "mutating": true,
  "external_io": ["gcs", "sequentia"],  // gcs | sequentia | story | none
  "data_access": "derivative-write",    // none | read | derivative-write | germline-read
  "dependencyContract": {
    "endpoint": "/agent/submit_cravat", // the LIVE biofs-node route this verb is a thin client of
    "method": "POST",
    "min_node_schema": "1.0.0",
    "consent_surface": "bionft"         // bionft | bloom | admin-bypass | none (moat hook; descriptive, real gate stays verifyConsent)
  },
  "produces": ["opencravat.sqlite"],
  "requires": ["vcf"],
  "start_when": ["have:serial", "have:vcf"],
  "not_for": ["acmg-classification", "germline-variant-calling"],   // routing guardrail returned AS DATA
  "use_instead": { "acmg-classification": "cohort-acmg", "germline-variant-calling": "job recall" },
  "next_actions": [
    { "verb": "annotate status", "args": { "oc_job_id": "{{oc_job_id}}" }, "when": "submitted" },
    { "verb": "cohort-acmg", "args": { "serials": "{{serial}}" }, "when": "done" }
  ]
}
```

Lifecycle states the schema gate returns: `current` (semver major ==), `needs_reparse` (node catalog older; client refetches), `too_new` (node catalog newer than client can parse; client must upgrade).

### 3.6 The dist-only-commands build guard (shared hardening, all TS repos)
`npm run build` can silently strip compiled verb/tool registrations from `dist/index.js` (already cost rrm-*/cohort-*/fourier-score/variants in prod). Every TS repo gets a **self-validating catalog check that makes the build FAIL (non-zero exit)** if a registered verb/tool is missing from the built `dist/index.js`. biofs-cli: assert every `src/commands/*` (or every entry in the canonical `src/verbs.json`) has a registration in `dist/index.js`. mcp-bio-context: assert every `TOOLS[].name` has a `case` in the dispatch switch. The validator must scrape registrations from BOTH `src/index.ts` AND the built `dist/index.js`, and accept an allowlist of known dist-only verbs (per `/tmp/recover_stripped_verbs.py`) until their source is restored on prod. This is implemented most completely in Campaign E (the catalog generator + `assert-dist-catalog.mjs`); Campaigns A, C, F each add a lighter `validate-commands.mjs` as an interim until E lands, then converge on E's version.

---

## 4. Campaigns

### Campaign A — Kill the cold-462MB-sqlite 524

**Goal.** Remove the user-visible 524 in two layers: (a) the request path returns `{status:"in_progress", job_id}` in <1s and polls, with per-`(biowallet, sha256(verb,serial,sorted-params))` dedup so a 524-retry rejoins the in-flight job; (b) eliminate the scan via a biofs-node-managed sidecar sqlite (3.2) so warm queries hit an indexed file and return ~2s.

**File-by-file changes.**

*Prod Python analyzer (`api_biofs_fuse.py`, re-verify path):*
- MODIFY the gene/region/so/max_af handler: open the sqlite read-only/immutable/nolock (3.2 `open_ro`), prefer the sidecar when present and fresh (resolver path/URI passed in the job spec by biofs-node), else fall back to the base db with hardened pragmas. Add `table_exists` guard via `sqlite_master`.
- Known-loci queries: build an in-memory TEMP table and JOIN (member 5), never ATTACH a second gcsfuse db.
- NEW `build_sidecar(base_sqlite_path, dest_path)` (member 2), the DDL in 3.2, invoked **by biofs-node off the request path** (never inline in a query).

*biofs-node:*
- NEW `src/lib/query_jobs.js`: the `query_jobs` collection (3.3), `submitOrJoin`, `markHeartbeat`, `sweepStalled`, `getStatus`.
- NEW `src/lib/sidecar.js`: `resolveSidecar(baseBiocid)` (GCS-generation freshness), `ensureSidecar({baseBiocid,baseGsUri,ownerWallet})` (acquire Mongo lease keyed `sidecar:<serial>:v<SCHEMA>`, run the Python build off-path, register child), `registerSidecarChild(...)` reusing `cravat_mint.js`'s `registerSqliteInInventory` pattern with `hierarchy_role='derivative'`, `parent_biocid`, `filetype='opencravat_sidecar'`, `base_object_generation`, `sidecar_schema_version`, then `registerBioAssetIfMissing` so the sidecar inherits the **same revocable consent surface** as the base db, and queue ClaraJob anchoring (`chain_status='PENDING_MINT'`).
- MODIFY `src/index.js`: `initMongo()` add `query_jobs` (unique index on `dedup_key`) + lease collection; NEW routes `POST /agent/query/submit` (consent gate via existing `verifyConsent` -> `submitOrJoin` -> kick worker if new -> return `{query_job_id,status:"in_progress"}` in <1s), `GET /agent/query/status`, `POST /agent/query/heartbeat`; start `setInterval(sweepStalled, 20_000)` in the main entry. The worker the submit route kicks: `ensureSidecar` then call the analyzer **with the sidecar path**, bump heartbeat throughout, write result (inline if small, else `gs://` fragment in the same AES-256 prefix), set `done`.

*biofs-cli:*
- MODIFY `src/lib/api/fuse-client.ts`: extend `FuseVariantsResponse` (already has `job_id`, line 61) status union to include `"in_progress"`; add `querySubmit(verb, serial, wallet, signature, params)` and `queryStatus(queryJobId)` hitting the new routes.
- MODIFY `src/commands/variants.ts` (mirror in `cohort-acmg.ts`, `fourier-score.ts`): wrap `api.variants(...)` (179-200) in a submit->poll loop reusing the 5s/15s idiom from `annotate/status.ts:80-95`. Keep the legacy direct call as a fallback when the node answers synchronously (back-compat). Each poll is a fast call, so the 524 cannot occur.
- Add the interim `validate-commands` fail-on-missing (3.6).

**Data shapes.** `query_jobs` (3.3); sidecar DDL (3.2); sidecar inventory child carries `parent_biocid`, `sample_serial`, `originlab`, `owner_wallet`, `base_object_generation`, `sidecar_schema_version` (no UNKNOWN).

**Back-compat.** Additive only. A prod node lacking `/agent/query/*` 404s the submit; the CLI catches that and calls the legacy `variants` path unchanged. `submit_cravat`/`cravat_complete_hook`/`oc_jobs`/existing inventory rows untouched; the sidecar is a new derivative child; the base 462MB db stays immutable. Bumping `SIDECAR_SCHEMA_VERSION` triggers a clean rebuild under lease.

**Within-campaign sequencing.** (1) read-only hardening + `sqlite_master` guard + pragma split (S, standalone safety); (2) submit-then-poll + dedup (node + CLI) — **kills the user-visible 524 even before the sidecar exists**; (3) heartbeat + `sweepStalled` (depends on 2); (4) sidecar build + lease + inventory child + anchor + GCS-generation freshness (depends on 2 and 1); (5) in-memory temp-table loci joins.

**Tests.** Unit: `dedupKey` stable under param reorder; `submitOrJoin` concurrent same-key -> one insert; `sweepStalled` flips stale only; `resolveSidecar` stale on generation mismatch; lease second-claim fails. Python: `open_ro` rejects writes; `build_sidecar` on a tiny fixture yields correct `is_variant`/`end`/`chrom_sort` + 5 partial indexes (EXPLAIN QUERY PLAN shows index use). E2E (via the verb): cold `biofs variants <serial> --gene KRAS` returns rows after background build with **no 524**; concurrent re-run joins the same `query_job_id` (assert row count == 1); warm run ~2s on sidecar; kill worker mid-build, wait > `stale_after_sec` -> `failed:stalled`, re-run succeeds.

**Effort.** Hardening S; submit-poll+dedup M; heartbeat S; sidecar L; loci-join S; build guard S. **Ship first: submit-then-poll + dedup** (alone removes the 524).

---

### Campaign B — Evidence honesty as an enforced contract

**Goal.** Make honesty a typed contract (3.1, 3.4) assembled and validated at biofs-node's result chokepoint so an incomplete materialization can never read as a negative finding, and force the agent surface to read `finding_state`/`answer_readiness` instead of `count`.

**File-by-file changes.**

*biofs-node (the authority):*
- NEW `src/lib/evidence_envelope.js`: the envelope type (3.1), the constructors (gate-forcing), `ERROR_CODE_MAP` + `classifyError` (3.4), `validateEnvelope` (four invariants).
- NEW `src/lib/derive_default_envelope.js`: `withEvidenceContract(legacyFn, ctx)` — the contract-floor wrapper that retrofits any un-migrated verb for free (zero rows -> `empty_consulted_scope`, never `true_negative_supported`; a thrown cold-524 -> `materialization_incomplete/retry`).
- MODIFY `src/index.js`: `sendJson` (866-869) gains an optional 4th `envelope` param; `/agent/cravat_status` (1429-1450) attaches `emptyConsultedScope` on `done`+`n_variants===0` and `classifyError->materializationIncomplete` on failure/cold/mount/consent error.
- MODIFY (optional) `src/lib/cravat_mint.js:111`: bump `scanner_version` to `biofs-node-v0.5.0`, add `evidence_contract_version:1`.

*Prod Python analyzer (re-verify route location):* wherever `/variants` and `/cohort_acmg` execute the sqlite read, wrap in `withEvidenceContract` with real `sources` resolved from `bioroutes.inventory` (biocid + sample_serial, never UNKNOWN). The `scopeProbe` checks `base__hugo` membership/build to distinguish `out_of_scope_for_input` from `in_scope_empty`. The `negative_support` triplet is filled by querying the sqlite `sample` table for a genotype row + the annotator manifest for library coverage; only then may `trueNegativeSupported` fire.

*mcp-bio-context (read-side enforcement):*
- MODIFY `handle_bio_run_skill` (714-774) and `handle_bio_load_manifest` (549): wire a `honestyGuard(result)` that, when `negative_inference_permitted !== true` and `finding_state !== 'positive_findings'`, injects an `__agent_directive` forbidding a clinical negative and routing the agent per `answer_readiness` (retry/blocked/inconclusive). No-ops when the envelope is absent (back-compat).
- MODIFY the `bio_run_skill` tool description: "Returns `evidence_envelope`; a zero-result is NOT a clinical negative unless `negative_inference_permitted=true`."

*biofs-cli (display only, no honesty synthesis):*
- MODIFY `variants.ts`, `cohort-acmg.ts`, `annotate/status.ts`: when `evidence_envelope` is present, render a banner before rows and set the **exit code from the envelope, not from row count** (`materialization_incomplete`+`retry`->7, `+blocked`->8, `empty_consulted_scope`->0 with "NOT a clinical negative", `true_negative_supported`->0 with "callable+covered+genotyped"). `--json` passes the envelope through untouched. The CLI never constructs an envelope.

*clinical_acmg.py (analyzer):* no envelope logic in the analyzer; the only ask is that it return a structured `{coverage:{callable,covered,genotyped}}` block so biofs-node can fill `negative_support` honestly.

**Back-compat.** Un-ported verbs flow through unchanged; `honestyGuard` and the CLI banner no-op when the envelope is absent. The contract floor (`withEvidenceContract`) is a ~5-line diff that instantly yields a conservative valid envelope; a verb is "fully migrated" only when it also supplies the `negative_support` triplet. The envelope is a new key alongside `{columns,rows,count}`. schema_version: envelope `1` in-band; biofs-node 0.4.4->0.5.0; mcp 0.2.0->0.3.0; CLI minor bump off the real prod version; inventory rows gain `evidence_contract_version:1`.

**Within-campaign sequencing.** (1) `evidence_envelope.js` (pure, no deps) — **ship first, the single source of truth**; (2) `derive_default_envelope.js`; (3) `sendJson` guard + `/agent/cravat_status` envelope; (4) `/agent/variants`+`/agent/cohort_acmg` wrap (prod re-verify); (5) mcp `honestyGuard` + tool desc (parallel after 1 frozen); (6) CLI display + exit codes (last).

**Tests.** Unit: `validateEnvelope` rejects illegal negative; `trueNegativeSupported` with incomplete triplet downgrades to `empty_consulted_scope`; `classifyError` maps 524/not-mounted/consent-revoked correctly; rejects `/unknown/i` biocid and whitespace guidance codes; `withEvidenceContract` floor + cold-524. mcp: `honestyGuard` injects directive / no-ops / passes positive through. E2E: cold `biofs variants <serial> --gene KRAS --json` -> `materialization_incomplete`/`retry`/`source_unavailable_cold_mount:retry_after_warm`/`negative_inference_permitted:false`, CLI exit 7 (raw `count` may be 0, envelope forbids the negative); warm -> `positive_findings`; out-of-assay gene -> `out_of_scope_for_input`+`scope_out_of_assay:do_not_infer_negative`; via MCP, cold sample's `bio_run_skill` carries `__agent_directive` (the liability-shield proof).

**Effort.** envelope module M; floor wrapper S; sendJson+cravat_status S; query-route wrap M; scanner bump S; honestyGuard S; CLI banner M; prepublish dist guard S. **Ship first: `evidence_envelope.js`.**

---

### Campaign C — Clinical correctness (changes answers, not ergonomics)

**Goal.** Make `biofs clinical` + `biofs cohort-acmg` (and the shared `variants` primitive) answer locus-first, support-gated, and deterministic. Five members: (C1) rsID->coordinate->genotype-by-locus bridge; (C2) gVCF reference-block wild-type fallback; (C3) genotype-support gate + ACMG PS/PM precondition; (C4) deterministic best-record tie-break; (C5) HPO-density tie-break + forced `NEEDS_CLINICAL_CONFIRMATION`.

> The answer-changing logic lives in the prod Python analyzer behind `api_biofs_fuse`, reached by thin CLI verbs. Re-verify exact prod filenames/lines before patching.

**File-by-file changes.**

*Prod analyzer (the core):*
- NEW `production_api/clinical_acmg/locus_resolver.py` (C1): resolve rsID -> `(chrom,pos,ref,alt[])` for the sample's assembly from a GCS-mounted coord sqlite (`reference/dbsnp/<assembly>/rsid_coord.sqlite`, never downloaded), then query the sample sqlite BY LOCUS. Emits `allele_probe` and `locus_probe` per rsID. Stops filtering on `clinvar__id`.
- NEW `production_api/clinical_acmg/genotype_support.py` (C3+C4): `classify_support(row,profile)` over per-assay thresholds (wes/panel/amplicon; DP/GQ/PASS) returning `supported|weak|no_call|not_checked` (None row -> `not_checked`, never a silent pass); `best_record(rows)` total order `(PASS first, -DP, -GQ, chrom, pos, ref, alt)` so the same sample yields the same ClaraJobNFT result hash. ACMG precondition wired into `clinical_acmg.py`: no PS*/PM* unless `support_status=='supported'`, else `withheld_codes` + `withhold_reason`.
- NEW `production_api/clinical_acmg/refblock.py` (C2): `query_refblock(conn,chrom,pos,profile)` finds a reference-block row whose `[pos,end]` covers `pos`. **Hard dependency on Campaign A's sidecar `end` column** (3.2); until A ships, returns `not_checked` (graceful, additive, never wrong). The only legitimate `true_negative` path.
- NEW `production_api/clinical_acmg/hpo_discriminator.py` (C5): `hpo_overlap_density`, `discriminate(candidates, patient_hpo, eps)` re-ranks near-tied diagnoses by density; if still tied -> `NEEDS_CLINICAL_CONFIRMATION` + a `discriminating_hpo` table.
- MODIFY `api_biofs_fuse.py` `/variants` and `/cohort_acmg`: add `rsid` (CSV) and `assay_profile` params; when `rsid` present, resolve+probe by locus; each row gains `support_status`; reduce via `best_record`; add `reference_block` per probed locus; **keep the existing gene/region/so/clinvar path byte-for-byte when `rsid` absent**. cohort-acmg never counts a `not_checked`/`weak` finding as a positive ACMG hit. Consent + signature gate unchanged.
- MODIFY `clinical_acmg/clinical_acmg.py`: wire all five; bump response `schema_version: "clinical-c1"`; add `diagnosis` block from C5.

*biofs-cli:*
- MODIFY `variants.ts` (+`fuse-client.ts`): add `--rsid <csv>` and `--assay-profile <wes|panel|amplicon>` (default wes) passthrough; render `SUPPORT` and `RSID_PROBE` columns.
- MODIFY `cohort-acmg.ts`: add `--assay-profile`; **exclude non-`supported` findings from the tally**, surface `withheld_findings`; update the methodology prose.
- MODIFY `clinical.ts`: add `--rsid`/`--assay-profile`; render `diagnosis.call` (highlight `NEEDS_CLINICAL_CONFIRMATION` + `discriminating_hpo`) and per-finding `support_status`/`withheld_codes`.
- NEW interim `validate-commands.mjs` build guard (3.6).

*biofs-node:*
- MODIFY `/agent/submit_cravat` oc_jobs insert: persist `assay_profile` (default wes) and `emit_refblock` so the CRAVAT worker retains reference-block intervals (with `end`) and per-call DP/GQ/FILTER (feeds C2 + C3); add `analyzer_schema:"clinical-c1"` to the inventory row.
- `sqlite_biocid.js`: comment-only note that result-hash stability now depends on `best_record`'s total order.

*mcp-bio-context:* MODIFY `handle_bio_run_skill` to thread `rsid`/`assay_profile` into the job body for `clinical_acmg`/`variants` skills; consent gate (`requireSession`, `skillsAllow/skillsDeny`) stays the authority.

**Response additions** (additive per finding): `support_status`, `support_detail{dp,gq,filter,assay_profile}`, `reference_block_wild_type`, `rsid_probe{rs334:{allele_probe,locus_probe}}`, `acmg{assigned,withheld_codes,withhold_reason}`; top-level `schema_version:"clinical-c1"` + `diagnosis` for `/clinical_acmg`.

**Back-compat.** Every change gated on a new optional param; absent -> identical existing code path. New-CLI/old-server: new fields `undefined`, support gate degrades to "treat as supported" (no false withholding) — confirm degradation direction on prod. No data migration; old sqlites lacking DP/GQ/refblock.end yield `not_checked`/`reference_block_wild_type:false`, never silently passed or re-downloaded.

**Within-campaign sequencing.** (1) **C3+C4 as one PR** — highest leverage, zero external dep, closes the silent-pass hole + makes the result hash reproducible + establishes `support_status` the rest decorate; (2) C1 (needs coord-sqlite uploaded to GCS first); (3) C2 (**blocked on A's `end` column**; build now, degrades to `not_checked`); (4) C5 last (needs HPO disease-annotation table in GCS).

**Tests.** Python pytest on tiny fixtures: support thresholds per profile; `best_record` is a total order (shuffle 100x -> identical winner, proves C4); rs334->HBB for hg38/b37; refblock with `end` -> wild-type, without `end` -> `not_checked`; HPO density tie-break + forced confirmation; PVS1+PM2 with `weak` -> PM2 withheld. Determinism: analyzer run twice on a fixture -> byte-identical findings JSON -> identical SHA-256. E2E via verbs (non-clinical-scope smoke serial): `biofs variants <serial> --rsid rs334 --assay-profile wes --json`; `biofs cohort-acmg --serials ... --assay-profile wes` shows `withheld_findings>0`; `biofs clinical ... --assay-profile wes` shows per-finding support + possible `NEEDS_CLINICAL_CONFIRMATION`.

**Effort.** C3 M; C4 S; C1 M; C2 M (blocked on A); C5 L; build guard S; MCP passthrough S. **Ship first: C3+C4.**

---

### Campaign D — Input truth over filenames (b37/hg38 + no-UNKNOWN)

**Goal.** Make the input the source of truth for genome build, chromosome-naming style, and input type: content-sniff format (a gVCF must contain a real `<NON_REF>` DATA record, not just a header line), infer build from `@SQ` MD5/length (demoting the chr-prefix heuristic), sniff chrom style once per mount and fan out the JOIN, echo + on-chain-anchor every assumed default with provenance, and stamp resolver truth into `bioroutes.inventory`. Plus a bounded preflight verb and GCS-mounted (never copied) liftover staging.

> Architectural correction the implementer must hold: members 1/2/4 (sniff, @SQ build, defaults echo + anchor) are biofs-node JS; members 3/5/6 (chrom JOIN fan-out, bounded preflight, liftover staging) are the prod Python analyzer. `api_biofs_fuse.py` is prod-only; pull via scp first. `route_mount.py` (local at `/Users/danieluribe/Downloads/biorouter-contracts/scripts/bioroutes/route_mount.py`) is the single source of truth for the resolved mount; chrom-style cache keys on that path.

**File-by-file changes.**

*biofs-node (members 1, 2, 4):*
- NEW `src/lib/input_truth.js`: `detectFormat(gsUriOrPath)` (gzip/bcf/cram/bam magic + content sniff for a real `<NON_REF>` DATA record -> `input_type='gvcf'`, `absence_claims_allowed=true`; header-only NON_REF != gvcf), `detectBuildFromSQ(headerText|sqLines)` (priority: @SQ MD5 -> @SQ length signature -> contig-set signature -> chr-prefix heuristic DEMOTED last; UCSC hg19 is chr-prefixed too), `resolveInputTruth({gsUri,headerText,indexCounts,contextHint})` orchestrator. Reads bounded byte ranges via `gcloud storage cat` (GCS-only, never full files, never to laptop). Ships a static `KNOWN_BUILD_SIGNATURES` table (re-verify MD5s against the reference FASTAs in `gs://deepvariant-fastq-to-vcf-genobank-app/reference/`, do not hand-type).
- MODIFY `src/index.js` `/agent/submit_cravat` (1316-1383): replace `assembly: p.assembly || 'hg38'` with detected truth; build `defaults_applied` (each value carries `{value,source,confidence}`); **422 hard-fail** if build is genuinely undetectable AND no `--assembly` override (no UNKNOWN/placeholder); thread detected values + `resolver_truth` + `defaults_applied` into the oc_jobs row; add `defaults_applied`+`resolver_truth` to the 202 response body so the agent sees the assumed build before the worker finishes.
- MODIFY `src/lib/cravat_worker.js`: pass `ASSEMBLY`/`INPUT_TYPE` into the worker env (re-verify the worker image entrypoint reads it).
- MODIFY `src/lib/cravat_mint.js`: stamp `genome_build`, `build_source`, `input_type`, `absence_claims_allowed`, `chrom_style`, `resolver_truth`, `truth_schema_version:'input_truth.v1'` into the inventory row; bump `scanner_version` to `biofs-node-v0.5.0`.
- MODIFY `src/index.js` `anchorJobOnChain` (351-445): fold `resolver_truth`+`defaults_applied` into the manifest patch so the assumed build/reference/annotator with its source becomes part of the immutable ClaraJobNFT anchor (a wrong-build job is provably auditable before any consumer trusts the sqlite). Reuse the existing manifest-patch path; no new contract.

*Prod analyzer (members 3, 5, 6):*
- MODIFY `/variants` (+`/cohort_acmg`,`/cohort_fourier_score`) SQL builder (member 3): replace `WHERE base__chrom = ?` with a candidate fan-out (`chr1<->1`, `M<->MT<->chrM`, X/Y both styles) + `WHERE base__chrom IN (?,...)`; `chrom_style_for(sqlite_path,conn)` sniffs once per resolved mount, caches in a module dict, and writes the style back into the inventory row (completing member 4).
- MODIFY `/cohort_acmg` + gVCF filters (member 3b): gate any wild-type inference on `absence_claims_allowed` read from the inventory row, never on row-count.
- NEW `/preflight` handler (member 5): wallet-sig verify, route_mount resolve, header read + `SELECT * FROM variant LIMIT 100` in **natural order (never ORDER BY** — that full-scans the index-less 462MB sqlite -> the documented 524), return `is_gvcf, est_variant_count, n_fail_rows, chrom_style, genome_build, columns_present`.
- NEW liftover staging into a temp table (member 6): only when requested build != cache build; chain files mounted from GCS (`reference/chain/`), never copied; stage lifted coords into a shape-identical temp table with dual-coordinate provenance (`src_chrom/src_pos`, `lifted_chrom/lifted_pos`, `lift_status`, `needs_ref_allele_recheck`); dropped rows reported, never silently omitted. Re-verify pyliftover/`liftOver` availability + chain files on prod.

*biofs-cli (members 4 echo + 5 verb):*
- MODIFY `src/commands/annotate/submit.ts`: render `defaults_applied` (build value/source/confidence; a yellow warning when `source==='context_default'`); add `--assembly` passthrough.
- NEW `src/commands/preflight.ts` + register: `biofs preflight <serial>` (thin client over `/preflight`); add to the catalog so a strip fails the build.
- MODIFY `src/lib/api/fuse-client.ts`: add `preflight()` mirroring `variants()`.

*mcp-bio-context (member 4 surface + Nebula strip):*
- MODIFY `handle_bio_resolve` (635-668): attach the inventory `resolver_truth` block to the resolved-asset payload (`genome_build`, `input_type`, `absence_claims_allowed`, `build_source`) so an agent knows the build before calling a skill. The MCP stays thin; it does not sniff.
- STRIP any Nebula provider signature, `##source=Nebula` special-case, or Nebula-specific contig assumption inherited from Genomi; replace provider-keyed branches with the content-sniff path. Nebula must not appear in code, comments, or the build-signature table.

**Resolver-truth block** (the canonical shape stamped everywhere): `{format, input_type, absence_claims_allowed, genome_build, build_source (never null; "context_default" is the explicit fallback), build_confidence, chrom_style, evidence{magic_hex,has_non_ref_record,n_index_contigs,sq_md5_matched}, schema_version:"input_truth.v1"}`.

**Back-compat.** Additive only; explicit `--assembly` becomes a recorded `build_source:'caller'` instead of a silent override. Legacy sqlite rows with no `chrom_style` trigger the sniff-once path (back-fills it); rows without `resolver_truth` have null truth fields treated as "legacy, build unknown, do not assert absence." The 422 hard-fail triggers only on new work where build is genuinely undetectable AND no override.

**Within-campaign sequencing.** (1) **A1 `input_truth.js` + A4 inventory stamping** — the structural keystone every member reads from; kills the silent-default hg38 hardcode; (2) A2 submit_cravat wiring + 422; (3) B1 chrom fan-out + sniff-cache (parallel; self-heals legacy rows, completes member 4 by writing `chrom_style` back); (4) A5 on-chain anchor; (5) C1/C3/C2/B3 (CLI echo, preflight verb + handler); (6) B4 liftover + D1 MCP surface last.

**Tests.** Unit (input_truth): real gVCF with `<NON_REF>` DATA -> gvcf; header-only NON_REF -> NOT gvcf (the member-1 trap); UCSC hg19 @SQ -> hg19 not GRCh38 (chr-prefix demotion); b37 hs37d5 decoy -> GRCh37 via sq_md5; no signals -> `context_default`; idempotent. Python: `chrom_candidates('chr1')⊇{1,chr1}`, `('MT')⊇{M,MT,chrM,chrMT}`; chr-style sqlite queried with `1` returns rows (the silent-empty regression test); sniff-once cache. E2E via verbs: `biofs preflight <b37-serial>` reports GRCh37/ensembl without a full job; `biofs annotate submit <b37-serial>` 202 shows `defaults_applied.genome_build={value:GRCh37,source:sq_md5}` (not hg38), no context-default warning; `biofs variants <b37-serial> --region chr7:140453136` (UCSC query against Ensembl cache) returns BRAF V600 rows via fan-out, NOT "No variants match filters" (the single test that proves the campaign); ClaraJobNFT manifest contains `resolver_truth`.

**Effort.** input_truth.js L; submit wiring+422 M; worker env S; inventory stamp S; anchor M; chrom fan-out M; absence gating S; preflight M; liftover L; CLI echo S; preflight verb M; fuse-client S; MCP surface S; Nebula strip S. **Ship first: A1 + A4 (input_truth.js + stamping).**

---

### Campaign E — Self-defending verb/agent surface

**Goal.** Make the verb/tool surface introspect and police itself: one canonical per-verb fragment (3.5) feeds `--help`, MCP `tools/list`, and a build-failing referential-integrity check (curing the dist-only-commands trap, 3.6); routing guardrails (`not_for`/`use_instead`) returned as data; a `schema_version` lifecycle gate; `next_actions` self-chaining; a materialization manifest that flips to STALE on GDPR erasure; and a skill-gated single dispatcher collapsing the visible tool budget ~90->~18.

**File-by-file changes.**

*biofs-cli:*
- NEW `src/lib/catalog/schema.ts`: `interface VerbFragment` (3.5), `CATALOG_SCHEMA_VERSION='1.0.0'`, `LifecycleState`, `compareSchema(clientV,nodeV)`.
- NEW `src/lib/catalog/loader.ts`: `loadFragments()` (via a generated `manifest.generated.ts` so `tsc` cannot tree-shake), `assembleCatalog(fragments)`.
- NEW `src/lib/catalog/validate.ts`: `validateCatalog(frags, registered)` throws (exit 3) on dangling/stripped/duplicate/dead-dependencyContract/referential errors.
- NEW `scripts/build-catalog.mjs` (prebuild): globs `*.verb.json`, scrapes `src/index.ts` registrations, validates, emits `manifest.generated.ts` + `dist/catalog.json`. NEW `scripts/assert-dist-catalog.mjs` (postbuild): re-scrapes the **built** `dist/index.js` and re-runs the validator so a transpile-stripped registration FAILS the publish (the structural cure).
- MODIFY `package.json`: `prebuild`/`build`/postbuild wired; bump version off the prod base.
- MODIFY `src/index.ts`: global preflight (around 154-160) — for `clinical`/`mutating` verbs call `assertSchemaCurrent()` (GET `/agent/catalog/version`, apply `compareSchema`; `too_new`->exit 4; `needs_reparse`->refetch once); render the help/welcome verb list (2379-2399) from `assembleCatalog()`.
- NEW `src/commands/catalog.ts` + register `biofs catalog [--json] [--verb <v>]`.
- NEW one `*.verb.json` per command (hand-write the 7 clinical: annotate submit/status, variants, cohort-acmg, fourier-score, cohort-fourier-score, clinical; `--stub-missing` auto-stubs the rest as `public/non-mutating`).
- MODIFY verb implementations (start `annotate/submit.ts`) to emit `next_actions` with `{{serial}}`/`{{oc_job_id}}` substituted from the node response.

*biofs-node:*
- NEW `src/lib/catalog.js`: `CATALOG_SCHEMA_VERSION`, `loadCatalog()` (reads the `dist/catalog.json` shipped from the CLI into the node's asset path; reload on SIGHUP), `routeAllowlist()`.
- NEW routes (near workspace routes ~972, `sendJson` pattern): `GET /agent/catalog`, `GET /agent/catalog/version` `{schema_version,node_version,generated_at}`, `GET /agent/catalog/routes`.
- MODIFY `cravat_mint.js` `registerSqliteInInventory`: add a `materialization` sub-doc `{status:'MATERIALIZED', gs_uri, object_name, size_bytes, verified_at, schema_version}` (no new download; `dest_gs_uri` is already known).
- NEW `src/lib/materialize.js`: `verifyMaterialized(gsUri)` via `gcloud storage ls --json` (metadata only, NOT cp; reuse the `spawnSync('gcloud',...)` pattern 357-367).
- MODIFY `/agent/cravat_status` (1429-1452): before returning a `done` job, `verifyMaterialized(row.dest_gs_uri)`; if missing, set `row.status='stale'` + inventory `materialization.status='STALE'` (GDPR-erasure/lifecycle path); add `sample_serial` + a substituted `next_actions` array. The materialization check runs **only after** the existing consent gate, never as an alternative to it.

*mcp-bio-context:*
- NEW `src/skill_gate.ts`: keep `tools/list` tiny (base tools + one `bio_invoke`); `bio_invoke(capability,args,skill_ack?)` looks up the capability in the catalog from `GET /agent/catalog`; clinical/mutating capabilities without a matching `skill_ack` (catalog `skill_doc` hash) return `{status:'needs_skill', skill, skill_uri, why}`; once acked, dispatch to the verb's `dependencyContract.endpoint`.
- MODIFY `src/index.ts`: add `bio_invoke` to TOOLS + a `case` in the switch (~947); routing guardrail as data (`{status:'wrong_tool', not_for, use_instead}` when `args.intent` in `not_for`); schema gate (poll `/agent/catalog/version` every 60s; `too_new`->`mcp_upgrade_required`, `needs_reparse`->refetch).
- NEW `src/catalog_client.ts`: `getCatalog()`/`getCatalogVersion()` pointed at `BIOFS_NODE_BASE`.
- NEW `skills/*.SKILL.md` (7 clinical): the gate token (`skill_doc` hash) that unlocks each capability for a remote agent.

**Back-compat.** Un-ported verbs auto-stubbed as public/non-mutating; the schema gate only fires for clinical/mutating. Strictly additive on the wire (`/agent/catalog*` new; `cravat_status` adds `materialization`/`sample_serial`/`next_actions`). The 90->18 collapse is opt-in via `BIOFS_MCP_SLIM=1` (default off until the SKILL.md set is complete). Catalog `schema_version` starts `1.0.0`; major bump makes older clients see `too_new`, newer clients see older nodes as `needs_reparse`.

**Within-campaign sequencing.** (1) **fragment schema + validator + prebuild generator + `assert-dist-catalog.mjs`** — the spine + the documented-failure cure, one repo, zero node/mcp dep, **ship first**; (2) node catalog routes + version endpoint; (3) CLI schema gate + dead-endpoint check; (4) materialization manifest + STALE flip; (5) `not_for`/`use_instead` guardrail-as-data (CLI+MCP); (6) `bio_invoke` skill-gated dispatcher + SKILL.md set (behind `BIOFS_MCP_SLIM`); (7) `next_actions` self-chaining.

**Tests.** Unit: validator exits non-zero on stripped/duplicate/dangling/bad-use_instead, passes clean; `compareSchema` current/too_new/needs_reparse; `verifyMaterialized` ls exit 0/1 -> exists true/false; skill_gate needs_skill/dispatch/wrong_tool. E2E: `npm run build` with a fragment deleted FAILS at `assert-dist-catalog.mjs` (proves the cure); `biofs catalog --verb fourier-score --json` returns `not_for`/`use_instead` (guardrail-as-data); `biofs annotate submit <serial> --wait --json` carries `materialization.status:"MATERIALIZED"` + substituted `next_actions`, then deleting the GCS object flips `biofs annotate status` to `stale`; with `BIOFS_MCP_SLIM=1`, `tools/list` returns ~18, `bio_invoke('cohort-acmg',...)` without `skill_ack` returns `needs_skill`; an old CLI against the new node still succeeds (back-compat).

**Effort.** schema+loader+validator M; prebuild generator + assert-dist L; per-verb fragments M; schema gate + dead-endpoint + catalog verb M; next_actions S; node routes + catalog.js M; materialization + materialize.js + STALE M; bio_invoke + catalog_client M; SKILL.md set S; guardrail-as-data S. **Ship first: prebuild generator + `assert-dist-catalog.mjs`** (cures the documented dist-strip failure).

---

### Campaign F — Standalone high-value (search, dashboard, research store, onboarding)

**Goal.** Four self-contained additive capabilities: a consent-gated multi-field FTS5 evidence search (BM25 + RRF), an offline self-contained HTML dashboard, a citation-disciplined research-finding store, and an onboarding/docs generator that unblocks the 42-lab rollout. Search runs server-side through biofs-node (zero genomic bytes on the laptop); the facet pre-filter is wired to real BioNFT/Bloom consent.

**File-by-file changes.**

*biofs-node (the engine):*
- NEW `src/lib/evidence_index.js`: the FTS5 DDL (one row per sample×gene×finding, `evidence_doc` + `evidence_fts` contentless-linked, facet columns indexed, `schema_version` in `evidence_meta`); per-field BM25 weights (`{gene:8, clinvar_sig:4, phenotype:2, so:1.5, evidence_blob:1}`) + RRF (K=60) over weighted streams (`streams[]` open-ended so a vector ranker drops in later with zero API change); `facetPreFilter(db,facets,ctx)` = AND-of-OR set intersection with a whitelisted facet-column set (no SQL injection), THEN `consentFilterDocs` (cheap `bloomMightDeny` pre-pass, then authoritative `verifyConsent` per surviving biocid — the real moat hook, NOT a local boolean; **fail-closed on BioRouter timeout**); `searchEvidence(...)` returns hits with per-hit `provenance.streams` + the consent decision.
- NEW `src/lib/evidence_index_build.js`: off-request build mirroring the `cohort_worker`/`cravat_worker` pattern; reads `bioroutes.inventory` for `filetype='opencravat'` in `--labs`/`--serials` scope; gcsfuse-mounts each OC sqlite; projects FTS columns; **no-UNKNOWN**: a row whose serial cannot be resolved via the fallback chain is skipped and counted (`skipped_no_lineage`), never written with a placeholder; writes one FTS5 sqlite to `gs://<vault>/_evidence_index/<scope_hash>/evidence_<schema_version>.sqlite` via `lab_paths` allocation; POSTs `/agent/search_build_hook`.
- MODIFY `src/index.js`: NEW routes `POST /agent/search_build` (202 `{build_id,scope_hash,dest_gs_uri}`), `GET /agent/search_build_status`, `POST /agent/search` (calls `verifyConsent` transitively via `facetPreFilter`, anchors per-hit provenance to the ClaraJobNFT audit, honors `CONSENT_ENFORCE` mode); NEW `/agent/research/{add,list,fresh}` upserting `bioroutes.research_findings` (`content_id = sha256(normalized_url+excerpt)`, `excerpt<=1600`, http(s) URL required); optional `/api_docs/map` (re-verify whether genobank.app already exposes a docs surface to extend).

*biofs-cli:*
- NEW `src/commands/search.ts`: `biofs search "<q>" --lab --clinvar --gene --so --limit [--json]` and `biofs search build --labs ...` / `--status`; `--weight gene=8,phenotype=2` overrides; no-UNKNOWN belt-and-suspenders check.
- NEW `src/commands/dashboard.ts`: `biofs dashboard --from-search "<q>" --lab ... --out report.html` — runs search server-side, emits one self-contained HTML file (inline-vendored runtime, no CDN, no `python -m http.server`, evidence as a `window.__BIOFS_EVIDENCE__` blob); template at NEW `src/templates/dashboard.html`; shows provenance + consent decision per row.
- NEW `src/commands/research.ts`: `biofs research add|list|fresh` (thin client to `/agent/research/*`; client-side guards mirror server validation).
- NEW `src/commands/onboard.ts`: `biofs onboard mcp|docs|doctor` — `mcp` writes an absolute npm-global bin path (`npm root -g` -> `@genobank/mcp-bio-context/dist/index.js`, never bare PATH-dependent), detects + overwrites stale version-bumped paths, and resolves the `~/.claude.json` vs `~/.claude/.mcp.json` footgun; `docs` generates `llms.txt`/`llms-full.txt` from one canonical DOCS table and re-links per-capability `SKILL.md` into the host skill dir on each bump; `doctor` reports stale paths + config-location issues.
- MODIFY `src/lib/api/fuse-client.ts`: add `search/searchBuild/searchBuildStatus/researchAdd/List/Fresh()`.
- MODIFY `src/index.ts`: register the four verbs.
- NEW `scripts/validate-commands.mjs` + `src/verbs.json` + `package.json` build wire (3.6) — **the single most important rollout hardening**; converges with Campaign E's catalog when E lands.

*mcp-bio-context:* MODIFY `src/index.ts` add `bio_search`/`research_add`/`research_list` tools + handlers (reuse `requireSession()` so the consent context is the real authenticated wallet); NEW `scripts/validate-tools.mjs` + build wire. No new SQLite in the MCP layer.

**Data shapes.** FTS5 `evidence_doc`/`evidence_fts` (`schema_version:'f.1.0'` in `evidence_meta`); `research_findings` `{content_id(_id), url, url_host, excerpt(<=1600), topic, tags[], added_by_wallet, signature, added_at, last_verified_at, schema_version:'f.1.0'}`; `/agent/search` response `{count, hits:[{sample_serial,biocid,gene,clinvar_sig,rrf,provenance}], schema_version}`.

**Back-compat.** Purely additive (new verb/route/lib/tool or append to an existing array). `schema_version:'f.1.0'` stamped independently in three places (index sqlite, research doc, search response) so they migrate independently; a future vector stream bumps only the index. Evidence index is immutable + scoped (rebuilds write a new `scope_hash`; old ones queryable until swept; GCS deletable, never IPFS). Search inherits `CONSENT_ENFORCE=off|shadow|on` (shadow logs but does not filter, so search can be validated against prod before consent goes live).

**Within-campaign sequencing.** (1) **`validate-commands.mjs` + `verbs.json` + build wire** — independent, one PR, protects every later verb from the silent-strip trap, the highest-leverage single change for the 42-lab rollout, ship first; (2) `evidence_index.js` + `evidence_index_build.js` + 3 search routes (the engine); (3) `search` verb + fuse-client; (4) `dashboard` (depends on search); (5) `research` (parallel with 3-4); (6) `onboard` + `/api_docs/map` + MCP tools last.

**Tests.** Unit: RRF deterministic K=60; facetPreFilter exact candidate set; `consentFilterDocs` excludes denied biocids and a BioRouter-timeout doc (fail-closed); build skips serial-less rows into `skipped_no_lineage` (no-UNKNOWN); gene-boosted stream ranks gene-name hit above blob-only; `research add` rejects non-http(s) + truncates at 1600 + stable `content_id`; `onboard mcp` writes an absolute path + rewrites a stale `@…@oldver` entry + picks the correct config file; `validate-commands.mjs` exits non-zero on a removed registration. E2E (prod with `CONSENT_ENFORCE=shadow` first): `biofs search build --labs augenomics` -> done with `n_docs>0` + reported `skipped_no_lineage`; `biofs search "BRCA2 pathogenic" --lab augenomics --clinvar Pathogenic,Likely_pathogenic --json` -> ranked hits with `sample_serial` (never UNKNOWN), `rrf`, `provenance.streams`, zero genomic bytes on laptop; `biofs dashboard --from-search ...` -> single offline file showing the consent decision; `biofs research add ...` + `biofs research fresh`; `biofs onboard mcp && biofs onboard doctor`; flip `CONSENT_ENFORCE=on` and re-run search -> hits for revoked biocids disappear (proves the pre-filter is live, not a boolean).

**Effort.** validate-commands+verbs.json S; evidence_index.js L; evidence_index_build + routes M; search verb + fuse-client M; dashboard + template M; research verb + routes M; onboard + docs + SKILL symlink M; MCP tools + validate-tools S. **Ship first: `validate-commands.mjs` + `verbs.json` + build wire.**

---

## 5. Global sequencing & milestones

A dependency-ordered roadmap. Each milestone is independently shippable; quick-wins are called out.

### Cross-campaign dependency graph (the load-bearing edges)
- **C2 (refblock wild-type) -> A's sidecar `end` column** (3.2). Land A's sidecar before C2 produces real wild-type evidence; until then C2 degrades to `not_checked`.
- **B (envelope shape, 3.1) -> A's cache key** (A's `query_jobs` dedup key doubles as C's cache key) and **-> C/F** (C decorates `support_status` onto the envelope; F's search and E's `cravat_status` carry the envelope/guidance vocabulary). B freezes the shape first.
- **3.4 guidance-code vocabulary** is the single ask-the-user language consumed by A (cold mount), B (the map), C, D (build mismatch), E (blocked consent), F (consent timeout).
- **D's `resolver_truth`/`chrom_style`** is read (not re-sniffed) by C (assembly per serial for rsID resolution) and by F/E.
- **E's catalog + dist-strip cure (3.6)** supersedes the interim `validate-commands.mjs` that A/C/F each add; they converge on E's `assert-dist-catalog.mjs` once it lands.
- **F's per-hit provenance write** should reuse E's materialization/audit sidecar rather than inventing a parallel ClaraJobNFT audit surface.
- Field-name collision guard: D owns `input_type/genome_build/build_source/absence_claims_allowed/chrom_style/resolver_truth`; A owns the sidecar child fields; E owns `materialization`; F owns `evidence_*`/`research_findings`. No overlap; record in a shared schema doc.

### Milestones
- **M0 — Read-only-sqlite hardening + envelope contract-floor (the safety floor).** Ship A's read-only pragma hardening + `sqlite_master` guard (pure safety, zero infra). Ship B's `evidence_envelope.js` (3.1) + `derive_default_envelope.js` (the contract floor) and freeze the shape. Quick-win: the pragma hardening is an immediate lock/crash-risk reduction on the existing hot path. Outcome: the envelope shape is frozen so every downstream campaign can build against it in parallel.
- **M1 — Background jobs + sidecar index = 524 dead.** Ship A's submit-then-poll + dedup (node + CLI) — **this alone kills the user-visible 524**, even before the sidecar exists. Then A's heartbeat/staleness sweep, then the sidecar build + Mongo-lease serialization + inventory child + GCS-generation freshness (warm queries -> ~2s). Wire B's `sendJson` guard + `/agent/cravat_status` envelope + the query-route wrap so the 524 case now reads as `materialization_incomplete/retry`, never a negative. Quick-win: submit-then-poll is the single highest-leverage operational fix in the whole plan. Outcome: the 524 is dead and an infrastructure timeout can no longer masquerade as a clinical negative.
- **M2 — Clinical correctness.** Ship C3+C4 (genotype-support gate + deterministic best-record) as one PR — closes the silent-pass ACMG hole and makes the ClaraJobNFT result hash reproducible. Then C1 (rsID locus bridge, after the coord-sqlite is uploaded to GCS), then C2 (refblock wild-type, cutover with A's `end` column), then C5 (HPO discriminator). Decorate `support_status` onto B's envelope. Outcome: answers are support-gated, locus-first, and deterministic.
- **M3 — Input truth.** Ship D's `input_truth.js` + inventory stamping (kills the silent hg38 default), then submit_cravat wiring + 422, then the chrom fan-out + sniff-cache (kills the silent-empty mismatch), then on-chain provenance anchor, then the preflight verb, then liftover + the MCP resolve-truth surface + the Nebula strip. Quick-win: the chrom fan-out fixes a documented silent-empty class with a small SQL change. Outcome: input is the source of truth; wrong-build jobs are auditable before the agent acts.
- **M4 — Self-defending surface.** Ship E's fragment schema + validator + prebuild generator + `assert-dist-catalog.mjs` (cures the documented dist-strip failure) — the interim `validate-commands.mjs` guards from A/C/F retire here. Then node catalog routes + version endpoint, CLI schema gate, materialization manifest + STALE flip, routing guardrails-as-data, the `bio_invoke` skill-gated dispatcher + SKILL.md set (behind `BIOFS_MCP_SLIM`), and `next_actions` self-chaining. Outcome: the surface introspects, polices, self-chains, and self-defends.
- **M5 — Search / dashboard / research / onboarding.** Ship F's `validate-commands.mjs`+`verbs.json` build wire first (converging with E's catalog), then the FTS5 engine + consent pre-filter, then `search`, `dashboard`, `research`, and finally `onboard` + the MCP tools. Quick-win: the build guard is a one-PR insurance policy against shipping a stripped verb to all 42 labs. Outcome: cross-sample search, a shareable offline dashboard, a disciplined research store, and one-command lab onboarding.

**Quick-wins (high value / low effort, can land out of order):** A's read-only pragma hardening; A's submit-then-poll (the 524 killer); B's `evidence_envelope.js`; C3+C4 (the result-hash + silent-pass fix); D's chrom fan-out; E's `assert-dist-catalog.mjs`; F's `validate-commands.mjs`.

---

## 6. Release & rollout

### npm bump / publish / prod-pull (per repo)
- **biofs-cli** (npm package `@genobank/biofs`). Edit source on master at `/home/ubuntu/biofs-cli` (re-verify it is ahead of local v3.6.0; npm-global is v3.11.0; prod ~v3.12.0 — bump from the REAL prod version, not 3.6.0). Run `npm run build` (must pass the dist-strip guard). `npm publish`. On prod: `npm install -g @genobank/biofs@<v>`. Across the campaigns the CLI lands roughly 3.12.0 -> 3.13.0 (B/C/D) -> further patch bumps (E/F); each campaign re-pins from the then-current prod version.
- **biofs-node** (not an npm package; deploy by file). Edit on master, bump `package.json` 0.4.4 -> 0.5.0. Deploy via the CLAUDE.md scp-backup workflow: backup each target (`src/index.js.bkp.<ts>`, `cravat_mint.js.bkp.<ts>`, etc.), scp the new `src/lib/*.js` + patched files, copy the CLI's `dist/catalog.json` into the node's asset path (re-verify the path), `sudo systemctl restart` the biofs-node unit (systemd on parabricks-gpu :8787 — re-verify the unit name) and `api_genobank_prod.service` as applicable.
- **Prod Python analyzer** (`api_biofs_fuse.py`, `clinical_acmg/*.py`). scp-backup workflow: `cp api_biofs_fuse.py.bkp.<ts>` first, scp down, edit locally with Read/Edit, scp up, add the new `clinical_acmg/*.py` modules, `sudo systemctl restart api_genobank_prod.service`. The new analyzer modules are import-isolated for clean revert.
- **mcp-bio-context** (npm package `@genobank/mcp-bio-context`). Edit on master, bump 0.2.0 -> 0.3.0, `npm run build` (must pass the tools validator), `npm publish`, on prod `npm install -g @genobank/mcp-bio-context@<v>`, then `biofs onboard mcp` rewrites the absolute bin path, restart the MCP. (npm token has 401'd before — stage the tarball and do not publish until Daniel approves.)

### The dist-only-commands guard (mandatory on every TS build)
Every TS repo's `build` script ends with a self-validating catalog check that **fails the build (non-zero exit)** if a registered verb/tool is missing from the built `dist/index.js` (3.6). biofs-cli uses E's `assert-dist-catalog.mjs` (and an interim `validate-commands.mjs` until E lands); mcp-bio-context uses `validate-tools.mjs`. The validator scrapes BOTH `src/index.ts` and `dist/index.js`, and accepts an allowlist of known dist-only verbs (rrm-*/cohort-*/fourier-score/variants/biowallet/cohort-acmg per `/tmp/recover_stripped_verbs.py`) until their source is restored on prod, so it does not false-flag those as stripped.

### 42-lab rollout via the onboarding runbook (Campaign F)
After the CLI and MCP are published and pulled on prod, roll to the 42 labs with `biofs onboard`:
1. `biofs onboard mcp` writes the absolute npm-global bin path (never PATH-dependent, survives launchd/cron), overwrites any stale `@…@oldver` path, and resolves the `~/.claude.json` vs `~/.claude/.mcp.json` config-location footgun.
2. `biofs onboard docs` generates `llms.txt`/`llms-full.txt` from the one canonical DOCS table and re-links per-capability `SKILL.md` into the host skill dir.
3. `biofs onboard doctor` verifies absolute paths + config location and reports any drift.
4. Roll out with `CONSENT_ENFORCE=shadow` first (search logs the consent decision but does not filter), validate, then flip to `on`. Re-run `biofs onboard mcp` after every CLI/MCP bump (the symlink target carries the versioned path so a bump invalidates and `onboard docs` repairs it).

### Rollback (per layer; every change is additive so rollback cannot corrupt state)
- **biofs-cli / mcp-bio-context**: `npm install -g @genobank/<pkg>@<previous>` on prod; the new verbs/tools/routes simply vanish and the CLI falls back to the legacy synchronous path; re-run `biofs onboard mcp` to repoint. For E's MCP collapse, `BIOFS_MCP_SLIM=0` un-collapses instantly without redeploy.
- **biofs-node**: restore the timestamped `.bkp` of `src/index.js` + `src/lib/*` and `systemctl restart`. The new routes disappear (CLI falls back); new Mongo collections (`query_jobs`, sidecar lease, `research_findings`) and additive inventory fields (`materialization`, `resolver_truth`, sidecar children) are inert/harmless if orphaned; the read path ignores unknown derivative children when the resolver is reverted. Drop `research_findings` and delete `_evidence_index/<scope_hash>/` prefixes (GCS, deletable) to fully reclaim. No on-chain rollback needed (anchors are append-only; a reverted node just stops writing the new manifest fields).
- **Prod analyzer**: `cp api_biofs_fuse.py.bkp.<ts> api_biofs_fuse.py`, remove the new `clinical_acmg/*.py` modules, `systemctl restart api_genobank_prod.service`. Sidecar files and the in-memory `_CHROM_STYLE_CACHE` die harmlessly. The lowest-risk rollback for Campaigns C/D is simply not passing `--rsid`/`--assembly`/`--assay-profile` — the default path is unchanged until defaults are flipped.

---

## 7. Risks & must-verify-against-prod list

1. **The clinical-read hot path lives in prod-only Python** (`api_biofs_fuse.py`, `clinical_acmg/clinical_acmg.py`) under `/home/ubuntu/Genobank_APIs/production_api/...`, not in biofs-node and not in any local clone. Pull via scp and re-verify exact filenames/line numbers before patching Campaigns A (read path + sidecar build call), B (query-route wrap), C (all five members), D (members 3/5/6). Patch only that file and keep it reachable only through the verbs; never add a direct-curl entry point; re-run through the verb.
2. **Version skew.** Local biofs-cli v3.6.0; npm-global v3.11.0; prod ~v3.12.0. biofs-node 0.4.4 local. mcp 0.2.0. Design at the structural level; re-pin from the real prod versions before bumping. Confirm `FuseAPIClient`/`API_CONFIG` still resolve `baseUrl` to `genobank.app` the same way.
3. **The dist-only-commands trap is live.** Some verbs (rrm-*/cohort-*/fourier-score/variants/biowallet/cohort-acmg) exist as compiled `dist/commands/*.js` ONLY with no source on prod. The validator must scrape both `src/index.ts` and the built `dist/index.js` and allowlist those until source is restored, or it will false-flag them and block the build. Run `/tmp/recover_stripped_verbs.py` against `/home/ubuntu/biofs-cli` first.
4. **CRAVAT column names** (`base__so`, `base__hugo`, `dbsnp__rsid`, `sample.dp/gq`, `base__uid`, `clinvar__sig`) MUST be re-verified via `PRAGMA table_info` on a real prod sqlite before trusting the sidecar build (A/3.2) or the FTS projection (F). CRAVAT module versions rename columns; absent columns emit NULL, never crash.
5. **Whether `/agent/variants` and `/agent/cohort_acmg` are biofs-node or analyzer routes.** They are absent from the local v0.4.4 clone; the CLI map shows them at `genobank.app`. Confirm where the sqlite query actually executes and wrap honesty/correctness there (B/C/D).
6. **Mongo lease, never flock.** All cross-VM coordination (sidecar builders, index builders, any future cohort batch) uses the Mongo lease (`workspace.js` `claimLease`/`releaseLease` or a dedicated lease collection), never a POSIX fcntl flock. Confirm whether the sweep runs on both genobank-production and parabricks-gpu (cross-VM).
7. **GCS object generation as freshness token.** Confirm the prod SA can read object-generation metadata for the vault buckets (A's sidecar staleness, F's index staleness).
8. **biofs-node systemd unit name + internal port** (was :8787 on parabricks-gpu) and the node's static asset path for `dist/catalog.json` (E). Confirm whether the same node code also runs on genobank-production.
9. **OC worker image entrypoint** — does it read `ASSEMBLY`/`INPUT_TYPE` (D/A3)? If not, the image needs a rebuild, not just env.
10. **Reference assets in GCS** — the rsID coord sqlite (`reference/dbsnp/<assembly>/`), the build MD5/length table (derive from the actual reference FASTAs in `gs://deepvariant-fastq-to-vcf-genobank-app/reference/`, never hand-typed), liftover chain files (`reference/chain/`) + the `pyliftover`/`liftOver` binary on prod, and the HPO disease-annotation table. Upload missing assets to GCS first (never to VM disk); all access stays NFT-gated via gcsfuse.
11. **`clinical_acmg.py` return shape** — confirm it can emit `{coverage:{callable,covered,genotyped}}` so biofs-node fills `negative_support` honestly (B); if not, the `clinical` verb stays at the contract floor until extended.
12. **Consent timeout fail-closed** — confirm `verifyConsent` calls in F's `consentFilterDocs` (and elsewhere) honor a 5-10s budget and EXCLUDE on timeout, never allow. Confirm `CONSENT_ENFORCE=shadow` semantics on prod before relying on shadow-mode validation.
13. **nginx proxy** — confirm the new `/agent/catalog*`, `/agent/query/*`, `/agent/search*`, `/agent/research/*`, `/preflight` paths are reachable through the existing `/api_biofs_node` -> `/agent/*` rule (same rule that exposes `/agent/workspace/*`); no new nginx config expected, but verify.
14. **No Nebula signature survives the port** (D2) — audit every ported detection/liftover path for Nebula provider strings, `##source=Nebula` special-cases, or Nebula-specific contig assumptions; remove all; Nebula must not appear in code, comments, or the build-signature table.
15. **Whether genobank.app already exposes a docs surface** to extend instead of adding `/api_docs/map` (F).
16. **npm publish token** has 401'd before — stage tarballs; do not publish until Daniel approves the wallet-signed/credentialed step.

---

## Appendix: technique -> file mapping table

| Campaign | Technique | Repo | File (NEW/MODIFY) | Anchor |
|---|---|---|---|---|
| A | submit-then-poll + dedup | biofs-node | NEW `src/lib/query_jobs.js` | `query_jobs`, `submitOrJoin` |
| A | submit-then-poll routes | biofs-node | MOD `src/index.js` | `/agent/query/{submit,status,heartbeat}`; `initMongo` 134-187; entry 1971-2009 |
| A | sidecar build + lease + child + freshness | biofs-node | NEW `src/lib/sidecar.js` | reuses `workspace.js` lease 243-286, `cravat_mint.js` 69-127 |
| A | read-only hardening + sidecar build DDL + loci join | analyzer | MOD `api_biofs_fuse.py` (+ `build_sidecar`) | `open_ro`, `hot` table (3.2) |
| A | submit->poll wrapper | biofs-cli | MOD `variants.ts`/`cohort-acmg.ts`/`fourier-score.ts`, `fuse-client.ts` | `api.variants` 179-200; FuseVariantsResponse line 61; poll idiom status.ts 80-95 |
| B | envelope type + constructors + error map + validator | biofs-node | NEW `src/lib/evidence_envelope.js` | shape 3.1, vocab 3.4 |
| B | contract-floor wrapper | biofs-node | NEW `src/lib/derive_default_envelope.js` | `withEvidenceContract` |
| B | sendJson guard + cravat_status envelope | biofs-node | MOD `src/index.js` | `sendJson` 866-869; cravat_status 1429-1450 |
| B | query-route honesty wrap | analyzer | MOD `api_biofs_fuse.py` | `/variants`, `/cohort_acmg` |
| B | honestyGuard + tool desc | mcp | MOD `src/index.ts` | `handle_bio_run_skill` 714-774; `handle_bio_load_manifest` 549 |
| B | envelope-driven banner + exit codes | biofs-cli | MOD `variants.ts`/`cohort-acmg.ts`/`annotate/status.ts` | display only |
| C | rsID locus bridge | analyzer | NEW `clinical_acmg/locus_resolver.py` | `resolve_rsid` |
| C | support gate + best-record | analyzer | NEW `clinical_acmg/genotype_support.py` | `classify_support`, `best_record` |
| C | gVCF reference-block wild-type | analyzer | NEW `clinical_acmg/refblock.py` | `query_refblock` (needs A's `end`) |
| C | HPO discriminator | analyzer | NEW `clinical_acmg/hpo_discriminator.py` | `discriminate` |
| C | rsID/assay-profile params + support fields | analyzer | MOD `api_biofs_fuse.py`, `clinical_acmg/clinical_acmg.py` | `/variants`, `/cohort_acmg`, `/clinical_acmg` |
| C | assay_profile/emit_refblock on oc_jobs | biofs-node | MOD `src/index.js`, `cravat_mint.js`, `sqlite_biocid.js` | submit_cravat 1316-1387; biocid det. |
| C | CLI flags + support render | biofs-cli | MOD `variants.ts`/`cohort-acmg.ts`/`clinical.ts`, `fuse-client.ts` | `--rsid`/`--assay-profile` |
| C | rsid/assay passthrough | mcp | MOD `src/index.ts` | `handle_bio_run_skill` 714-774 |
| D | format/build/input_type detector | biofs-node | NEW `src/lib/input_truth.js` | `detectFormat`, `detectBuildFromSQ`, `resolveInputTruth` |
| D | submit_cravat truth + 422 + 202 echo | biofs-node | MOD `src/index.js` | 1316-1383 (default 1375), 202 body 1419 |
| D | worker env passthrough | biofs-node | MOD `src/lib/cravat_worker.js` | env block |
| D | inventory truth stamp | biofs-node | MOD `src/lib/cravat_mint.js` | row 108, scanner_version 111 |
| D | on-chain provenance anchor | biofs-node | MOD `src/index.js` | `anchorJobOnChain` 351-445 |
| D | chrom fan-out + sniff-cache | analyzer | MOD `api_biofs_fuse.py` | `/variants` SQL builder; `chrom_candidates`, `chrom_style_for` |
| D | absence_claims gating | analyzer | MOD `api_biofs_fuse.py` | `/cohort_acmg` |
| D | bounded preflight (natural order) | analyzer | NEW `/preflight` handler | `LIMIT 100` no ORDER BY |
| D | liftover temp-table staging | analyzer | NEW (in `api_biofs_fuse.py`) | chain from GCS; dual-coord provenance |
| D | defaults_applied echo + preflight verb | biofs-cli | MOD `annotate/submit.ts`, NEW `preflight.ts`, MOD `fuse-client.ts` | `--assembly`, `preflight()` |
| D | resolver-truth MCP surface + Nebula strip | mcp + all ported | MOD `src/index.ts` | `handle_bio_resolve` 635-668 |
| E | fragment schema + loader + validator | biofs-cli | NEW `src/lib/catalog/{schema,loader,validate}.ts` | `VerbFragment` (3.5), `validateCatalog` |
| E | prebuild generator + assert-dist (the cure) | biofs-cli | NEW `scripts/build-catalog.mjs`, `scripts/assert-dist-catalog.mjs`; MOD `package.json` | dist-strip guard 3.6 |
| E | per-verb fragments + catalog verb + schema gate | biofs-cli | NEW `*.verb.json`, `src/commands/catalog.ts`; MOD `src/index.ts` | help 2379-2399; preflight 154-160 |
| E | catalog routes + version + materialize | biofs-node | NEW `src/lib/{catalog,materialize}.js`; MOD `src/index.js`, `cravat_mint.js` | `/agent/catalog{,/version,/routes}`; cravat_status STALE 1429-1452 |
| E | bio_invoke skill-gated dispatcher + SKILL.md | mcp | NEW `src/skill_gate.ts`, `src/catalog_client.ts`, `skills/*.SKILL.md`; MOD `src/index.ts` | TOOLS 176-471, switch ~947 |
| F | FTS5 index + BM25 + RRF + consent pre-filter | biofs-node | NEW `src/lib/evidence_index.js` | `searchEvidence`, `consentFilterDocs` -> `verifyConsent` 189-289 |
| F | off-request index build | biofs-node | NEW `src/lib/evidence_index_build.js` | `skipped_no_lineage`; `lab_paths.allocateSqlitePath` |
| F | search/research/docs routes | biofs-node | MOD `src/index.js` | `/agent/search{,_build,_build_status}`, `/agent/research/*`, `/api_docs/map` |
| F | search/dashboard/research/onboard verbs | biofs-cli | NEW `search.ts`/`dashboard.ts`/`research.ts`/`onboard.ts`, `src/templates/dashboard.html`; MOD `fuse-client.ts`, `src/index.ts` | offline HTML; absolute MCP bin path |
| F | build guard | biofs-cli | NEW `scripts/validate-commands.mjs`, `src/verbs.json`; MOD `package.json` | converges with E |
| F | bio_search/research tools | mcp | MOD `src/index.ts`; NEW `scripts/validate-tools.mjs` | reuses `requireSession()` |
| 3.6 | dist-strip guard (shared) | all TS | build scripts | fail-on-missing |