/**
 * biofs hifi-align exec --sample <serial> --bams <csv gs://> [--ref auto] ...
 *
 * EXECUTOR verb: VM-side PacBio HiFi aligner (pbmm2). biofs-node spawns this; no orphan script.
 * Each unaligned HiFi BAM is read from the gcsfuse RO mount (never downloaded), aligned with
 * pbmm2 (HIFI preset) to the assembly the ONT modBAM uses (assembly38), MM/ML 5mC tags
 * preserved, then the per-cell aligned BAMs are merged + indexed and persisted. A fail-fast
 * check aborts if the aligned BAM lost its MM:Z: tags.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/hifi-align/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface HifiAlignExecOptions {
  sample: string;
  bams: string;          // CSV of gs:// unaligned HiFi BAM URIs
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_ALIGN = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_PBMM2 = 'quay.io/biocontainers/pbmm2:1.13.1--h9ee0642_0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[hifi-align] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[hifi-align] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[hifi-align] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

export async function hifiAlignExecCommand(opts: HifiAlignExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `hifialign-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const bams = (opts.bams || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (bams.length === 0) { Logger.error('[hifi-align] no --bams'); process.exit(1); }

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `hifialign-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/hifi-align/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[hifi-align] start sample=${sample} jobId=${jobId} cells=${bams.length}`);
  logLine(`[hifi-align] biowallet folder: ${BIOWALLET_GCS}`);

  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): each HiFi bucket + reference
  const buckets = new Set(bams.map(bucketOf));
  const mpOf: Record<string, string> = {};
  for (const b of buckets) { const mp = `/mnt/gcsfuse-${b}`; gcsfuseRO(b, mp); mpOf[b] = mp; }
  const rMp = `/mnt/gcsfuse-${refBucket}`; gcsfuseRO(refBucket, rMp);

  // reference: the EXACT assembly the ONT modBAM was aligned to (so HiFi + ONT share coordinates)
  let refRel = '';
  for (const rel of ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta']) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine('[hifi-align] no reference fasta (+.fai) found'); uploadAudit(); process.exit(1); }
  const threads = capture('nproc', []) || '8';
  logLine(`[hifi-align] ref=${refRel} threads=${threads} aligner=minimap2(map-hifi, kinetics dropped, MM/ML kept)`);

  // 1a. build the map-hifi minimap2 index once
  const mmi = 'asm38.map-hifi.mmi';
  run('docker', ['run', '--rm', '-v', `${rMp}:/r:ro`, '-v', `${work}:/w:rw`, '--entrypoint', 'minimap2', IMG_ALIGN,
    '-x', 'map-hifi', '-d', `/w/${mmi}`, `/r/${refRel}`], 'build map-hifi index');

  // 1b. stream-align each cell: samtools fastq -T MM,ML DROPS the heavy per-base PacBio kinetics
  //     (fi/fp/ri/rp) while keeping the 5mC MM/ML tags, minimap2 -ax map-hifi -L -y carries the
  //     fastq comment -> BAM aux, samtools sort pins temp to the scratch disk (-T). This is the
  //     methyl pipeline's proven pattern; pbmm2 carrying full kinetics with a 3 GB sort buffer was
  //     ~10x slower and thrashed the host. (IMG_PBMM2 kept above only for reference.)
  const perCell: string[] = [];
  bams.forEach((gs, i) => {
    const b = bucketOf(gs); const rel = gsToLocalRel(gs, b); const oMp = mpOf[b];
    const outBam = `cell${i}.aligned.bam`;
    run('docker', ['run', '--rm', '-v', `${oMp}:/o:ro`, '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_ALIGN, '-c',
      // -Y = soft-clip supplementary alignments (default hard clips break pbsv: "Hard clips are not supported")
      `set -euo pipefail; samtools fastq -@ ${threads} -T MM,ML "/o/${rel}" | minimap2 -ax map-hifi -L -Y -y -t ${threads} "/w/${mmi}" - | samtools sort -@ ${threads} -T /w/st${i} -o "/w/${outBam}" -`],
      `stream-align cell ${i} (map-hifi)`);
    perCell.push(outBam);
  });

  // 2. merge cells (or rename single) + index
  const mergedBam = `${sample}.hifi.aligned.bam`;
  if (perCell.length === 1) {
    run('docker', ['run', '--rm', '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_ALIGN, '-c',
      `set -e; mv /w/${perCell[0]} /w/${mergedBam} && samtools index -@ ${threads} /w/${mergedBam}`], 'rename + index single cell');
  } else {
    run('docker', ['run', '--rm', '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_ALIGN, '-c',
      `set -e; samtools merge -@ ${threads} -f /w/${mergedBam} ${perCell.map((c) => '/w/' + c).join(' ')} && samtools index -@ ${threads} /w/${mergedBam}`], 'merge cells + index');
  }

  // 3. QC: mapped reads + MM tag fail-fast (the 5mC must survive for the orthogonal methylome)
  const mapped = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_ALIGN, '-c',
    `samtools view -c -F 0x904 /w/${mergedBam}`]) || '0';
  const mm = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_ALIGN, '-c',
    `samtools view /w/${mergedBam} | head -5000 | grep -c 'MM:Z:' || true`]) || '0';
  logLine(`[hifi-align] mapped(primary)=${mapped} MM:Z in first 5000=${mm}`);
  if (Number(mm) === 0) { logLine('[hifi-align] FAIL-FAST: aligned BAM has no MM:Z 5mC tags'); uploadAudit(); process.exit(8); }

  // 4. persist BAM + index + manifest
  run('gcloud', ['storage', 'cp', path.join(work, mergedBam), `${BIOWALLET_GCS}/${mergedBam}`], 'upload aligned HiFi BAM');
  run('gcloud', ['storage', 'cp', path.join(work, mergedBam + '.bai'), `${BIOWALLET_GCS}/${mergedBam}.bai`], 'upload BAM index');

  const manifest = {
    schema: 'genobank.hifialign.manifest/v1', pipeline: 'hifi-pbmm2-align',
    jobId, biosampleId: sample, creator: walletLc, status: 'OK',
    inputs: { hifi_bams: bams, reference: refRel },
    tools: { pbmm2: IMG_PBMM2, samtools: IMG_ALIGN },
    outputs: { aligned_bam: `${BIOWALLET_GCS}/${mergedBam}`, aligned_bai: `${BIOWALLET_GCS}/${mergedBam}.bai` },
    summary: { cells: bams.length, mapped_primary_reads: Number(mapped), mm_tags_preserved: Number(mm) > 0 },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  logLine(`[hifi-align] DONE: aligned HiFi BAM (${mapped} primary reads, MM preserved) -> ${BIOWALLET_GCS}/${mergedBam}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
