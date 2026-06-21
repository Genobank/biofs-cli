/**
 * biofs phase exec --sample <serial> --bam <gs> --vcf <gs> [--ref auto] ...
 *
 * EXECUTOR verb: VM-side genome-wide read-backed phasing (HiPhase). biofs-node spawns this;
 * no orphan script. Streams the aligned HiFi BAM straight from the gcsfuse RO mount (the BAM
 * is NEVER downloaded) plus the small-variant VCF and the reference the BAM was aligned to.
 * HiPhase requires the input VCF bgzipped + indexed; if the provided VCF is plain/unsorted it
 * is sorted, bgzipped and tabix-indexed first (bcftools). HiPhase then emits a phased VCF
 * (PS phase-set tags) and a haplotagged BAM (HP tags), both persisted to the biowallet phase/
 * folder, exits 0 on a valid phased VCF (biofs-node anchors a ClaraJobNFT).
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/phase/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface PhaseExecOptions {
  sample: string;
  bam: string;           // gs:// aligned HiFi BAM
  vcf: string;           // gs:// small-variant VCF to phase
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_ALIGN    = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_HTSLIB   = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_BCFTOOLS = 'quay.io/biocontainers/bcftools:1.19--h8b25389_0';
const IMG_HIPHASE  = 'quay.io/biocontainers/hiphase:1.4.5--h9ee0642_0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[phase] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[phase] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[phase] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

export async function phaseExecCommand(opts: PhaseExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `phase-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `phase-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/phase/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[phase] start sample=${sample} jobId=${jobId}`);
  logLine(`[phase] BAM=${opts.bam}`);
  logLine(`[phase] VCF=${opts.vcf}`);
  logLine(`[phase] biowallet folder: ${BIOWALLET_GCS}`);

  // fuse allow_other (so the root-in-container HiPhase can read the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): BAM bucket + VCF bucket + reference bucket
  const bbkt = bucketOf(opts.bam);
  const vbkt = bucketOf(opts.vcf);
  const bMp = `/mnt/gcsfuse-${bbkt}`, vMp = `/mnt/gcsfuse-${vbkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(bbkt, bMp); gcsfuseRO(vbkt, vMp); gcsfuseRO(refBucket, rMp);
  const bamRel = gsToLocalRel(opts.bam, bbkt);
  const vcfRel = gsToLocalRel(opts.vcf, vbkt);
  if (!fs.existsSync(path.join(bMp, bamRel))) { logLine(`[phase] BAM not found at mount: ${path.join(bMp, bamRel)}`); uploadAudit(); process.exit(1); }
  if (!fs.existsSync(path.join(vMp, vcfRel))) { logLine(`[phase] VCF not found at mount: ${path.join(vMp, vcfRel)}`); uploadAudit(); process.exit(1); }

  // reference selection honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; else GRCh38 (default).
  // Must be the EXACT assembly the BAM + VCF were produced against.
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta'];
  let refRel = '';
  for (const rel of refCandidates) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine(`[phase] no reference fasta (+.fai) for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }
  logLine(`[phase] ref=${refRel}`);

  const threads = capture('nproc', []) || '8';

  // 1. HiPhase requires a bgzipped + tabix-indexed input VCF. Copy the mounted VCF into the
  //    scratch dir (small file, not the BAM) and normalize it: sort + bgzip + index. This is a
  //    no-op-safe re-pack that also fixes a plain/unsorted VCF.
  const inVcfGz = `${sample}.input.vcf.gz`;
  run('docker', dk(IMG_BCFTOOLS, [[vMp, '/v', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; bcftools sort -Oz -o /w/${inVcfGz} "/v/${vcfRel}" && tabix -f -p vcf /w/${inVcfGz}`]),
    'normalize input VCF (sort + bgzip + index)');

  // 1b. HiPhase requires a read group (SM) on the BAM; minimap2 (hifi-align) emits none, so
  //     HiPhase aborts "BAM file has no read groups (RG) tag". Reheader (header-only, fast BGZF
  //     copy) the gcsfuse BAM into local scratch with SM:<sample> and phase the local re-headed
  //     BAM (also far faster for HiPhase's heavy random access). Idempotent if an @RG exists.
  const localBam = path.basename(bamRel).replace(/\.bam$/, '.rg.bam');
  run('docker', dk(IMG_ALIGN, [[bMp, '/b', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -e; samtools view -H /b/${bamRel} > /w/hdr.sam; ` +
      `grep -q '^@RG' /w/hdr.sam || printf '@RG\\tID:${sample}\\tSM:${sample}\\tPL:PACBIO\\tLB:hifi\\n' >> /w/hdr.sam; ` +
      `samtools reheader /w/hdr.sam /b/${bamRel} > /w/${localBam}; samtools index -@ ${threads} /w/${localBam}`]),
    'reheader HiFi BAM to local + inject @RG SM (HiPhase requires a read group)');

  // 2. HiPhase: read-backed phasing of the small-variant VCF against the aligned HiFi BAM.
  //    Emits a phased VCF (PS phase-set tags) + a haplotagged BAM (HP tags). BAM is the local
  //    re-headed copy in /w; reference from /r.
  const phasedVcfGz = `${sample}.phased.vcf.gz`;
  const haplotaggedBam = `${sample}.haplotagged.bam`;
  run('docker', dk(IMG_HIPHASE, [[rMp, '/r', 'ro'], [work, '/w', 'rw']], undefined,
    ['hiphase', '--bam', `/w/${localBam}`, '--vcf', `/w/${inVcfGz}`, '--output-vcf', `/w/${phasedVcfGz}`,
      '--reference', `/r/${refRel}`, '--output-bam', `/w/${haplotaggedBam}`, '--threads', threads]),
    'HiPhase read-backed phasing');

  // index the phased VCF + haplotagged BAM
  run('docker', dk(IMG_HTSLIB, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; tabix -f -p vcf /w/${phasedVcfGz} || true`]), 'tabix phased VCF');
  run('docker', dk(IMG_ALIGN, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; samtools index -@ ${threads} /w/${haplotaggedBam}`]), 'index haplotagged BAM');

  // 3. summarize: n phased records (GT with '|') + n distinct phase blocks (PS phase-set ids)
  const phasedRecords = capture('docker', sdk(IMG_HTSLIB, [[work, '/w', 'ro']], 'bash',
    ['-c', `zcat /w/${phasedVcfGz} | grep -v '^#' | awk -F'\\t' '$10 ~ /\\|/' | wc -l`])).trim() || '0';
  const phaseBlocks = capture('docker', sdk(IMG_BCFTOOLS, [[work, '/w', 'ro']], 'bash',
    ['-c', `bcftools query -f '[%PS]\\n' /w/${phasedVcfGz} 2>/dev/null | grep -vE '^(\\.|)$' | sort -u | wc -l`])).trim() || '0';
  logLine(`[phase] HiPhase: phasedRecords=${phasedRecords} phaseBlocks=${phaseBlocks}`);
  const valid = Number(phasedRecords) >= 0 && fs.existsSync(path.join(work, phasedVcfGz)) && fs.existsSync(path.join(work, haplotaggedBam));

  // 4. persist phased VCF (+ index) + haplotagged BAM (+ index) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, phasedVcfGz), `${BIOWALLET_GCS}/${phasedVcfGz}`], 'upload phased VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${phasedVcfGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  run('gcloud', ['storage', 'cp', path.join(work, haplotaggedBam), `${BIOWALLET_GCS}/${haplotaggedBam}`], 'upload haplotagged BAM');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${haplotaggedBam}.bai ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.phase.manifest/v1', pipeline: 'hifi-hiphase',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { bam: opts.bam, vcf: opts.vcf, reference: refRel },
    tools: { hiphase: IMG_HIPHASE, bcftools: IMG_BCFTOOLS, htslib: IMG_HTSLIB, samtools: IMG_ALIGN },
    outputs: { phased_vcf: `${BIOWALLET_GCS}/${phasedVcfGz}`, haplotagged_bam: `${BIOWALLET_GCS}/${haplotaggedBam}` },
    summary: { phased_records: Number(phasedRecords), phase_blocks: Number(phaseBlocks) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[phase] no phased VCF/haplotagged BAM produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[phase] DONE: ${phasedRecords} phased records in ${phaseBlocks} phase blocks -> ${BIOWALLET_GCS}/${phasedVcfGz}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
