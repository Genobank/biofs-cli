/**
 * biofs hifi-deepvariant exec --sample <serial> --bam <gs aligned HiFi BAM> [--ref CHM13] [--gvcf] ...
 *
 * EXECUTOR verb: GPU-side PacBio HiFi small-variant caller (NVIDIA Parabricks DeepVariant,
 * --mode pacbio). biofs-node spawns this on parabricks-gpu; no orphan script. The aligned HiFi
 * BAM (output of `hifi-align --ref CHM13`) is read from the gcsfuse RO mount (never downloaded)
 * plus the reference it was aligned to, runs `pbrun deepvariant --mode pacbio` on the A100,
 * restricted to primary chromosomes, persists the SNV/indel VCF (+ optional gVCF) + a typed
 * manifest to the biowallet hifi-deepvariant/ folder, exits 0 on a valid call set.
 *
 * pbrun is the NVIDIA Clara Parabricks binary installed natively on parabricks-gpu. DeepVariant
 * is the reference-standard HiFi small-variant caller (Parabricks IS DeepVariant, GPU-accelerated),
 * so the call set is clinically equivalent to a CPU `run_deepvariant --model_type=PACBIO`.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/hifi-deepvariant/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface HifiDeepvariantExecOptions {
  sample: string;
  bam: string;           // gs:// CHM13-aligned HiFi BAM (from hifi-align --ref CHM13)
  ref?: string;
  gvcf?: boolean;        // also emit a gVCF (second pbrun pass)
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_SAMTOOLS = 'quay.io/biocontainers/samtools:1.19.2--h50ea8bc_1';
// Parabricks is the NVIDIA Clara container (pbrun is the in-container command, not a host binary).
const IMG_PARABRICKS = process.env.PARABRICKS_IMAGE || 'nvcr.io/nvidia/clara/clara-parabricks:4.7.0-1';
// primary chromosomes only (CHM13 + GRCh38 are both chr-prefixed); skip chrM + non-primary contigs.
const PRIMARY_CTGS = Array.from({ length: 22 }, (_, i) => `chr${i + 1}`).concat(['chrX', 'chrY']);

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[hifi-deepvariant] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[hifi-deepvariant] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[hifi-deepvariant] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
}
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
function isMounted(mp: string): boolean { return capture('sh', ['-c', `mount | grep -F ' ${mp} ' || true`]).length > 0; }
function gcsfuseRO(bucket: string, mp: string): void {
  fs.mkdirSync(mp, { recursive: true });
  if (isMounted(mp)) return;
  run('gcsfuse', ['--implicit-dirs', '-o', 'ro', '-o', 'allow_other', bucket, mp], `gcsfuse ${bucket}`);
}
function gsToLocalRel(gs: string, bucket: string): string { return gs.replace(`gs://${bucket}/`, ''); }
function bucketOf(gs: string): string { return gs.replace('gs://', '').split('/')[0]; }

export async function hifiDeepvariantExecCommand(opts: HifiDeepvariantExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `hifidv-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `hifidv-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/hifi-deepvariant/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[hifi-deepvariant] start sample=${sample} jobId=${jobId}`);
  logLine(`[hifi-deepvariant] HiFi BAM=${opts.bam}`);
  logLine(`[hifi-deepvariant] biowallet folder: ${BIOWALLET_GCS}`);

  // Parabricks runs inside the Clara container; require the image + an NVIDIA GPU on this executor.
  const haveImg = capture('sh', ['-c', `docker image inspect ${IMG_PARABRICKS} >/dev/null 2>&1 && echo yes || echo no`]) === 'yes';
  if (!haveImg) { logLine(`[hifi-deepvariant] Parabricks image ${IMG_PARABRICKS} not present; this verb requires a Parabricks GPU executor`); uploadAudit(); process.exit(1); }
  const gpuName = capture('sh', ['-c', 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true']);
  if (!gpuName) { logLine('[hifi-deepvariant] no NVIDIA GPU detected (nvidia-smi); cannot run pbrun'); uploadAudit(); process.exit(1); }
  logLine(`[hifi-deepvariant] parabricks=${IMG_PARABRICKS} gpu=${gpuName}`);

  // fuse allow_other (so pbrun reads the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): HiFi BAM bucket + reference bucket
  const obkt = bucketOf(opts.bam);
  const oMp = `/mnt/gcsfuse-${obkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(refBucket, rMp);
  const bamRel = gsToLocalRel(opts.bam, obkt);
  if (!fs.existsSync(path.join(oMp, bamRel))) { logLine(`[hifi-deepvariant] HiFi BAM not found at mount: ${path.join(oMp, bamRel)}`); uploadAudit(); process.exit(1); }
  if (!fs.existsSync(path.join(oMp, bamRel + '.bai')) && !fs.existsSync(path.join(oMp, bamRel.replace(/\.bam$/, '.bai')))) {
    logLine('[hifi-deepvariant] HiFi BAM is missing its .bai index (hifi-align indexes it; re-run hifi-align)'); uploadAudit(); process.exit(1);
  }

  // reference selection honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; else GRCh38 (default).
  // Must be the EXACT assembly the HiFi BAM was aligned to.
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta'];
  let refRel = '';
  for (const rel of refCandidates) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine(`[hifi-deepvariant] no reference fasta (+.fai) for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }
  logLine(`[hifi-deepvariant] ref=${refRel} caller=pbrun deepvariant --mode pacbio ctgs=primary(chr1-22,X,Y)`);

  // a primary-contigs interval BED restricts DeepVariant to chr1-22,X,Y (skip chrM + non-primary).
  const bedPath = path.join(work, 'primary.bed');
  fs.writeFileSync(bedPath, PRIMARY_CTGS.map((c) => {
    const fai = fs.readFileSync(path.join(rMp, refRel + '.fai'), 'utf8');
    const line = fai.split('\n').find((l) => l.split('\t')[0] === c);
    const len = line ? line.split('\t')[1] : '';
    return len ? `${c}\t0\t${len}` : '';
  }).filter(Boolean).join('\n') + '\n');

  // Stage BAM (+ index) and reference to local NVMe — DeepVariant make_examples does heavy
  // random-access over the BAM; gcsfuse random reads are slow, local NVMe is far faster and
  // shrinks the GPU host-maintenance exposure window. pbrun then reads everything from /w.
  // Stage the HiFi BAM to local NVMe AND inject a read group in one pass. minimap2 (hifi-align)
  // emits NO @RG, so Parabricks cannot derive a sample name and aborts with "Invalid tumor
  // sample name input". samtools reheader (header-only, fast BGZF copy, no per-read rewrite)
  // reads the gcsfuse BAM sequentially and writes a local re-headered BAM carrying SM:<sample>.
  // Idempotent: if an @RG is already present we keep it (no second RG appended).
  const localBam = path.basename(bamRel).replace(/\.bam$/, '.rg.bam');
  run('docker', ['run', '--rm', '-v', `${oMp}:/o:ro`, '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_SAMTOOLS, '-c',
    `set -e; samtools view -H /o/${bamRel} > /w/hdr.sam; ` +
    `grep -q '^@RG' /w/hdr.sam || printf '@RG\\tID:${sample}\\tSM:${sample}\\tPL:PACBIO\\tLB:hifi\\n' >> /w/hdr.sam; ` +
    `samtools reheader /w/hdr.sam /o/${bamRel} > /w/${localBam}; samtools index /w/${localBam}`],
    'stage HiFi BAM to local NVMe + inject @RG SM (Parabricks sample name)');
  if (!fs.existsSync(path.join(work, localBam))) { logLine('[hifi-deepvariant] reheader/stage produced no local BAM'); uploadAudit(); process.exit(1); }
  const localRef = path.basename(refRel);
  run('gcloud', ['storage', 'cp', `gs://${refBucket}/${refRel}`, path.join(work, localRef)], 'stage reference to local NVMe');
  run('gcloud', ['storage', 'cp', `gs://${refBucket}/${refRel}.fai`, path.join(work, localRef + '.fai')], 'stage reference .fai');
  spawnSync('sh', ['-c', `gcloud storage cp gs://${refBucket}/${refRel}.dict ${work}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const vcfGz = `${sample}.hifi.dv.vcf.gz`;
  const pbMounts = ['-v', `${work}:/w:rw`];
  // 1. pbrun DeepVariant (HiFi, GPU) inside the Clara container. --mode pacbio = PacBio model.
  //    Paths are container-relative (/o BAM, /r reference, /w workdir). The bed is at /w/primary.bed.
  run('docker', ['run', '--rm', '--gpus', 'all', ...pbMounts, IMG_PARABRICKS,
    'pbrun', 'deepvariant', '--mode', 'pacbio',
    '--ref', `/w/${localRef}`, '--in-bam', `/w/${localBam}`, '--interval-file', '/w/primary.bed',
    '--out-variants', `/w/${vcfGz}`, '--num-gpus', '1'],
    'pbrun DeepVariant HiFi small-variant calling (mode=pacbio, GPU container, local NVMe)');
  if (!fs.existsSync(path.join(work, vcfGz))) { logLine('[hifi-deepvariant] pbrun produced no VCF'); uploadAudit(); process.exit(7); }
  spawnSync('sh', ['-c', `[ -f "${work}/${vcfGz}.tbi" ] || docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_HTSLIB} -c "tabix -p vcf /w/${vcfGz}"`], { stdio: 'ignore' });

  // 1b. optional gVCF (second pass) for joint/regenotyping
  let gvcfGz = '';
  if (opts.gvcf) {
    gvcfGz = `${sample}.hifi.dv.g.vcf.gz`;
    run('docker', ['run', '--rm', '--gpus', 'all', ...pbMounts, IMG_PARABRICKS,
      'pbrun', 'deepvariant', '--mode', 'pacbio', '--gvcf',
      '--ref', `/w/${localRef}`, '--in-bam', `/w/${localBam}`, '--interval-file', '/w/primary.bed',
      '--out-variants', `/w/${gvcfGz}`, '--num-gpus', '1'],
      'pbrun DeepVariant gVCF pass');
    spawnSync('sh', ['-c', `[ -f "${work}/${gvcfGz}.tbi" ] || docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_HTSLIB} -c "tabix -p vcf /w/${gvcfGz}" 2>/dev/null || true`], { stdio: 'ignore' });
  }

  // 2. summarize
  const total = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${vcfGz} | grep -vc '^#'`]) || '0';
  const passN = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${vcfGz} | awk -F'\\t' '!/^#/ && $7=="PASS"' | wc -l`]) || '0';
  logLine(`[hifi-deepvariant] DeepVariant calls: total=${total} PASS=${passN}`);
  const valid = Number(total) > 0;

  // 3. persist VCF (+ index, + optional gVCF) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, vcfGz), `${BIOWALLET_GCS}/${vcfGz}`], 'upload HiFi DeepVariant VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${vcfGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  if (gvcfGz) {
    spawnSync('sh', ['-c', `gcloud storage cp ${work}/${gvcfGz} ${BIOWALLET_GCS}/ 2>/dev/null || true; gcloud storage cp ${work}/${gvcfGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  }

  const manifest = {
    schema: 'genobank.hifidv.manifest/v1', pipeline: 'hifi-deepvariant-snv',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { bam: opts.bam, reference: refRel, mode: 'pacbio', ctgs: 'primary', gvcf: !!opts.gvcf },
    tools: { parabricks_deepvariant: IMG_PARABRICKS, htslib: IMG_HTSLIB },
    outputs: { snv_indel_vcf: `${BIOWALLET_GCS}/${vcfGz}`, ...(gvcfGz ? { gvcf: `${BIOWALLET_GCS}/${gvcfGz}` } : {}) },
    summary: { total_variants: Number(total), pass_variants: Number(passN) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[hifi-deepvariant] no variants produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[hifi-deepvariant] DONE: ${total} variants (${passN} PASS) persisted to ${BIOWALLET_GCS}/${vcfGz}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
