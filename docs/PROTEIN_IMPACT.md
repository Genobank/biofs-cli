# biofs protein-impact

Protein-level impact of known missense substitutions in the 2 integrin genes of Glanzmann thrombasthenia: ITGA2B (UniProt P08514) and ITGB3 (P05106). Research-grade analysis. It is not a clinical test, not a diagnosis and not medical advice.

The verb analyzes. It cannot design. The only input is a list of (gene, reference residue, position, alternate residue) tuples. A free sequence, FASTA, SMILES or structure is refused by name at any depth, a long run of amino acid letters in any value is refused, and 2 genes are supported by code. The same guard runs 3 times: in the client, in biofs-node, and in the executor.

## Commands

```
biofs protein-impact fetch [--genes ITGA2B,ITGB3]
biofs protein-impact validate [--layers plm] [--estimate]
biofs protein-impact gate-sign <results.gate.json> --yes
biofs protein-impact apply <serial> --variant GENE:p.Leu225Arg --source <biocid> --gate-file <signed gate>
                           [--layers features,plm,complex,md] [--estimate | --approve <id> --max-usd N]
biofs protein-impact probe [--estimate | --approve <id> --max-usd N]
biofs protein-impact results <jobId>
```

`fetch`, `validate` and `probe` use public data only. `apply` is the only command that touches a biosample.

Order of use: `fetch`, then `validate`; `results` gives the gate document; `gate-sign` after reading its numbers; then `apply`.

## Validation gate

Scores for a sample are produced only after the method has been validated on published variants.

The benchmark (`gt_benchmark_v1`, built by `scripts/protein-impact/build_benchmark.py` from ClinVar and gnomAD v4 only) holds 168 missense changes: 131 damaging (ClinVar Pathogenic or Likely pathogenic at 2 stars or more) and 37 tolerated (ClinVar Benign or Likely benign at 2 stars or more; or gnomAD v4 with no ClinVar pathogenic record and either an allele frequency of at least 0.001 or a homozygous observation among at least 20 alleles). Each variant is placed in a structural domain from the CATH boundaries of the 3FCS structure. A sample's own variants never enter it, and `apply` refuses any variant that does.

Scoring has no fitted weights: components are oriented so that a higher number means more damaging and combined by averaging ranks. The rules were fixed on 2026-10-21, before any model was run on the benchmark:

1. At least 20 damaging and 20 tolerated variants.
2. Pooled AUROC with a stratified bootstrap 95% interval: lower bound at least 0.75, and the point estimate at least 0.03 above the best baseline. Baselines are BLOSUM62, hydropathy change, volume change and the domain prior (the share of damaging variants in the variant's domain, computed on the benchmark itself, an optimistic bar). On the frozen benchmark BLOSUM62 scores 0.718 and the domain prior 0.712.
3. AUROC of at least 0.70 in the beta-propeller and in the calf domains of alpha-IIb, each with at least 5 variants of each class.
4. A permutation null whose interval includes 0.5, as a check of the evaluation code.

A gate document records the rules hash, the benchmark hash, the tools lock hash and the verdict. It is signed by the operator with `gate-sign`; a changed tool, rule or benchmark invalidates it.

## What `apply` checks before anything runs

1. The sample carries every requested variant. Variants are read through the gated variants API (`--so MIS`); the annotation sqlite never leaves the server.
2. Each reference residue matches the pinned UniProt 2026_03 sequence at that position. A wrong isoform or a numbering slip fails closed.
3. A gate document exists that passes the committed rules, was computed with the same `tools.lock.json`, was signed off by the operator, and does not contain any variant being scored. Without it the job ends as `GATE_BLOCKED` and writes no scores.
4. GPU layers carry an approval: `estimate_id` from `--estimate` plus `--max-usd`. The id is derived from the request, the price and the UTC day, so it approves exactly that request that day. The job stops at 1.5 times the approved total.

## Numbering

HGVS protein positions count from the precursor Met. Literature and PDB entries use the mature chain. ITGA2B: mature = HGVS minus 31. ITGB3: mature = HGVS minus 26. One global offset would corrupt ITGB3, so the offset is per gene and checked against the pinned sequences.

## Layers

| Layer | Needs | What it adds |
| --- | --- | --- |
| fetch | network | UniProt sequences, hash checked against the pin |
| features | none | numbering check, BLOSUM62, hydropathy, volume, charge, proline and cysteine flags |
| plm | CPU container | protein language model log-likelihood ratios (masked marginal) |
| structure | CPU container | burial, contacts and interface features on experimental structures |
| probe, complex | GPU container | peak memory of the heterodimer, wild type against mutant complex predictions |
| md | GPU container | molecular dynamics, 3 replicas |

Containers are pinned by digest in `tools.lock.json`. A layer whose image or model commit is not pinned refuses to run.

## Outputs

`gs://<out-bucket>/biowallet/<creator>/protein-impact/<jobId>/manifest.json` with `status` OK, EMPTY, GATE_BLOCKED or FAILED, the request hash, the gate id, the per-stage hashes and the per-variant results. An identical request has the same job id and finds every stage cached, so it does zero compute. File the manifest with lineage:

```
biofs protein-impact results <jobId> --out results.json
biofs register-derived results.json --type protein-impact-report --parent <source biocid>
```

Exit codes of `exec`: 0 OK, 1 failed, 2 guard refused, 7 empty, 8 gate blocked, 9 approval refused.
