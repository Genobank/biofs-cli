# biofs `methyl` group — deploy runbook (ONT 5mCG/5hmCG, protocol-native)

Single command group, two subcommands, zero orphan shell scripts:

- `biofs methyl <serial> --bams <csv>`  — CLIENT (default subcommand == `submit`)
- `biofs methyl submit <serial> --bams <csv>` — same as above, explicit
- `biofs methyl exec <flags>` — EXECUTOR, spawned by biofs-node on the GPU VM

The runner logic is the npm-versioned `biofs methyl exec` verb. There is NO
`clara-methyl-job.sh` and never will be.

---

## 0. Reconciliation finding you MUST act on (three biofs-node trees)

There are THREE biofs-node trees, NOT two. Verified live on 2026-06-04:

| host | path | lines | role | has BAM-recall (`inputType`) | biofs on PATH |
|---|---|---|---|---|---|
| laptop clone | `/Users/danieluribe/Downloads/biofs-node/src/index.js` | 2009 | source-of-truth | yes | n/a |
| genobank-production | `/opt/biofs-node-v0.4/src/index.js` | 1899 | PUBLIC API surface (`biofs-node-v0.4.service`) | yes | yes (3.12.0) |
| **parabricks-gpu** | **`/opt/biofs-node/src/index.js`** | **1751** | **the host that actually `spawnJob`s** (`biofs-node.service`, has `JOB_RUNNER`, docker, gcsfuse) | **NO** | **NO** |

The GPU VM tree (`/opt/biofs-node`, 1751 lines) is OLDER than the v0.4.5
BAM-recall work: it has no `INPUT_TYPE` env var and no `inputType==='bam'`
branch. So the methyl patch ships in TWO variants:

- **Variant A** (Section 4A): the 2009/1899-line trees (laptop clone +
  genobank-production). Keyed on `env.INPUT_TYPE`. This is the spec's hunk set,
  plus one OPTIONAL explicitness edit (HUNK 1b) that is NOT required for
  correctness (the unmodified line already evaluates to `'methyl'`).
- **Variant B** (Section 4B): the 1751-line GPU tree. Keyed directly on
  `job.inputType` (no `env.INPUT_TYPE` exists there). **This is the variant that
  makes methyl actually run, because parabricks-gpu is where `spawnJob` fires.**

Apply BOTH so all three trees stay consistent. genobank-production's
`/agent/job` is the public ingress (nginx alias `/api_biofs_node/job`); it
forwards/owns job state, but the GPU node is where the pipeline executes.

---

## 1. biofs-cli: hand-port into the global dist (npm token is broken)

Done already on the laptop and smoke-tested. Files authored:

- Source (provenance): `src/commands/methyl/submit.ts`, `src/commands/methyl/exec.ts`
- Compiled dist (runtime): `dist/commands/methyl/submit.js`, `dist/commands/methyl/exec.js`
- Group registration merged into `dist/index.js`:
  - two requires after `const submit_1 = require("./commands/annotate/submit");`
  - the `const methylCmd = program.command('methyl')...` block immediately
    before `const jobCmd = program`

Verify (laptop, no genomic bytes touched):

```bash
node --check /opt/homebrew/lib/node_modules/@genobank/biofs/dist/index.js
node --check /opt/homebrew/lib/node_modules/@genobank/biofs/dist/commands/methyl/submit.js
node --check /opt/homebrew/lib/node_modules/@genobank/biofs/dist/commands/methyl/exec.js
biofs methyl --help
biofs methyl submit --help
biofs methyl exec --help
# routing proof: first token is a serial, not a known subcommand => default (submit)
biofs methyl FR000 --bams notgs.bam      # must error "must be gs:// URIs" (submit ran)
```

Do NOT run `npm run build` in the global dir — a tsc rebuild strips
hand-ported registrations (per memory feedback-biofs-dist-only-commands). Edit
dist directly.

---

## 2. Install biofs on the GPU VM (parabricks-gpu) — REQUIRED

