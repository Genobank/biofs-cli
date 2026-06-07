/**
 * biofs align-shard exec --sample <serial> --bams <csv> ...
 *
 * EXECUTOR verb: the VM-side runner for sharded long-read ONT alignment. biofs-node
 * spawns this via spawn('biofs', ['align-shard','exec', ...]). No orphan script.
 *
 * WHY THIS EXISTS (verified in minimap2 source + a live MM/ML gate, 2026-06-06):
 *   - minimap2/dorado chaining is per-read and only saturates ~30 of 88 cores on
 *     ultra-long ONT (too few concurrent ultra-long reads to fill the threads). A
 *     SINGLE aligner process leaves ~60% of an 88-core box idle. Running W concurrent
 *     aligner workers fills the machine, the verified cheap win before any GPU work.
 *   - `dorado aligner` ingests the modBAM directly and preserves the 5mCG/5hmCG MM/ML
 *     tags BYTE-IDENTICALLY (gate: 2046/2046 primary records identical to input). So
 *     there is NO `samtools fastq -T MM,ML | minimap2 -y` round-trip and NO CG-tag
 *     warning seam. The aligner never parses the tags; they ride the read record.
 *   - The merged aligned modBAM (MM/ML intact, coordinate-sorted + indexed) is
 *     PERSISTED to the biowallet GCS folder. That is the durable input the comethyl
 *     single-molecule pass and any re-pileup need, so a 300+ GiB alignment is never
 *     thrown away on a VM idle-stop.
 *
 * Pipeline per modBAM (LPT order, W concurrent workers, each pinned to nproc/W threads):
 *   dorado aligner -t T <ref.mmi> in_i.bam  >  aligned_i.unsorted.bam      (DORADO image)
 *   samtools sort  -@ T   aligned_i.unsorted.bam -o aligned_i.bam          (ALIGN image)
 * then serial: samtools merge -> merged.bam (+ index) -> upload modBAM -> optional modkit.
 *
 * Containers are named clara-alignshard-* so the clara.genobank.app live monitor
 * picks up the logs automatically (same convention as biofs methyl).
 *
 * AUDIT: merged modBAM + manifest + run.log + command.txt land in
 *   gs://<OUT_BUCKET>/biowallet/<WALLET_LC>/align-shard/<JOB_ID>/
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface AlignShardExecOptions {
  sample: string;
  bams: string;          // CSV of gs:// ONT modBAM URIs
  ref?: string;          // 'GRCh38' | 'auto'
  workers?: string;      // requested concurrent aligner workers; '' => auto from nproc
  modkit?: boolean;      // also run modkit pileup (5mCG/5hmCG bedMethyl) with QC gates
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

// IMG_ALIGN: samtools + minimap2 bundle (samtools >= 1.16 for sort/merge/-T).
const IMG_ALIGN  = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
// IMG_DORADO: ONT Dorado (modBAM-native aligner, preserves MM/ML; gate-verified).
const IMG_DORADO = 'ontresearch/dorado:latest';
const IMG_MODKIT = 'ontresearch/modkit:mr398_sha065267f74d9eb22402f5f6bde56e8a67bb32d526-amd64';
const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';

// ---- modkit-path QC gate floors (identical policy to biofs methyl) ----
const GATE_FIVEHMC_RATIO_MIN = 0.01;
const GATE_MEDIAN_COV_MIN    = 10;
const GATE_ALT_FRAC_MAX       = 0.005;
// ---- align-path gate: a sane mapped-read fraction (catches a broken alignment) ----
const GATE_MAPPED_FRAC_MIN    = 0.50;

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];

function logLine(msg: string): void {
  Logger.info(msg);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, msg + '\n'); } catch (_) {} }
}

function run(cmd: string, args: string[], label: string): void {
  const line = `${cmd} ${args.join(' ')}`;
  logLine(`[align-shard] ${label}`);
  COMMANDS.push(line);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${line}\n`); } catch (_) {} }
  const stdio: any = LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit';
  const r = spawnSync(cmd, args, { stdio });
  if (r.error) { logLine(`[align-shard] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[align-shard] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
}

function runAsync(cmd: string, args: string[], label: string, outFd?: number | null): Promise<void> {
  const line = `${cmd} ${args.join(' ')}`;
  logLine(`[align-shard] ${label}`);
  COMMANDS.push(line);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${line}\n`); } catch (_) {} }
  return new Promise<void>((resolve, reject) => {
    const fd = (outFd !== undefined && outFd !== null) ? outFd : LOG_FD;
    const stdio: any = fd !== null ? ['ignore', fd, fd] : 'inherit';
    const child = spawn(cmd, args, { stdio });
    child.on('error', (e) => { logLine(`[align-shard] ${label} could not start: ${e.message}`); reject(e); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else { logLine(`[align-shard] ${label} exited ${code}`); reject(new Error(`${label} exited ${code}`)); }
    });
  });
}

// dorado writes the aligned BAM to STDOUT; capture stdout -> bamFd, stderr -> logFd.
function runAsyncToFile(cmd: string, args: string[], bamPath: string, label: string, logFd: number | null): Promise<void> {
  const line = `${cmd} ${args.join(' ')} > ${bamPath}`;
  logLine(`[align-shard] ${label}`);
  COMMANDS.push(line);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${line}\n`); } catch (_) {} }
  return new Promise<void>((resolve, reject) => {
    let bamFd: number;
    try { bamFd = fs.openSync(bamPath, 'w'); } catch (e: any) { reject(e); return; }
    const errFd = logFd !== null ? logFd : (LOG_FD !== null ? LOG_FD : 'inherit');
    const child = spawn(cmd, args, { stdio: ['ignore', bamFd, errFd as any] });
    child.on('error', (e) => { try { fs.closeSync(bamFd); } catch (_) {} logLine(`[align-shard] ${label} could not start: ${e.message}`); reject(e); });
    child.on('close', (code) => {
      try { fs.closeSync(bamFd); } catch (_) {}
      if (code === 0) resolve();
      else { logLine(`[align-shard] ${label} exited ${code}`); reject(new Error(`${label} exited ${code}`)); }
    });
  });
}

function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return '';
  return (r.stdout || '').trim();
}

function gcsExists(gsUri: string): boolean { return capture('gcloud', ['storage', 'ls', gsUri]).length > 0; }
function gcsObjectSize(gsUri: string): number {
  const out = capture('gcloud', ['storage', 'ls', '-l', gsUri]);
  const m = /^\s*(\d+)\s/.exec(out);
  return m ? Number(m[1]) : 0;
}
function bamOk(work: string, basename: string): boolean {
  return capture('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
    cmd: ['-c', `samtools quickcheck "/work/${basename}" && echo ok || echo bad`] })) === 'ok';
}
function isMounted(mp: string): boolean { return capture('sh', ['-c', `mount | grep -F ' ${mp} ' || true`]).length > 0; }
function gcsfuseMountRO(bucket: string, mp: string): void {
  fs.mkdirSync(mp, { recursive: true });
  if (isMounted(mp)) { logLine(`[align-shard] gcsfuse already mounted: ${bucket} -> ${mp}`); return; }
  run('gcsfuse', ['--implicit-dirs', '--type-cache-max-size-mb=32', '--kernel-list-cache-ttl-secs=60', '-o', 'ro', bucket, mp], `gcsfuse mount ${bucket}`);
}
function resolveReferenceFasta(refMount: string): string {
  const candidates = [
    'GRCh38/human_GRCh38_no_alt_analysis_set.fasta',
    'human_GRCh38_no_alt_analysis_set.fasta',
    'GRCh38/Homo_sapiens_assembly38.fasta',
    'Homo_sapiens_assembly38.fasta',
    'hg38/Homo_sapiens_assembly38.fasta',
  ];
  for (const rel of candidates) {
    const p = path.join(refMount, rel);
    if (fs.existsSync(p)) { logLine(`[align-shard] reference resolved: ${p}`); return p; }
  }
  logLine(`[align-shard] no GRCh38 FASTA under ${refMount}. Tried: ${candidates.join(', ')}`);
  process.exit(1);
}
function dockerArgs(opts: { image: string; mounts: Array<[string, string, string]>; name?: string; entrypoint?: string; cmd: string[]; }): string[] {
  const args = ['run', '--rm'];
  if (opts.name) args.push('--name', opts.name);
  for (const [h, c, mode] of opts.mounts) args.push('-v', `${h}:${c}:${mode}`);
  if (opts.entrypoint !== undefined) args.push('--entrypoint', opts.entrypoint);
  args.push(opts.image, ...opts.cmd);
  return args;
}

// ---- the pipeline ---------------------------------------------------------

export async function alignShardExecCommand(opts: AlignShardExecOptions): Promise<void> {
  const sample    = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId     = opts.jobId   || `alignshard-${sample}-${Date.now()}`;
  const batchId   = opts.batchId || jobId;
  const walletLc  = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const jobShort  = jobId.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
  const runModkit = !!opts.modkit;

  const bamUris = (opts.bams || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (bamUris.length === 0) { Logger.error('[align-shard] --bams is empty'); process.exit(1); }

  const nproc = capture('nproc', []) || String(Math.max(1, os.cpus().length));
  // W concurrent aligner workers. Each ultra-long dorado/minimap2 process chaining-
  // saturates ~30 cores, so W ~ round(nproc/30) fills the box without oversubscribing
  // (88 -> 3). Clamp [2,6]. Never more workers than BAMs. Each worker pinned to
  // floor(nproc/W) threads (two -@nproc sorts would oversubscribe).
  const reqW = opts.workers && String(opts.workers).trim() !== '' ? parseInt(String(opts.workers), 10) : 0;
  const autoW = Math.min(6, Math.max(2, Math.round(Number(nproc) / 30)));
  const W = Math.min(bamUris.length, reqW && reqW > 0 ? reqW : autoW);
  const perJobThreads = String(Math.max(1, Math.floor(Number(nproc) / Math.max(1, W))));

  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/align-shard/${jobId}`;
  const mergedName    = `${sample}.ont.aligned.modBAM.bam`;
  const mergedBai     = `${mergedName}.bai`;
  const bedName       = `${sample}.5mCG_5hmCG.bedMethyl`;
  const bedGzName     = `${bedName}.gz`;
  const bedTbiName    = `${bedGzName}.tbi`;

  // Idempotency: skip only on a prior SUCCESS manifest (a prior FAILED run must rerun).
  if (gcsExists(`${BIOWALLET_GCS}/${mergedName}`)) {
    let priorStatus = '';
    try { priorStatus = (JSON.parse(capture('gcloud', ['storage', 'cat', `${BIOWALLET_GCS}/manifest.json`]) || '{}').status) || ''; } catch (_) {}
    if (priorStatus === 'SUCCESS') { Logger.info(`[align-shard] prior SUCCESS in GCS: ${BIOWALLET_GCS}/${mergedName}`); process.exit(0); }
    Logger.info(`[align-shard] prior merged modBAM present but status=${priorStatus || 'unknown'} — rerunning clean`);
  }

  const scratchRoot =
    (fs.existsSync('/mnt/scratch') && '/mnt/scratch') ||
    (fs.existsSync('/mnt/disks/scratch') && '/mnt/disks/scratch') ||
    (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `alignshard-${jobId}`);
  fs.mkdirSync(work, { recursive: true });

  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const cmdTxtPath = path.join(work, 'command.txt');
  const uploadAudit = (): void => {
    try { fs.writeFileSync(cmdTxtPath, COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' });
    spawnSync('gcloud', ['storage', 'cp', cmdTxtPath, `${BIOWALLET_GCS}/command.txt`], { stdio: 'ignore' });
  };

  logLine(`[align-shard] start sample=${sample} jobId=${jobId} nproc=${nproc} W=${W} perJobThreads=${perJobThreads} modkit=${runModkit}`);
  logLine(`[align-shard] biowallet folder: ${BIOWALLET_GCS}`);
  logLine(`[align-shard] scratch=${work}`);

  // 0. reference (gcsfuse RO) + map-ont .mmi (cached). dorado aligner accepts the .mmi
  //    directly (gate-verified). Building from the no-alt FASTA keeps the contig set
  //    clean (matches biofs methyl v2).
  const refMount = `/mnt/gcsfuse-alignshard-ref-${refBucket}`;
  gcsfuseMountRO(refBucket, refMount);
  const refFasta = resolveReferenceFasta(refMount);
  const refDir   = path.dirname(refFasta);
  const refBase  = path.basename(refFasta);
  const mmiName  = `${refBase}.map-ont.mmi`;
  const mmiPath  = path.join(work, mmiName);
  const mmiGcs   = `${BIOWALLET_GCS}/${mmiName}`;
  if (!fs.existsSync(mmiPath)) {
    if (gcsExists(mmiGcs)) {
      run('gcloud', ['storage', 'cp', mmiGcs, mmiPath], 'fetch cached .mmi');
    } else {
      run('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[refDir, '/ref', 'ro'], [work, '/work', 'rw']], entrypoint: 'minimap2',
        cmd: ['-x', 'map-ont', '-d', `/work/${mmiName}`, `/ref/${refBase}`] }), 'build minimap2 .mmi (map-ont)');
      run('gcloud', ['storage', 'cp', mmiPath, mmiGcs], 'cache .mmi to biowallet folder');
    }
  }

  // 1+2. per-BAM dorado alignment, W concurrent workers, largest-first (LPT).
  const alignedBams: string[] = new Array(bamUris.length);
  for (let i = 0; i < bamUris.length; i++) alignedBams[i] = path.join(work, `aligned_${i}.bam`);
  const sizes = bamUris.map((u) => gcsObjectSize(u));
  const order = bamUris.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a]);
  logLine(`[align-shard] align order (largest-first): ${order.map((i) => `${i}:${(sizes[i] / 1073741824).toFixed(1)}GiB`).join(' ')}`);

  let qi = 0;
  let aborted = false;
  const next = (): number | undefined => (qi < order.length && !aborted) ? order[qi++] : undefined;
  const killSiblingContainers = (): void => {
    for (let k = 0; k < bamUris.length; k++) {
      spawnSync('docker', ['kill', `clara-alignshard-${k}-${jobShort}`], { stdio: 'ignore' });
    }
  };

  async function alignOne(i: number, w: number, wfd: number | null): Promise<void> {
    const alignedName = `aligned_${i}.bam`;
    const alignedPath = alignedBams[i];
    const unsortedPath = path.join(work, `aligned_${i}.unsorted.bam`);
    const localBam = path.join(work, `in_${i}.bam`);
    // resume: trust a prior aligned BAM only if it passes samtools quickcheck.
    if (fs.existsSync(alignedPath)) {
      if (bamOk(work, alignedName)) { logLine(`[align-shard][w${w}] aligned BAM ${i} exists + quickcheck OK, skipping`); return; }
      logLine(`[align-shard][w${w}] aligned BAM ${i} failed quickcheck — re-aligning`);
      try { fs.rmSync(alignedPath, { force: true }); } catch (_) {}
    }
    if (fs.existsSync(localBam) && !bamOk(work, `in_${i}.bam`)) {
      try { fs.rmSync(localBam, { force: true }); } catch (_) {}
    }
    if (!fs.existsSync(localBam)) {
      logLine(`[align-shard][w${w}] staging modBAM ${i + 1}/${bamUris.length} to NVMe: ${bamUris[i]}`);
      await runAsync('gcloud', ['storage', 'cp', bamUris[i], localBam], `[w${w}] stage modBAM ${i} to NVMe`, wfd);
    }
    // dorado aligner: modBAM in -> aligned modBAM (MM/ML preserved) on stdout.
    logLine(`[align-shard][w${w}] dorado aligner modBAM ${i + 1}/${bamUris.length} (-t ${perJobThreads}, MM/ML preserved)`);
    await runAsyncToFile('docker',
      dockerArgs({ image: IMG_DORADO, name: `clara-alignshard-${i}-${jobShort}`,
        mounts: [[work, '/work', 'rw']], entrypoint: 'dorado',
        cmd: ['aligner', '-t', perJobThreads, `/work/${mmiName}`, `/work/in_${i}.bam`] }),
      unsortedPath, `[w${w}] dorado align modBAM ${i}`, wfd);
    // coordinate-sort for merge + modkit + indexing.
    await runAsync('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `set -euo pipefail; samtools sort -@ ${perJobThreads} -m 1G -o "/work/${alignedName}" "/work/aligned_${i}.unsorted.bam"`] }),
      `[w${w}] sort modBAM ${i}`, wfd);
    try { fs.rmSync(localBam, { force: true }); } catch (_) {}
    try { fs.rmSync(unsortedPath, { force: true }); } catch (_) {}
    // MM-tag survival check (methylation must not be lost).
    const mm = capture('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `samtools view "/work/${alignedName}" 2>/dev/null | head -5000 | grep -c "MM:Z:" || true`] }));
    if (!mm || parseInt(mm, 10) === 0) {
      aborted = true;
      logLine(`[align-shard][w${w}] FATAL: aligned_${i} has NO MM tags — methylation lost. Aborting.`);
      killSiblingContainers(); uploadAudit(); process.exit(3);
    }
    logLine(`[align-shard][w${w}] MM-tag check OK (${mm}/5000 reads carry MM:Z: in ${alignedName})`);
  }

  async function worker(w: number): Promise<void> {
    let wfd: number | null = null;
    try { wfd = fs.openSync(path.join(work, `align_w${w}.log`), 'a'); } catch (_) { wfd = null; }
    let i: number | undefined;
    while ((i = next()) !== undefined) {
      const idx = i;
      try { await alignOne(idx, w, wfd); }
      catch (e: any) {
        aborted = true;
        logLine(`[align-shard][w${w}] align modBAM ${idx} failed: ${e?.message || e}. Aborting siblings.`);
        killSiblingContainers();
        if (wfd !== null) { try { fs.closeSync(wfd); } catch (_) {} }
        uploadAudit(); process.exit(2);
      }
    }
    if (wfd !== null) { try { fs.closeSync(wfd); } catch (_) {} }
  }

  await Promise.all(Array.from({ length: W }, (_, w) => worker(w)));
  for (let w = 0; w < W; w++) {
    const p = path.join(work, `align_w${w}.log`);
    if (fs.existsSync(p)) spawnSync('gcloud', ['storage', 'cp', p, `${BIOWALLET_GCS}/align_w${w}.log`], { stdio: 'ignore' });
  }
  uploadAudit();

  // 3. merge + index (serial, full nproc) -> the durable aligned modBAM.
  const mergedPath = path.join(work, mergedName);
  const mergedBaiPath = path.join(work, mergedBai);
  if (!fs.existsSync(mergedPath) || !bamOk(work, mergedName)) {
    const mergeArgs = alignedBams.map((p) => `"/work/${path.basename(p)}"`).join(' ');
    run('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `set -euo pipefail; samtools merge -f -@ ${nproc} "/work/${mergedName}" ${mergeArgs} && samtools index -@ ${nproc} "/work/${mergedName}"`] }), 'merge + index aligned modBAM');
  }

  // mapped-read fraction (align-path sanity gate) + @SQ contig count + MM survival.
  const dockBash = (sh: string): string =>
    capture('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash', cmd: ['-c', sh] }));
  const mappedReads = Number(dockBash(`samtools view -c -F 4 -@ ${nproc} "/work/${mergedName}" 2>/dev/null || echo 0`) || '0');
  const totalReads  = Number(dockBash(`samtools view -c -@ ${nproc} "/work/${mergedName}" 2>/dev/null || echo 0`) || '0');
  const mappedFrac  = totalReads > 0 ? mappedReads / totalReads : 0;
  const nSq         = Number(dockBash(`samtools view -H "/work/${mergedName}" 2>/dev/null | grep -c "^@SQ" || true`) || '0');
  const mmMerged    = Number(dockBash(`samtools view "/work/${mergedName}" 2>/dev/null | head -20000 | grep -c "MM:Z:" || true`) || '0');
  logLine(`[align-shard] merged: total_reads=${totalReads} mapped=${mappedReads} mapped_frac=${mappedFrac.toFixed(4)} n_sq=${nSq} mm_in_20k=${mmMerged}`);

  // 4. PERSIST the durable aligned modBAM (+ index) to the biowallet folder. This is
  //    the artifact comethyl / re-pileup reuse, so it is never lost on a VM idle-stop.
  const alignGatePass = mappedFrac >= GATE_MAPPED_FRAC_MIN && mmMerged > 0 && bamOk(work, mergedName);
  if (alignGatePass) {
    run('gcloud', ['storage', 'cp', mergedPath, `${BIOWALLET_GCS}/${mergedName}`], 'upload merged aligned modBAM -> biowallet folder');
    if (fs.existsSync(mergedBaiPath)) run('gcloud', ['storage', 'cp', mergedBaiPath, `${BIOWALLET_GCS}/${mergedBai}`], 'upload .bai -> biowallet folder');
  } else {
    logLine(`[align-shard] ALIGN GATE FAILED (mapped_frac=${mappedFrac.toFixed(4)} mm_in_20k=${mmMerged}) — not publishing modBAM`);
  }

  // 5. optional modkit pileup (same hard QC gates as biofs methyl).
  let modkitBlock: any = null;
  let modkitGatesPassed = true;
  if (runModkit && alignGatePass) {
    const bedPath = path.join(work, bedName);
    run('docker', dockerArgs({ image: IMG_MODKIT, name: `clara-alignshard-modkit-${jobShort}`, mounts: [[work, '/work', 'rw'], [refDir, '/ref', 'ro']], entrypoint: 'modkit',
      cmd: ['pileup', '--cpg', '--combine-strands', '--ref', `/ref/${refBase}`, '-t', nproc, `/work/${mergedName}`, `/work/${bedName}`] }), 'modkit pileup 5mCG/5hmCG');
    const bedGzPath = path.join(work, bedGzName);
    run('docker', dockerArgs({ image: IMG_HTSLIB, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `set -euo pipefail; bgzip -f -@ ${nproc} "/work/${bedName}" && tabix -p bed "/work/${bedGzName}"`] }), 'bgzip + tabix');
    const qcMain = capture('sh', ['-c',
      `zcat "${bedGzPath}" 2>/dev/null | awk '{ code=$4; chr=$1; cov=$10+0; nmod=$12+0; ` +
      `if(code=="m"){mrows++} else if(code=="h"){hrows++} ` +
      `if(chr ~ /^chr([1-9]|1[0-9]|2[0-2]|X|Y|M)$/){prim++} else {alt++} ` +
      `if(code=="m" && chr ~ /^chr([1-9]|1[0-9]|2[0-2])$/){mauto++; if(cov>=10)c10++} } ` +
      `END{ printf "%d %d %d %d %.8f", mrows+0, hrows+0, mauto+0, (mauto>0?c10:0), ((prim+alt)>0?alt/(prim+alt):0) }'`]) || '0 0 0 0 0';
    const g = qcMain.split(/\s+/);
    const mrows = Number(g[0]) || 0, hrows = Number(g[1]) || 0, mAuto = Number(g[2]) || 0, altFrac = Number(g[4]) || 0;
    const medianStr = capture('sh', ['-c',
      `f(){ zcat "${bedGzPath}" 2>/dev/null | awk '$4=="m" && $1 ~ /^chr([1-9]|1[0-9]|2[0-2])$/ {print $10}' | sort -n; }; ` +
      `M=$(f | wc -l); if [ "$M" -eq 0 ]; then echo 0; elif [ $((M%2)) -eq 1 ]; then f | sed -n "$(((M+1)/2))p"; ` +
      `else f | sed -n "$((M/2))p;$((M/2+1))p" | awk '{s+=$1} END{print s/2}'; fi`]);
    const medianCov = Number(medianStr) || 0;
    const fivehmCPresent = hrows > 0 && hrows >= GATE_FIVEHMC_RATIO_MIN * mrows;
    const coveragePass = medianCov >= GATE_MEDIAN_COV_MIN;
    const altContigPass = altFrac <= GATE_ALT_FRAC_MAX;
    modkitGatesPassed = fivehmCPresent && coveragePass && altContigPass;
    modkitBlock = { m_rows: mrows, h_rows: hrows, autosomal_cpg: mAuto, median_cov: medianCov, alt_frac: altFrac,
      fivehmC_present: fivehmCPresent, coverage_pass: coveragePass, alt_contig_pass: altContigPass, gates_passed: modkitGatesPassed };
    logLine(`[align-shard] modkit QC: m=${mrows} h=${hrows} median_cov=${medianCov} alt_frac=${altFrac} gates_passed=${modkitGatesPassed}`);
    if (modkitGatesPassed) {
      run('gcloud', ['storage', 'cp', bedGzPath, `${BIOWALLET_GCS}/${bedGzName}`], 'upload bedMethyl.gz -> biowallet folder');
      run('gcloud', ['storage', 'cp', path.join(work, bedTbiName), `${BIOWALLET_GCS}/${bedTbiName}`], 'upload bedMethyl.tbi -> biowallet folder');
    } else {
      logLine('[align-shard] modkit QC gates FAILED — not publishing bedMethyl');
    }
  }

  // 6. manifest
  const gatesPassed = alignGatePass && (!runModkit || modkitGatesPassed);
  const manifest: any = {
    schema: 'genobank.alignshard.manifest/v1',
    pipeline: 'ont-align-shard-dorado',
    jobId, batchId, biosampleId: sample, creator: walletLc,
    status: gatesPassed ? 'SUCCESS' : 'FAILED',
    aligner: `dorado aligner (modBAM-native, MM/ML preserved; W=${W} concurrent, ${perJobThreads} threads/worker)`,
    reference: { build: opts.ref || 'GRCh38', fasta: refBase, mmi: mmiName, n_sq_contigs: nSq },
    inputs: { ont_bams: bamUris, n_bams: bamUris.length },
    tools: { dorado: IMG_DORADO, align: IMG_ALIGN, modkit: runModkit ? IMG_MODKIT : null, htslib: runModkit ? IMG_HTSLIB : null },
    alignment: { total_reads: totalReads, mapped_reads: mappedReads, mapped_fraction: mappedFrac, mapped_frac_min: GATE_MAPPED_FRAC_MIN, mm_tag_survives: mmMerged > 0 },
    biowalletFolder: BIOWALLET_GCS,
    outputs: {
      merged_modBAM: alignGatePass ? `${BIOWALLET_GCS}/${mergedName}` : null,
      merged_modBAM_bai: alignGatePass ? `${BIOWALLET_GCS}/${mergedBai}` : null,
      mmi: mmiGcs,
      bedMethyl: (runModkit && modkitGatesPassed) ? `${BIOWALLET_GCS}/${bedGzName}` : null,
      run_log: `${BIOWALLET_GCS}/run.log`, commands: `${BIOWALLET_GCS}/command.txt`,
    },
    modkit: modkitBlock,
    commands: COMMANDS,
    createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest -> biowallet folder');

  if (!gatesPassed) {
    logLine('[align-shard] GATES FAILED (hard-block): job NOT eligible to anchor.');
    if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
    uploadAudit(); process.exit(7);
  }

  logLine(`[align-shard] DONE sample=${sample} merged_modBAM=${BIOWALLET_GCS}/${mergedName} mapped_frac=${mappedFrac.toFixed(4)}${runModkit ? ` bedMethyl=${BIOWALLET_GCS}/${bedGzName}` : ''}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  uploadAudit();
  process.exit(0);
}
