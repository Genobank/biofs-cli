# `/api_biofs_fuse/cohort_fourier_score` — Server Endpoint Contract

**Status:** Specification, not yet implemented on prod GenoBank API.
**Verb that invokes it:** `biofs cohort-fourier-score` (shipped in biofs-cli 3.4.0 as a thin client).
**Server home:** `/home/ubuntu/Genobank_APIs/production_api/api_biofs_fuse/*` on `genobank-production` (same surface as the existing `/variants` and `/cohort_acmg` endpoints).
**Implementation target:** any future session that picks up this scaffolded verb. The server endpoint owes the variant extraction + Cosic-RRM scoring path; the client side is done.

The CLI verb already lives in `src/commands/cohort-fourier-score.ts` and the typed API client in `src/lib/api/fuse-client.ts::cohortFourierScorePerSerial`. The endpoint contract below is the only remaining surface to implement on prod.

## 1. Request

`GET /api_biofs_fuse/cohort_fourier_score`

| Param | Type | Required | Notes |
|---|---|---|---|
| `biosample` | string | yes | Biosample serial; the server resolves this via bioroutes to an NFT-gated OpenCRAVAT sqlite path. |
| `wallet` | EIP-55 address | yes | Operator wallet for signature verification. |
| `signature` | hex | yes | Wallet signature over the canonical login challenge. Same verification path as `/variants` and `/cohort_acmg`. |
| `max_af` | float | no | gnomAD v3 AF ceiling for the rare-missense filter. Default `0.01`. |
| `am_threshold` | float | no | AlphaMissense threshold for the high-AM admission rule. Default `0.5`. |
| `include_vus` | bool | no | When true, also include ClinVar VUS missense variants. Default false (P/LP only). |
| `include_high_am` | bool | no | When true, also include missense with AlphaMissense ≥ `am_threshold` even if absent from ClinVar. Default false. |
| `window` | int | no | Window size in residues for the centered Σ\|ΔF\|. Default 31. |
| `window_tm` | int | no | Window size for variants whose position falls inside a UniProt-annotated transmembrane segment. Default 51. |

The cohort-level CLI verb does NOT call a single `cohort_fourier_score` endpoint with a fanned-out serials list; it issues one request per serial with a small concurrency window (default 2). This mirrors `cohort_acmg` and avoids the Cloudflare 100-second edge timeout on N-serial batches. The endpoint therefore operates on **exactly one biosample serial per call**, consistent with the `/variants` endpoint pattern.

## 2. Authentication and authorization

Same as `/variants`:

1. Verify the wallet/signature pair against the login challenge.
2. Resolve the bioroutes inventory entry for the biosample.
3. Confirm the calling wallet has BioNFT-gated consent for the resolved OpenCRAVAT sqlite. A 403 response with `{"error": "BioNFT consent / signature rejected"}` is returned otherwise.

## 3. Server-side processing

For each request:

1. **Resolve** the latest OpenCRAVAT sqlite path via `bioroutes.inventory` (canonical column `route_path` plus a `file_type = "opencravat_sqlite"` filter, taking the most-recent by `imported_at`).
2. **Open** the sqlite via the existing `/api_biofs_fuse/_open_sqlite` helper on the gcsfuse mount at `/mnt/gcsfuse-bioroutes/...`. Never copy the sqlite to local disk.
3. **Extract** the candidate variant set:
   ```sql
   SELECT base__hugo  AS gene,
          base__chrom AS chrom,
          base__pos   AS pos,
          base__ref_base  AS ref,
          base__alt_base  AS alt,
          base__cchange   AS cdna,
          base__achange   AS protein,
          base__so        AS so,
          clinvar__sig    AS clinvar_sig,
          clinvar__id     AS clinvar_id,
          alphamissense__am_pathogenicity AS am,
          revel__score    AS revel,
          gnomad3__af     AS af
     FROM variant
    WHERE base__so = 'missense_variant'
      AND (gnomad3__af IS NULL OR gnomad3__af <= :max_af)
      AND (
          (clinvar__sig LIKE '%athogenic%'
               AND clinvar__sig NOT LIKE '%onflicting%')
       OR (:include_vus AND clinvar__sig LIKE '%ncertain%')
       OR (:include_high_am AND alphamissense__am_pathogenicity >= :am_threshold)
      )
   ```
   Apply the existing acmg helper's allele-frequency parsing for any non-trivial AF cases (e.g. comma-separated multiallelic).
4. **Per-variant Cosic-RRM scoring.** For each variant:
   - Parse `base__achange` into `(ref_aa3, pos, alt_aa3)`. Skip rows that fail parsing with `scoring_status = "parse_error"`.
   - Look up the gene's canonical UniProt accession via the bundled `gene_to_uniprot.json` map (already on prod for `biofs fourier-score` use). If missing, mark `scoring_status = "no_uniprot"`.
   - Fetch the cached consensus characteristic-frequency JSON at `~/.biofs/cache/rrm/<GENE>.json` (the server-side cache; same path the per-gene verbs already write). If absent, compute it inline by calling the equivalent of `biofs rrm-consensus <gene>` and write the result back; first-call latency for an un-cached gene is dominated by the UniProt ortholog fetch and is bounded by the existing 300-second timeout.
   - Pull the wild-type protein sequence from the UniProt cache (`~/.biofs/cache/uniprot/<ACC>.fa`), substitute the single residue, EIIP-encode both, run the windowed real-input FFT, and compute the five summary fields exactly as `biofs fourier-score --consensus-fc` does. The widening rule for transmembrane segments uses the same TM-region table that `fourier-score.ts` ships.
   - Record `eiip_delta`, `window_size`, `window_sum_abs_df`, `window_delta_energy_pct`, `full_spectrum_l1`, `fc_period_aa`, `fc_snr`, `fc_ratio_mw`, `fc_delta_energy_pct`, `weighted_agg_delta_energy_pct`, `fc_cache_hit`, `scoring_status = "ok"`.