`spawn('biofs', ['methyl','exec',...])` fires on parabricks-gpu, which has NO
`biofs` on PATH. Install it. npm 3.12.0+ should resolve the published surface,
but methyl is a hand-port not yet on npm, so COPY the patched global dist tree:

```bash
# From the laptop, pack the patched global install and ship it.
cd /opt/homebrew/lib/node_modules/@genobank/biofs
tar czf /tmp/biofs-methyl-dist.tgz bin dist package.json

# parabricks-gpu has no port-22 ingress for SSH-from-laptop in some configs;
# use IAP. If scp-over-IAP is unavailable, stage via GCS (small, code-only):
gcloud storage cp /tmp/biofs-methyl-dist.tgz gs://genobank-parabricks-output/_deploy/biofs-methyl-dist.tgz

gcloud compute ssh parabricks-gpu --tunnel-through-iap --zone=us-central1-f --command='
  set -e
  sudo mkdir -p /opt/biofs-cli-methyl
  gcloud storage cp gs://genobank-parabricks-output/_deploy/biofs-methyl-dist.tgz /tmp/
  sudo tar xzf /tmp/biofs-methyl-dist.tgz -C /opt/biofs-cli-methyl
  cd /opt/biofs-cli-methyl
  sudo npm i --omit=dev --no-audit --no-fund
  sudo ln -sf /opt/biofs-cli-methyl/bin/biofs.js /usr/local/bin/biofs
  which biofs && biofs methyl exec --help
'
```

If `@genobank/biofs@3.12.0` already publishes the methyl verbs at deploy time,
`sudo npm i -g @genobank/biofs@3.12.0` on the GPU VM is sufficient instead.
Either way the gate is: `which biofs && biofs methyl exec --help` must succeed
on parabricks-gpu before submitting a job.

Prereqs already present on parabricks-gpu (verified): docker 29.1.3,
gcsfuse `/usr/bin/gcsfuse`, gcloud `/snap/bin/gcloud`, node v20.20.2, 12 vCPU.
Scratch: there is no `/mnt/scratch`; the root disk is 1.9T with ~436G free, so
the exec verb falls back to `/mnt` then `/tmp` (root fs) for the derived
alignment BAMs (NOT source bytes). If 436G is tight for ~349 GiB of inputs'
derived alignments, attach a scratch disk at `/mnt/scratch` first.

Pull the container images once and VERIFY tool versions (the align image MUST
carry minimap2 AND samtools >= 1.16, or the MM/ML base-mod tags are silently
lost). The pins below are corrected from the earlier draft: `mgibio/...` shipped
samtools 1.7 with NO minimap2, and `ontresearch/modkit:mr_398` was a 404.

```bash
gcloud compute ssh parabricks-gpu --tunnel-through-iap --zone=us-central1-f --command='
  # IMG_ALIGN: biocontainers mulled bundle (minimap2 + samtools>=1.16)
  sudo docker pull quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0
  # IMG_MODKIT: real verified Docker Hub tag (mr_398 did not exist)
  sudo docker pull ontresearch/modkit:mr398_sha065267f74d9eb22402f5f6bde56e8a67bb32d526-amd64
  # IMG_HTSLIB: bgzip + tabix
  sudo docker pull quay.io/biocontainers/htslib:1.19.1--h81da01d_1
  # MANDATORY version check — samtools MUST be >= 1.16 for `fastq -T MM,ML`:
  sudo docker run --rm quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0 \
    sh -c "minimap2 --version; samtools --version | head -1"
'
```

If the mulled tag does not pull or its `samtools` is < 1.16, build a clean,
version-readable image and push it to GCR, then set `IMG_ALIGN` in `exec.ts`
(and the dist `exec.js`) to that ref:

```Dockerfile
FROM quay.io/biocontainers/samtools:1.21--h50ea8bc_0
COPY --from=staphb/minimap2:2.28 /minimap2-2.28_x64-linux/minimap2 /usr/local/bin/minimap2
```

