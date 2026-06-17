/**
 * biofs hifi-methyl exec --sample <serial> --bam <gs> [--ref auto] ...
 *
 * EXECUTOR verb: VM-side PacBio HiFi 5mC methylome caller (pb-CpG-tools). biofs-node spawns this;
 * no orphan script. Streams the aligned HiFi modBAM straight from the gcsfuse RO mount (the BAM is
 * NEVER downloaded) plus the reference the BAM was aligned to, runs aligned_bam_to_cpg_scores to
 * emit per-CpG 5mC scores (<pfx>.combined.bed.gz / .bw), persists the 5mCG bedMethyl (+ bigwig if
 * produced) + a typed manifest to the biowallet hifi-methyl/ folder, exits 0 on a valid call set
 * (biofs-node anchors a ClaraJobNFT). This is the orthogonal methylome for the comethyl
 * H_concordance gate vs the ONT bedMethyl.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/hifi-methyl/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface HifiMethylExecOptions {
  sample: string;
  bam: string;           // gs:// aligned HiFi modBAM carrying MM/ML 5mC tags
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_ALIGN   = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_HTSLIB  = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_PBCPG   = 'quay.io/biocontainers/pb-cpg-tools:2.3.2--hdfd78af_0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[hifi-methyl] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[hifi-methyl] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[hifi-methyl] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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
function dk(image: string, mounts: Array<[string, string, string]>, entrypoint: string | undefined, cmd: string[]): string[] {
  const a = ['run', '--rm']; for (const [h, c, m] of mounts) a.push('-v', `${h}:${c}:${m}`);
  if (entrypoint !== undefined) a.push('--entrypoint', entrypoint); a.push(image, ...cmd); return a;
}
function sdk(image: string, mounts: Array<[string, string, string]>, entrypoint: string | undefined, cmd: string[]): string[] {
  return ['docker', ...dk(image, mounts, entrypoint, cmd)];
}
function gsToLocalRel(gs: string, bucket: string): string { return gs.replace(`gs://${bucket}/`, ''); }
function bucketOf(gs: string): string { return gs.replace('gs://', '').split('/')[0]; }

export async function hifiMethylExecCommand(opts: HifiMethylExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `hifimethyl-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `hifimethyl-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/hifi-methyl/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[hifi-methyl] start sample=${sample} jobId=${jobId}`);
  logLine(`[hifi-methyl] modBAM=${opts.bam}`);
  logLine(`[hifi-methyl] biowallet folder: ${BIOWALLET_GCS}`);

  // fuse allow_other (so the root-in-container pb-CpG-tools can read the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): aligned HiFi modBAM bucket + reference bucket
  const obkt = bucketOf(opts.bam);
  const oMp = `/mnt/gcsfuse-${obkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(refBucket, rMp);
  const bamRel = gsToLocalRel(opts.bam, obkt);
  if (!fs.existsSync(path.join(oMp, bamRel))) { logLine(`[hifi-methyl] modBAM not found at mount: ${path.join(oMp, bamRel)}`); uploadAudit(); process.exit(1); }

  // reference selection honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; else GRCh38 (default).
  // Must be the EXACT assembly the HiFi modBAM was aligned to (or CpG coordinates shift).
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta'];
  let refRel = '';
  for (const rel of refCandidates) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine(`[hifi-methyl] no reference fasta (+.fai) for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }
  logLine(`[hifi-methyl] ref=${refRel}`);

  const threads = capture('nproc', []) || '8';
  const pfx = `${sample}.hifi.5mCG`;
  const bedGz = `${pfx}.hifi.5mCG.bed.gz`;            // final persisted name (<sample>.hifi.5mCG.bed.gz)
  const combinedBed = `${pfx}.combined.bed`;          // pb-CpG-tools emits <pfx>.combined.bed[.gz]

  // 1. pb-CpG-tools: aligned_bam_to_cpg_scores over the gcsfuse-mounted HiFi modBAM.
  // The pileup_calling_model file ships in the image; its path is not pinned, so run WITHOUT
  // --model (count-based pileup mode). Note recorded in the manifest (model: count-based-pileup).
  run('docker', dk(IMG_PBCPG, [[oMp, '/o', 'ro'], [rMp, '/r', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; aligned_bam_to_cpg_scores --bam "/o/${bamRel}" --ref "/r/${refRel}" ` +
      `--output-prefix /w/${pfx} --threads ${threads}`]), 'pb-CpG-tools 5mC scoring');

  // pb-CpG-tools 2.3.x writes <pfx>.combined.bed.gz (bgzipped) + <pfx>.combined.bw. Normalize to a
  // bgzipped <sample>.hifi.5mCG.bed.gz so the comethyl gate has a stable name; bgzip if plain.
  let combinedRel = '';
  if (fs.existsSync(path.join(work, `${pfx}.combined.bed.gz`))) combinedRel = `${pfx}.combined.bed.gz`;
  else if (fs.existsSync(path.join(work, combinedBed))) {
    run('docker', dk(IMG_HTSLIB, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; bgzip -f /w/${combinedBed}`]), 'bgzip combined bed');
    combinedRel = `${pfx}.combined.bed.gz`;
  }
  if (!combinedRel) { logLine('[hifi-methyl] pb-CpG-tools produced no combined bed'); uploadAudit(); process.exit(7); }
  run('docker', dk(IMG_ALIGN, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; cp /w/${combinedRel} /w/${bedGz}`]), 'rename combined -> 5mCG bed');
  run('docker', dk(IMG_HTSLIB, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; tabix -p bed /w/${bedGz} || true`]), 'tabix 5mCG bed');

  // bigwig if pb-CpG-tools emitted it
  const bwRel = fs.existsSync(path.join(work, `${pfx}.combined.bw`)) ? `${pfx}.combined.bw` : '';

  // 2. summarize: total CpG sites + global mean 5mC (combined bed col 4 = modification fraction)
  const sites = capture('docker', sdk(IMG_HTSLIB, [[work, '/w', 'ro']], 'bash',
    ['-c', `zcat /w/${bedGz} | grep -vc '^#' || true`])).slice(1) || '0';
  const meanMeth = capture('docker', sdk(IMG_HTSLIB, [[work, '/w', 'ro']], 'bash',
    ['-c', `zcat /w/${bedGz} | grep -v '^#' | awk '{s+=$4;n++} END{ if(n>0) printf "%.4f", s/n; else printf "0" }'`])).slice(1) || '0';
  logLine(`[hifi-methyl] pb-CpG-tools: total_cpg_sites=${sites} global_mean_5mC=${meanMeth}`);
  const valid = Number(sites) > 0 && fs.existsSync(path.join(work, bedGz));

  // 3. persist 5mCG bed (+ index, + bigwig) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, bedGz), `${BIOWALLET_GCS}/${bedGz}`], 'upload 5mCG bedMethyl');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${bedGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  if (bwRel) run('gcloud', ['storage', 'cp', path.join(work, bwRel), `${BIOWALLET_GCS}/${pfx}.bw`], 'upload bigwig');

  const manifest = {
    schema: 'genobank.hifimethyl.manifest/v1', pipeline: 'hifi-pbcpg-methyl',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { bam: opts.bam, reference: refRel },
    tools: { pb_cpg_tools: IMG_PBCPG, htslib: IMG_HTSLIB },
    model: 'count-based-pileup',
    outputs: {
      methyl_bed: `${BIOWALLET_GCS}/${bedGz}`,
      ...(bwRel ? { methyl_bigwig: `${BIOWALLET_GCS}/${pfx}.bw` } : {}),
    },
    summary: { total_cpg_sites: Number(sites), global_mean_5mC: Number(meanMeth) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[hifi-methyl] no 5mCG bed produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[hifi-methyl] DONE: ${sites} CpG sites (mean 5mC ${meanMeth}) persisted to ${BIOWALLET_GCS}/${bedGz}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
