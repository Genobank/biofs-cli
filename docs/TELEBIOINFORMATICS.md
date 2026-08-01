# TeleBioinformatics (`biofs tele`)

Consent-gated vault bytes stream to the analyst over GA4GH **htsget**. Local tools
(bcftools, samtools, seqkit, IGV, Jupyter) run on the researcher machine; the
vault object does not land as a permanent download.

## Tiers

| Tier | Where compute runs | Commands |
|------|--------------------|----------|
| **A** Stream | Laptop | `biofs stream`, `biofs pipe`, `biofs tele stats/header/…` |
| **B** URL / fuse | Laptop + seekable path | `biofs tele igv`, `biofs fuse`, mosdepth |
| **C** Next to data | biofs-node / GPU | `biofs annotate`, pipelines, DeepVariant |

## Quick start

```bash
export BIOFS_PROFILE=patient   # or researcher with open room

biofs tele tools

# VCF
biofs tele header 41221040804032.deepvariant.agilent_v8.vcf
biofs tele stats  41221040804032.deepvariant.agilent_v8.vcf
biofs tele region 41221040804032.deepvariant.agilent_v8.vcf chr17:7661779-7687538
biofs tele query  41221040804032.deepvariant.agilent_v8.vcf -- -f '%CHROM\t%POS\t%REF\t%ALT\n' | head
biofs tele filter 41221040804032.deepvariant.agilent_v8.vcf --include 'QUAL>30'

# BAM
biofs tele flagstat 41221040804032.deepvariant.hg38.bam
biofs tele count    41221040804032.deepvariant.hg38.bam

# FASTQ (seqkit on PATH)
biofs tele seqkit 41221040804032_R1.fastq.gz

# IGV.js session + desktop batch
biofs tele igv 41221040804032.deepvariant.hg38.bam --web --open

# Jupyter / pysam cell
biofs tele jupyter 41221040804032.deepvariant.agilent_v8.vcf
```

Equivalent low-level pipes:

```bash
biofs stream SAMPLE.vcf | bcftools stats -
biofs stream SAMPLE.bam | samtools flagstat -
biofs pipe SAMPLE.vcf -- -H
```

## Region semantics

`--region chr:start-end` is:

1. Forwarded to htsget as `referenceName` / `start` / `end` (0-based start).
2. Applied client-side for VCF via `bcftools view -r` when using `tele region`.

BAM region over stdin is linear (no BAI). For random access on large WGS BAMs
use `biofs fuse` or wait for server-side tabix slices.

## Room skills

Default open-room skills include:

`list`, `resolve`, `stream`, `view`, `htsget`, `annotate`, `tele`, `qc`, `igv`, `jupyter`

Researchers admitted to a room can run tele verbs on scoped biocids only.

## Security

Stream and IGV session URLs embed `user_signature`. Treat HTML/batch files as
secret capabilities. Revoke the room to cut off new tickets; do not email
session files.