The exec verb assumes ONE image (`IMG_ALIGN`) provides both `samtools` and
`minimap2` so the `fastq -T MM,ML | minimap2 -y | sort` pipe runs in-process and
the MM/ML tags never cross a container boundary. A newer verified modkit tag, if
needed, is `ontresearch/modkit:mr497_shaa7bf2b62946eeb7646b9b9d60b892edfc3b3a52c-amd64`.
Do NOT pin `:latest` for a protocol artifact.

---

## 3. Reference (verified live)

`gs://genobank-references/hg38/Homo_sapiens_assembly38.fasta` (+ `.fai`, `.dict`)
is the GRCh38 reference present in the bucket. `human_GRCh38_no_alt_analysis_set.fasta`
is NOT in the bucket; `Homo_sapiens_assembly38.fasta` is the consistent GRCh38
(GATK) assembly and is what the exec resolver falls back to
(`hg38/Homo_sapiens_assembly38.fasta` is the last candidate, matched live).
modkit needs the `.fai` (present). The exec verb gcsfuse-mounts
`genobank-references` RO and builds a `*.map-ont.mmi` once, cached to
`OUT_GCS/<fasta>.map-ont.mmi`.

Reference-consistency note (not blocking): the john-t2t HiFi VCF was called
against `human_GRCh38_no_alt_analysis_set.fasta`, which is absent from the
bucket, so the resolver falls back to GATK `Homo_sapiens_assembly38.fasta`. CpG
coordinates on chr1..chr22,chrX,chrY,chrM are byte-identical between the two
assemblies, so the bedMethyl is correct and comparable. The only difference is
the ALT/decoy/HLA contigs present in `Homo_sapiens_assembly38.fasta` but omitted
from the `no_alt` reference, so a small fraction of ONT reads may multi-map to
ALT contigs. For STRICT cross-track consistency with the HiFi VCF, stage the
exact `human_GRCh38_no_alt_analysis_set.fasta` into
`gs://genobank-references/GRCh38/` (the resolver's first candidate) BEFORE the
production run; the resolver will then prefer it automatically.

---

## 4A. biofs-node patch — 2009/1899-line trees (laptop clone + genobank-production)

Apply by EXACT-STRING match (line numbers differ by the 110-line offset; every
anchor is byte-identical in both). Back up first; `node --check` before restart.

```bash
# genobank-production
gcloud compute ssh genobank-production --tunnel-through-iap --zone=us-central1-a --command='
  sudo cp /opt/biofs-node-v0.4/src/index.js /opt/biofs-node-v0.4/src/index.js.bkp.methyl.$(date +%Y%m%d_%H%M%S)
'
# laptop clone
cp /Users/danieluribe/Downloads/biofs-node/src/index.js \
   /Users/danieluribe/Downloads/biofs-node/src/index.js.bkp.methyl.$(date +%Y%m%d_%H%M%S)
```

**HUNK 0** — after `const JOB_RUNNER = process.env.JOB_RUNNER || '/usr/local/bin/clara-run-job.sh';`
add:
```js
// methyl (ONT 5mCG/5hmCG) jobs spawn the biofs binary's `methyl exec` subcommand
// instead of JOB_RUNNER. No orphan shell script on the VM. Resolves to the
// global biofs install (see DEPLOY.md). Override with BIOFS_BIN.
const BIOFS_BIN = process.env.BIOFS_BIN || 'biofs';
```

**HUNK 1b** — OPTIONAL explicitness, NOT required (the real line, verified l.696
local / l.719 prod). The unmodified line ALREADY evaluates to `'methyl'` when
`job.inputType === 'methyl'` (the `job.inputType ||` short-circuit honors it), so
methyl works WITHOUT this edit. Apply it only if you want the discriminator
spelled out; it is functionally a no-op, not a fix. Skipping it does NOT break
methyl:
```js
// FIND:
      INPUT_TYPE: job.inputType || ((job.bamUri || job.bam_uri || job.bamBiocid) ? 'bam' : 'fastq'),
// REPLACE WITH:
      INPUT_TYPE: job.inputType === 'methyl' ? 'methyl' : (job.inputType || ((job.bamUri || job.bam_uri || job.bamBiocid) ? 'bam' : 'fastq')),
```

**HUNK 1** — the spawn site (l.700-701 local / l.723-724 prod):
```js
// FIND:
    log(`spawn: ${JOB_RUNNER} biosample=${job.biosampleId} jobId=${job.jobId} inputType=${env.INPUT_TYPE} ${env.INPUT_TYPE === 'bam' ? `bam=${env.IN_BAM_URI}` : `r1=${env.R1_URI}`}`);
    const proc = spawn(JOB_RUNNER, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
// REPLACE WITH:
    let proc;
    if (env.INPUT_TYPE === 'methyl') {
      const methylBamUris = job.methylBamUris || job.methyl_bam_uris || '';
      const methylRef = job.reference && job.reference !== 'auto' ? job.reference : 'GRCh38';
      const args = [
        'methyl', 'exec',
        '--sample',     env.SAMPLE,
        '--bams',       methylBamUris,
        '--ref',        methylRef,
        '--job-id',     env.JOB_ID,
        '--batch-id',   env.BATCH_ID,
        '--creator',    env.CREATOR_WALLET,
        '--out-bucket', env.OUTPUT_BUCKET,
        '--ref-bucket', env.REF_BUCKET,
      ];
      log(`spawn: ${BIOFS_BIN} methyl exec biosample=${job.biosampleId} jobId=${job.jobId} bams=${methylBamUris} ref=${methylRef}`);
      proc = spawn(BIOFS_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      log(`spawn: ${JOB_RUNNER} biosample=${job.biosampleId} jobId=${job.jobId} inputType=${env.INPUT_TYPE} ${env.INPUT_TYPE === 'bam' ? `bam=${env.IN_BAM_URI}` : `r1=${env.R1_URI}`}`);
      proc = spawn(JOB_RUNNER, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
```

**HUNK 2** — consent biocids:
```js
// FIND:
  const consentBiocids = job.inputType === 'bam'
    ? [job.bamBiocid].filter(Boolean)
    : [job.r1Biocid, job.r2Biocid].filter(Boolean);
// REPLACE WITH:
  const consentBiocids = job.inputType === 'methyl'
    ? String(job.methylBiocid || '').split(',').map((s) => s.trim()).filter(Boolean)
    : job.inputType === 'bam'
      ? [job.bamBiocid].filter(Boolean)
      : [job.r1Biocid, job.r2Biocid].filter(Boolean);
```

**HUNK 3 / 3b / 3c** — the bedMethyl derivative + guard + anchor: identical to
the GPU-tree hunks in Section 4B (the derivative/anchor code is byte-identical
across the 1899 and 1751 trees). Use the 4B HUNK 3/3b/3c verbatim.

**HUNK 4** — `/api/v1/clara/submit-job` spec (l.913-916 area; prod l.923):
```js
// FIND:
            inputType: cli.inputType || ((cli.bamUri || cli.bam_uri || cli.bamBiocid) ? 'bam' : undefined),
            bamUri: cli.bam_uri || cli.bamUri || cli.bam,
            bamBiocid: cli.bamBiocid || cli.bam_biocid,
          };
// REPLACE WITH:
            inputType: cli.inputType
              || ((cli.methylBamUris || cli.methyl_bam_uris) ? 'methyl'
                : (cli.bamUri || cli.bam_uri || cli.bamBiocid) ? 'bam'
                : undefined),
            bamUri: cli.bam_uri || cli.bamUri || cli.bam,
            bamBiocid: cli.bamBiocid || cli.bam_biocid,
            methylBamUris: cli.methylBamUris || cli.methyl_bam_uris,
            methylBiocid: cli.methylBiocid || cli.methyl_biocid,
          };
```

`/agent/job` POST handler: NO edit (JSON.parse pass-through carries every field).

Restart genobank-production:
```bash
gcloud compute ssh genobank-production --tunnel-through-iap --zone=us-central1-a --command='
  node --check /opt/biofs-node-v0.4/src/index.js &&
  grep -c "methyl exec" /opt/biofs-node-v0.4/src/index.js &&     # expect >= 2
  sudo systemctl restart biofs-node-v0.4.service &&
  sleep 2 && systemctl is-active biofs-node-v0.4.service &&
  journalctl -u biofs-node-v0.4.service -n 20 --no-pager
'
curl -fsS https://genobank.app/api_biofs_node/healthz && echo OK
```

---

## 4B. biofs-node patch — 1751-line GPU tree (parabricks-gpu, `/opt/biofs-node`)

This is the variant that makes methyl execute. The GPU tree has no
`env.INPUT_TYPE`, so the methyl branch keys on `job.inputType` and reads the
env it just built. Back up first.

```bash
gcloud compute ssh parabricks-gpu --tunnel-through-iap --zone=us-central1-f --command='
  sudo cp /opt/biofs-node/src/index.js /opt/biofs-node/src/index.js.bkp.methyl.$(date +%Y%m%d_%H%M%S)
'
```

**HUNK 0 (GPU)** — after `const JOB_RUNNER = process.env.JOB_RUNNER || '/usr/local/bin/clara-run-job.sh';`
(l.50) add the same `const BIOFS_BIN = process.env.BIOFS_BIN || 'biofs';` block
as HUNK 0 above.

**HUNK 1 (GPU)** — spawn site (l.685-686). The GPU log line has NO inputType:
```js
// FIND:
    log(`spawn: ${JOB_RUNNER} biosample=${job.biosampleId} jobId=${job.jobId} r1=${env.R1_URI}`);
    const proc = spawn(JOB_RUNNER, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
// REPLACE WITH:
    let proc;
    if (job.inputType === 'methyl') {
      const methylBamUris = job.methylBamUris || job.methyl_bam_uris || '';
      const methylRef = job.reference && job.reference !== 'auto' ? job.reference : 'GRCh38';
      const args = [
        'methyl', 'exec',
        '--sample',     env.SAMPLE,
        '--bams',       methylBamUris,
        '--ref',        methylRef,
        '--job-id',     env.JOB_ID,
        '--batch-id',   env.BATCH_ID,
        '--creator',    env.CREATOR_WALLET,
        '--out-bucket', env.OUTPUT_BUCKET,
        '--ref-bucket', env.REF_BUCKET,
      ];
      log(`spawn: ${BIOFS_BIN} methyl exec biosample=${job.biosampleId} jobId=${job.jobId} bams=${methylBamUris} ref=${methylRef}`);
      proc = spawn(BIOFS_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      log(`spawn: ${JOB_RUNNER} biosample=${job.biosampleId} jobId=${job.jobId} r1=${env.R1_URI}`);
      proc = spawn(JOB_RUNNER, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
```
(`env.SAMPLE/JOB_ID/BATCH_ID/CREATOR_WALLET/OUTPUT_BUCKET/REF_BUCKET` all exist
in the GPU env build l.665-685, verified.)

**HUNK 2 (GPU)** — consent loop (l.708-716). The GPU tree has a bare FASTQ loop,
no `consentBiocids` var:
```js
// FIND:
  // 2. verify consent for both FASTQ inputs
  for (const biocid of [job.r1Biocid, job.r2Biocid].filter(Boolean)) {
// REPLACE WITH:
  // 2. verify consent for the input(s): methyl ONT BAMs, else both FASTQs.
  // operator-signed methyl jobs carry empty methylBiocid => loop is a no-op
  // (verifyConsent admin-bypass already covers the operator wallet).
  const consentBiocids = job.inputType === 'methyl'
    ? String(job.methylBiocid || '').split(',').map((s) => s.trim()).filter(Boolean)
    : [job.r1Biocid, job.r2Biocid].filter(Boolean);
  for (const biocid of consentBiocids) {
```

**HUNK 3 (GPU)** — derivative (l.731-744). Add `isMethyl` + bedMethyl path:
```js
// FIND:
  // 4. register derivative BioNFT
  // For Sequentia-native parents (bioip_id hex), skip Story Protocol path —
  // the derivative VCF's provenance is captured by ClaraJobNFT anchor in step 5.
  const isSequentiaNative = typeof job.parentIpId === 'string'
    && /^0x[a-fA-F0-9]{64}$/.test(job.parentIpId);
  let derivative = null;
  if (isSequentiaNative) {
// REPLACE WITH:
  // 4. register derivative BioNFT
  // methyl: result is a bedMethyl (ont-methylation-modkit), NOT a deepvariant VCF.
  const isMethyl = job.inputType === 'methyl';
  // For Sequentia-native parents (bioip_id hex), skip Story Protocol path —
  // the derivative VCF's provenance is captured by ClaraJobNFT anchor in step 5.
  const isSequentiaNative = typeof job.parentIpId === 'string'
    && /^0x[a-fA-F0-9]{64}$/.test(job.parentIpId);
  let derivative = null;
  if (isMethyl) {
    const outBucket = job.outputBucket || 'genobank-parabricks-output';
    const bedName = `${job.biosampleId}.5mCG_5hmCG.bedMethyl.gz`;
    const bedGcs = `gs://${outBucket}/jobs/${job.batchId || job.jobId}/${job.biosampleId}/output/${bedName}`;
    derivative = {
      ip_id: null,
      biocid: `biocid://v1/sequentia/bedMethyl/${job.biosampleId}`,
      tx_hash: null,
      pipeline: 'ont-methylation-modkit',
      gcsPath: bedGcs,
    };
    log(`job ${job.jobId}: methyl — bedMethyl resultBiocid=${derivative.biocid} (${bedGcs})`);
    await upsertJob({
      jobId: job.jobId,
      status: 'derivative-bedmethyl',
      resultBiocid: derivative.biocid,
      resultGcsPath: bedGcs,
      pipeline: 'ont-methylation-modkit',
    });
  } else if (isSequentiaNative) {
```

**HUNK 3b (GPU)** — registerDerivative guard (l.747):
```js
// FIND:
    if (!isSequentiaNative) {
      const gcsOut = `gs://${job.outputBucket || 'genobank-parabricks-output'}/jobs/${job.jobId}/output/${job.biosampleId}.deepvariant.g.vcf`;
// REPLACE WITH:
    if (!isSequentiaNative && !isMethyl) {
      const gcsOut = `gs://${job.outputBucket || 'genobank-parabricks-output'}/jobs/${job.jobId}/output/${job.biosampleId}.deepvariant.g.vcf`;
```

**HUNK 3c (GPU)** — anchor call (l.770-782). Make resultPath + labels methyl-aware:
```js
// FIND:
      const vcfPath = job.vcfPath
        || `gs://${outBucket}/jobs/${job.jobId}/output/${job.biosampleId}.deepvariant.vcf`;
      anchor = await anchorJobOnChain({
        jobId: job.jobId,
        biosampleId: job.biosampleId,
        creatorWallet: job.creatorWallet,
        vcfPath,
        manifestUri,
        pipeline: 'parabricks-deepvariant-germline',
        referenceGenome: job.reference || 'hg38',
      });
// REPLACE WITH:
      const resultPath = isMethyl
        ? (derivative && derivative.gcsPath)
          || `gs://${outBucket}/jobs/${job.batchId || job.jobId}/${job.biosampleId}/output/${job.biosampleId}.5mCG_5hmCG.bedMethyl.gz`
        : (job.vcfPath
          || `gs://${outBucket}/jobs/${job.jobId}/output/${job.biosampleId}.deepvariant.vcf`);
      anchor = await anchorJobOnChain({
        jobId: job.jobId,
        biosampleId: job.biosampleId,
        creatorWallet: job.creatorWallet,
        vcfPath: resultPath,
        manifestUri,
        pipeline: isMethyl ? 'ont-methylation-modkit' : 'parabricks-deepvariant-germline',
        referenceGenome: isMethyl ? (job.reference || 'GRCh38') : (job.reference || 'hg38'),
      });
```

The GPU `/agent/job` POST handler (l.906-922) does `JSON.parse` then
`processJob({ ...spec, jobId })` — pass-through, NO edit. The GPU tree has no
`/api/v1/clara/submit-job` spec block, so HUNK 4 does not apply there.

Restart parabricks-gpu:
```bash
gcloud compute ssh parabricks-gpu --tunnel-through-iap --zone=us-central1-f --command='
  node --check /opt/biofs-node/src/index.js &&
  grep -c "methyl exec" /opt/biofs-node/src/index.js &&        # expect >= 2
  sudo systemctl restart biofs-node.service &&
  sleep 2 && systemctl is-active biofs-node.service &&
  journalctl -u biofs-node.service -n 20 --no-pager
'
```

Regression proof (both hosts): the methyl branch is inert for bam/fastq — submit
one existing fastq job and confirm the log line is still
`spawn: /usr/local/bin/clara-run-job.sh ...` (JOB_RUNNER), not the biofs branch.

---

## 5. Submit the john-t2t ONT methylation job (the real invocation)

Operator-signed from the laptop (no BioNFT needed; admin-bypass consent). The 5
ONT Dorado 5mCG/5hmCG BAMs are verified present:

```bash
biofs methyl john-t2t \
  --ref GRCh38 \
  --bams "gs://t2t-genome-genobank/john-case/ont/dorado0.8.3_sup4.3.0_5mCG_5hmCG/05_29_24_R1041_UL_RttpProject_P1_1_dorado0.8.3_sup4.3.0_5mCG_5hmCG.bam,gs://t2t-genome-genobank/john-case/ont/dorado0.8.3_sup4.3.0_5mCG_5hmCG/05_29_24_R1041_UL_RttpProject_P1_2_dorado0.8.3_sup4.3.0_5mCG_5hmCG.bam,gs://t2t-genome-genobank/john-case/ont/dorado0.8.3_sup4.3.0_5mCG_5hmCG/05_29_24_R1041_UL_RttpProject_P1_3_dorado0.8.3_sup4.3.0_5mCG_5hmCG.bam,gs://t2t-genome-genobank/john-case/ont/dorado0.8.3_sup4.3.0_5mCG_5hmCG/11_7_23_R1041_RttP_P1_0_dorado0.8.3_sup4.3.0_5mCG_5hmCG.bam,gs://t2t-genome-genobank/john-case/ont/dorado0.8.3_sup4.3.0_5mCG_5hmCG/11_7_23_R1041_RttP_P1_1_dorado0.8.3_sup4.3.0_5mCG_5hmCG.bam"
```

Use the proband's custodian biowallet `0x88110B7e4F56A53951461342298b468Ae68F15f1`
as the biosample serial/label if a biocid-bound serial is preferred over
`john-t2t`. Monitor:

```bash
biofs job status <printed-jobId>
# outputs land at:
#   gs://genobank-parabricks-output/jobs/<batchId>/<serial>/output/<serial>.5mCG_5hmCG.bedMethyl.gz(.tbi)
#   gs://genobank-parabricks-output/biowallet/<wallet_lc>/logs/clara-jobs/<jobId>/manifest.json
```

The bedMethyl keeps BOTH 5mC and 5hmC (`modkit pileup --cpg --combine-strands`,
no `--ignore h`). v1 is genome-wide/unphased; allele-specific (`--partition-tag HP`)
comes after phasing.

---

## 6. Rollback

```bash
# genobank-production
gcloud compute ssh genobank-production --tunnel-through-iap --zone=us-central1-a --command='
  sudo cp /opt/biofs-node-v0.4/src/index.js.bkp.methyl.<TS> /opt/biofs-node-v0.4/src/index.js &&
  sudo systemctl restart biofs-node-v0.4.service'
# parabricks-gpu
gcloud compute ssh parabricks-gpu --tunnel-through-iap --zone=us-central1-f --command='
  sudo cp /opt/biofs-node/src/index.js.bkp.methyl.<TS> /opt/biofs-node/src/index.js &&
  sudo systemctl restart biofs-node.service'
# biofs-cli dist (global): remove the two requires + methylCmd block from
# dist/index.js and delete dist/commands/methyl/. The methyl branch is additive,
# so reverting biofs-node alone disables methyl while leaving bam/fastq intact.
```