5. **Return** the per-variant rows under the response envelope below.

## 4. Response

```json
{
  "biosample": "<serial>",
  "job_id": "<latest opencravat job id, optional>",
  "biocid": "<biocid for the sqlite, optional>",
  "n_variants_scored": 12,
  "variants": [
    {
      "gene": "ITGA2B",
      "chrom": "chr17",
      "pos": 44376320,
      "ref": "A",
      "alt": "G",
      "cdna": "c.2336T>C",
      "protein": "p.Val779Ala",
      "uniprot": "P08514",
      "so": "missense_variant",
      "clinvar_significance": "Likely_pathogenic",
      "clinvar_id": "2887278",
      "alphamissense": 0.356,
      "revel": 0.308,
      "gnomad3_af": null,
      "eiip_delta": 0.0316,
      "window_size": 31,
      "window_sum_abs_df": 0.301,
      "window_delta_energy_pct": 3.1,
      "full_spectrum_l1": 0.0174,
      "fc_period_aa": 214.4,
      "fc_snr": 4.65,
      "fc_ratio_mw": 0.9995,
      "fc_delta_energy_pct": -0.09,
      "weighted_agg_delta_energy_pct": 0.0,
      "fc_cache_hit": true,
      "scoring_status": "ok"
    }
  ],
  "methodology": "EIIP (Cosic 1994 Rydberg) + rfft on a centered window (N=31 default, N=51 for TM); full-protein L1 spectral distance + f_c ratio against cached vertebrate-ortholog consensus characteristic frequency. Identical to single-variant `biofs fourier-score --consensus-fc`."
}
```

## 5. Error responses

| HTTP | Body | When |
|---|---|---|
| 400 | `{"error": "missing required param X"}` | malformed request |
| 403 | `{"error": "BioNFT consent / signature rejected"}` | signature or consent fails |
| 404 | `{"error": "No OpenCRAVAT sqlite registered for this biosample"}` | bioroutes lookup empty |
| 503 | `{"error": "Sqlite path not mounted on prod (transient)"}` | gcsfuse remount needed |
| 500 | `{"error": "<exception>"}` | unanticipated server error |

The CLI client maps 404 → `status: "no_annotation"` and any other failure → `status: "failed"`, matching the cohort-acmg pattern.

## 6. Caching

Per-gene consensus characteristic-frequency cache at `~/.biofs/cache/rrm/<GENE>.json` (already in use by `biofs rrm-consensus`). New entries are written transparently on first call. The CLI manifest reports `fc_cache_hit` per variant so cohort-scale runs can attribute cold-start latency to specific genes.

## 7. Performance budget

A typical AUGenomics WES proband has 10 to 50 rare missense variants after the default filter (`max_af ≤ 0.01`, ClinVar P/LP only). Per-variant scoring on a cache hit is ~80 ms (dominated by NumPy rfft + ortholog-spectrum lookup). With 84 serials × 30 variants × 80 ms ≈ 3.4 minutes of pure compute, plus first-call UniProt fetches for any genes whose consensus is not yet cached.

The CLI verb's per-serial timeout is 300 s. Expected wall-clock with cold caches: 30 to 60 minutes for an 84-serial cohort.

## 8. Anchoring (deferred to Sprint 2)

Cohort-fourier-score results are not anchored on-chain in this initial implementation. The future Sprint 2 path is to mint a `ClaraBatchJobNFT` with the cohort manifest hash (per the biofs-node `finalizeBatchOnChain` flow at `/agent/batch-complete`), so the cohort score matrix has the same provenance guarantees as the Neochromosome WGS batch already has. The CLI verb can be extended to take an `--anchor` flag in Sprint 2; the result manifest is already structured to support that.

## 9. Testing checklist for the prod implementation

1. Single-serial smoke test against a known AUGenomics WES with at least one ITGA2B P/LP variant. Confirm Val779Ala and Leu225Arg score with the same metrics the whitepaper reports.
2. Single-serial cold cache test: delete `~/.biofs/cache/rrm/COL27A1.json` on prod, request a serial with a COL27A1 variant, confirm the consensus is recomputed and `fc_cache_hit` returns false.
3. VUS / high-AM filter test: confirm `include_vus=true` and `include_high_am=true` each expand the result set monotonically.
4. Authorization test: request with a wallet that has no NFT consent for the biosample, expect 403.
5. Cohort-scale wall-clock test: run the CLI verb against the existing `cohort_acmg_reports/cohort_summary.json` (59 biowallets); confirm wall-clock ≤ 90 minutes, output matches the expected per-biowallet JSON layout.
