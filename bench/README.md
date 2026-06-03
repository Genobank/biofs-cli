# BioFS benchmark datasets

The harness (`biofs benchmark <dataset.jsonl>`) evaluates whether cross-vendor
multi-agent debate reduces ACMG variant misclassification, against single-model
and same-model-debate baselines.

## Dataset format (JSONL, one variant per line)

```
{"variant_id": "...", "gene": "...", "hgvs": "...", "protein": "...",
 "truth": "P|LP|VUS|LB|B", "note": "basis of the truth label"}
```

`truth` is the gold-standard classification each arm is scored against.

## acmg_seed.jsonl (illustrative seed, NOT the publication set)

`acmg_seed.jsonl` is a small set of variants whose classifications are
well-established and widely reviewed (cystic fibrosis CFTR p.Phe508del,
sickle-cell HBB p.Glu6Val, BRCA founder alleles, common benign polymorphisms,
etc.). It exists to validate the harness end to end and to demonstrate the
metrics. It is deliberately weighted to the Pathogenic and Benign ends, where a
defensible truth label exists.

It is NOT a publication-grade benchmark. The labels are illustrative consensus
classifications, not a frozen, citable snapshot.

## Building the publication set

For a submittable study, replace the seed with a curated, citable export:

1. **ClinVar two-star-plus.** Download the ClinVar VCF or the variant_summary
   table, filter to `review_status` of "criteria provided, multiple submitters,
   no conflicts" or better (two-plus gold stars), drop conflicting records, and
   emit one JSONL line per variant with `truth` from the aggregate
   `clinical_significance`. Stratify across genes and across the five ACMG tiers.
2. **ClinGen Variant Curation Expert Panel (VCEP) classifications.** The
   highest-confidence labels; smaller, but expert-panel reviewed.
3. **A challenge set** (for example a CAGI clinical-variant subset) if a
   blinded, time-boxed comparison is desired.

Hold the labels out of the prompts. The models receive only `gene`, `hgvs`, and
`protein`; `truth` is used solely for scoring, never shown to an agent.

## Reproducibility

Every classification an agent makes is written to the shared workspace as a
signed, hash-chained turn, so each benchmark run produces an auditable record.
`biofs benchmark` writes `results.json` (machine-readable) and `report.md`
(the paper table) to the output directory, and the per-variant workspace cases
can be exported and independently re-verified with `biofs ws verify`.
