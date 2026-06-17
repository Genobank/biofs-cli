/**
 * biofs methyl exec --sample <serial> --bams <csv> ...
 *
 * EXECUTOR verb: the VM-side runner for the ONT 5mCG/5hmCG methylation pipeline.
 * biofs-node spawns this via `spawn('biofs', ['methyl','exec', ...])`. No orphan
 * shell script — the runner logic lives here, npm-versioned and auditable.
 *
 * ALIGNMENT IS CPU (per ONT docs): Oxford Nanopore's own wf-human-variation runs
 * alignment + modkit on CPU (recommended 32 CPU / 128 GB, no GPU); long-read
 * chaining is CPU-bound and NVIDIA Parabricks does NOT GPU-accelerate it (verified
 * 0% GPU util on ultra-long reads). So this runs on a high-core CPU instance with a
 * STREAMED minimap2 pipe (no on-disk FASTQ):
 *
 *   samtools fastq -T MM,ML <modBAM>  |  minimap2 -ax map-ont -L -y  |  samtools sort
 *
 *   - `-T MM,ML` carries the Dorado base-mod tags out as FASTQ comments.
 *   - `-y` copies those comments back into BAM aux tags (mods preserved end-to-end).
 *   - `-L` is MANDATORY for ULTRA-LONG ONT: ~1% of reads have CIGARs too long for
 *     BAM; -L moves them to a CG tag so BAM conversion does not error/corrupt
 *     (per the minimap2 README). Then modkit pileup keeps BOTH 5mC and 5hmC.
 *
 * v2 (2026-06-05): a single ultra-long minimap2 only saturates ~32 of an 88-core
 * box (chaining-bound), so v2 runs N=2 alignments CONCURRENTLY (in-node worker
 * pool, largest-BAM-first) inside this one process — ~2x faster, zero new VMs,
 * each job pinned to nproc/N threads. v2 also adds hard QC GATES (5hmC survival,
 * per-CpG coverage, alt-contig fraction): a run that fails them is marked FAILED,
 * its bedMethyl is NOT published, and it exits non-zero so biofs-node will NOT
 * anchor its ClaraJobNFT.
 *
 * Containers are named `clara-methyl-*` so the existing clara.genobank.app live
 * monitor shows the alignment log automatically.
 *
 * AUDIT: outputs + manifest + run.log + command.txt all land in the biowallet folder
 *   gs://<OUT_BUCKET>/biowallet/<WALLET_LC>/methyl/<JOB_ID>/
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface MethylExecOptions {
  sample: string;
  bams: string;          // CSV of gs:// ONT modBAM URIs
  ref?: string;          // 'GRCh38' | 'auto'
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

// IMG_ALIGN: biocontainers mulled bundle — minimap2 2.31 + samtools 1.23.1
// (samtools >= 1.16 required for -T MM,ML; minimap2 supports -L/-y/map-ont).
const IMG_ALIGN  = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_MODKIT = 'ontresearch/modkit:mr398_sha065267f74d9eb22402f5f6bde56e8a67bb32d526-amd64';
const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';

// ---- v2 QC gate floors (policy, confirmed by Daniel 2026-06-05) ----
const GATE_FIVEHMC_RATIO_MIN = 0.01; // h rows must be >=1% of m rows (survival check)
const GATE_MEDIAN_COV_MIN    = 10;   // median per-CpG autosomal valid coverage
const GATE_ALT_FRAC_MAX       = 0.005; // <=0.5% of calls off the primary chromosomes

// ---- run log / command capture (uploaded to the biowallet folder for audit) ----
let LOG_FD: number | null = null;
const COMMANDS: string[] = [];

function logLine(msg: string): void {
  Logger.info(msg);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, msg + '\n'); } catch (_) {} }
}

// Synchronous run (serial stages: reference, merge, modkit, bgzip, uploads).
function run(cmd: string, args: string[], label: string): void {
  const line = `${cmd} ${args.join(' ')}`;
  logLine(`[methyl] ${label}`);
  COMMANDS.push(line);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${line}\n`); } catch (_) {} }
  const stdio: any = LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit';
  const r = spawnSync(cmd, args, { stdio });
  if (r.error) { logLine(`[methyl] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[methyl] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
}

// Async run (concurrent alignment workers). Rejects on non-zero exit so a failing
// worker can abort its siblings cleanly instead of exiting from inside a child.
// The stage markers + command go to the shared run.log; the verbose child stdout/
// stderr goes to `outFd` (a per-worker file) so two concurrent jobs do not garble
// run.log (POSIX only guarantees atomic writes under ~4 KB).
function runAsync(cmd: string, args: string[], label: string, outFd?: number | null): Promise<void> {
  const line = `${cmd} ${args.join(' ')}`;
  logLine(`[methyl] ${label}`);
  COMMANDS.push(line);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${line}\n`); } catch (_) {} }
  return new Promise<void>((resolve, reject) => {
    const fd = (outFd !== undefined && outFd !== null) ? outFd : LOG_FD;
    const stdio: any = fd !== null ? ['ignore', fd, fd] : 'inherit';
    const child = spawn(cmd, args, { stdio });
    child.on('error', (e) => { logLine(`[methyl] ${label} could not start: ${e.message}`); reject(e); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else { logLine(`[methyl] ${label} exited ${code}`); reject(new Error(`${label} exited ${code}`)); }
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
  // `gcloud storage ls -l` prints "  <bytes>  <date>  <uri>"; parse the leading byte count.
  const out = capture('gcloud', ['storage', 'ls', '-l', gsUri]);
  const m = /^\s*(\d+)\s/.exec(out);
  return m ? Number(m[1]) : 0;
}

// samtools quickcheck inside the align image; returns true only if the BAM is
// structurally complete (catches a truncated file from an interrupted run/stage).
function bamOk(work: string, basename: string): boolean {
  return capture('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
    cmd: ['-c', `samtools quickcheck "/work/${basename}" && echo ok || echo bad`] })) === 'ok';
}

function isMounted(mp: string): boolean { return capture('sh', ['-c', `mount | grep -F ' ${mp} ' || true`]).length > 0; }

function gcsfuseMountRO(bucket: string, mp: string): void {
  fs.mkdirSync(mp, { recursive: true });
  if (isMounted(mp)) { logLine(`[methyl] gcsfuse already mounted: ${bucket} -> ${mp}`); return; }
  run('gcsfuse', ['--implicit-dirs', '--type-cache-max-size-mb=32', '--kernel-list-cache-ttl-secs=60', '-o', 'ro', bucket, mp], `gcsfuse mount ${bucket}`);
}

function resolveReferenceFasta(refMount: string, ref?: string): string {
  // honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; anything else -> GRCh38 (default, unchanged).
  const wantsCHM13 = /^(chm13|t2t)/.test((ref || 'auto').toLowerCase());
  const candidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : [
      'GRCh38/human_GRCh38_no_alt_analysis_set.fasta',
      'human_GRCh38_no_alt_analysis_set.fasta',
      'GRCh38/Homo_sapiens_assembly38.fasta',
      'Homo_sapiens_assembly38.fasta',
      'hg38/Homo_sapiens_assembly38.fasta',
    ];
  for (const rel of candidates) {
    const p = path.join(refMount, rel);
    if (fs.existsSync(p)) { logLine(`[methyl] reference resolved: ${p}`); return p; }
  }
  logLine(`[methyl] no reference FASTA (ref=${ref || 'auto'}) found under ${refMount}. Tried: ${candidates.join(', ')}`);
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

export async function methylExecCommand(opts: MethylExecOptions): Promise<void> {
  const sample    = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId     = opts.jobId   || `methyl-${sample}-${Date.now()}`;
  const batchId   = opts.batchId || jobId;
  const walletLc  = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const jobShort  = jobId.replace(/[^a-zA-Z0-9]/g, '').slice(-12);

  const bamUris = (opts.bams || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (bamUris.length === 0) { Logger.error('[methyl] --bams is empty'); process.exit(1); }

  const nproc = capture('nproc', []) || String(Math.max(1, os.cpus().length));
  // v2 concurrency: run N alignments at once; each ultra-long minimap2 saturates
  // ~32 cores, so N=2 fully uses an 88-core box with zero contention. Pin each
  // job to nproc/N threads (MANDATORY: two -@nproc sorts would oversubscribe).
  const N = Math.min(2, bamUris.length);
  const perJobThreads = String(Math.max(1, Math.floor(Number(nproc) / Math.max(1, N))));

  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/methyl/${jobId}`;
  const bedName    = `${sample}.5mCG_5hmCG.bedMethyl`;
  const bedGzName  = `${bedName}.gz`;
  const bedTbiName = `${bedGzName}.tbi`;

  // Idempotency: only treat a prior run as a success-skip when its manifest says
  // SUCCESS. A prior QC-FAILED run must NOT be skipped — skipping it would turn a
  // non-zero exit into exit 0 and let biofs-node anchor a methylome that failed
  // its hard gates. (Plain bedGz-existence is not enough; the FAILED branch below
  // deliberately does NOT publish bedGz, but defend anyway.)
  if (gcsExists(`${BIOWALLET_GCS}/${bedGzName}`)) {
    let priorStatus = '';
    try { priorStatus = (JSON.parse(capture('gcloud', ['storage', 'cat', `${BIOWALLET_GCS}/manifest.json`]) || '{}').status) || ''; } catch (_) {}
    if (priorStatus === 'SUCCESS') { Logger.info(`[methyl] prior SUCCESS in GCS: ${BIOWALLET_GCS}/${bedGzName}`); process.exit(0); }
    Logger.info(`[methyl] prior outputs present but status=${priorStatus || 'unknown'} — rerunning clean`);
    spawnSync('gcloud', ['storage', 'rm', `${BIOWALLET_GCS}/${bedGzName}`, `${BIOWALLET_GCS}/${bedTbiName}`], { stdio: 'ignore' });
  }

  const scratchRoot =
    (fs.existsSync('/mnt/scratch') && '/mnt/scratch') ||
    (fs.existsSync('/mnt/disks/scratch') && '/mnt/disks/scratch') ||
    (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `methyl-${jobId}`);
  fs.mkdirSync(work, { recursive: true });

  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const cmdTxtPath = path.join(work, 'command.txt');
  const uploadAudit = (): void => {
    try { fs.writeFileSync(cmdTxtPath, COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' });
    spawnSync('gcloud', ['storage', 'cp', cmdTxtPath, `${BIOWALLET_GCS}/command.txt`], { stdio: 'ignore' });
  };

  logLine(`[methyl] start sample=${sample} jobId=${jobId} nproc=${nproc} N=${N} perJobThreads=${perJobThreads}`);
  logLine(`[methyl] biowallet folder (outputs+logs+commands): ${BIOWALLET_GCS}`);
  logLine(`[methyl] scratch=${work}`);

  // 0. reference (gcsfuse RO) + .mmi (map-ont, cached)
  const refMount = `/mnt/gcsfuse-methyl-ref-${refBucket}`;
  gcsfuseMountRO(refBucket, refMount);
  const refFasta = resolveReferenceFasta(refMount, opts.ref);
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

  // 1+2. per-BAM CPU alignment, STREAMED from local NVMe (no on-disk FASTQ):
  //   samtools fastq -T MM,ML | minimap2 -ax map-ont -L -y | samtools sort
  // v2: N concurrent workers pull from a largest-BAM-first queue (LPT) so the
  // makespan approaches sum/N (floored by the single biggest BAM). Each staged
  // input BAM is deleted right after its alignment to bound NVMe.
  const alignedBams: string[] = new Array(bamUris.length);
  for (let i = 0; i < bamUris.length; i++) alignedBams[i] = path.join(work, `aligned_${i}.bam`);

  // LPT ordering: largest modBAM first so workers never finish a tiny BAM and idle.
  const sizes = bamUris.map((u) => gcsObjectSize(u));
  const order = bamUris.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a]);
  logLine(`[methyl] align order (largest-first): ${order.map((i) => `${i}:${(sizes[i] / 1073741824).toFixed(1)}GiB`).join(' ')}`);

  let qi = 0;
  let aborted = false;
  const next = (): number | undefined => (qi < order.length && !aborted) ? order[qi++] : undefined;

  const killSiblingContainers = (): void => {
    for (let k = 0; k < bamUris.length; k++) {
      spawnSync('docker', ['kill', `clara-methyl-align-${k}-${jobShort}`], { stdio: 'ignore' });
    }
  };

  async function alignOne(i: number, w: number, wfd: number | null): Promise<void> {
    const alignedName = `aligned_${i}.bam`;
    const alignedPath = alignedBams[i];
    const localBam = path.join(work, `in_${i}.bam`);
    // resume: trust a prior aligned BAM ONLY if it passes samtools quickcheck
    // (a truncated file from an interrupted run would silently poison the merge).
    if (fs.existsSync(alignedPath)) {
      if (bamOk(work, alignedName)) { logLine(`[methyl][w${w}] aligned BAM ${i} exists + quickcheck OK, skipping`); return; }
      logLine(`[methyl][w${w}] aligned BAM ${i} exists but FAILED quickcheck — re-aligning`);
      try { fs.rmSync(alignedPath, { force: true }); } catch (_) {}
    }
    // a half-staged input BAM is also unusable — re-stage it
    if (fs.existsSync(localBam) && !bamOk(work, `in_${i}.bam`)) {
      logLine(`[methyl][w${w}] staged in_${i}.bam failed quickcheck — re-staging`);
      try { fs.rmSync(localBam, { force: true }); } catch (_) {}
    }
    if (!fs.existsSync(localBam)) {
      logLine(`[methyl][w${w}] staging BAM ${i + 1}/${bamUris.length} to NVMe scratch: ${bamUris[i]}`);
      await runAsync('gcloud', ['storage', 'cp', bamUris[i], localBam], `[w${w}] stage BAM ${i} to NVMe`, wfd);
    }
    logLine(`[methyl][w${w}] aligning BAM ${i + 1}/${bamUris.length} (CPU minimap2 -ax map-ont -L -y -K 2g, -t ${perJobThreads}, NVMe-fed)`);
    const pipe =
      `set -euo pipefail; ` +
      `samtools fastq -@ ${perJobThreads} -T MM,ML "/work/in_${i}.bam" ` +
      `| minimap2 -ax map-ont -L -y -K 2g -t ${perJobThreads} "/work/${mmiName}" - ` +
      `| samtools sort -@ ${perJobThreads} -m 1G -o "/work/${alignedName}" -`;
    await runAsync('docker', dockerArgs({ image: IMG_ALIGN, name: `clara-methyl-align-${i}-${jobShort}`,
      mounts: [[work, '/work', 'rw']], entrypoint: 'bash', cmd: ['-c', pipe] }), `[w${w}] align BAM ${i}`, wfd);
    try { fs.rmSync(localBam, { force: true }); } catch (_) { /* best effort */ }
    // per-worker MM-tag check: validate WHICHEVER BAM this worker just produced
    // (with concurrency the first-finished BAM is not deterministically index 0).
    const mm = capture('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `samtools view "/work/${alignedName}" 2>/dev/null | head -5000 | grep -c "MM:Z:" || true`] }));
    if (!mm || parseInt(mm, 10) === 0) {
      aborted = true;
      logLine(`[methyl][w${w}] FATAL: aligned_${i} has NO MM tags — methylation lost. Aborting.`);
      killSiblingContainers();
      uploadAudit();
      process.exit(3);
    }
    logLine(`[methyl][w${w}] MM-tag check OK (${mm}/5000 reads carry MM:Z: in ${alignedName})`);
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
        logLine(`[methyl][w${w}] align BAM ${idx} failed: ${e?.message || e}. Aborting siblings.`);
        killSiblingContainers();
        if (wfd !== null) { try { fs.closeSync(wfd); } catch (_) {} }
        uploadAudit();
        process.exit(2);
      }
    }
    if (wfd !== null) { try { fs.closeSync(wfd); } catch (_) {} }
  }

  await Promise.all(Array.from({ length: N }, (_, w) => worker(w)));

  // upload the per-worker concurrent-phase align logs (kept out of run.log to
  // avoid garbling); best-effort, audit only.
  for (let w = 0; w < N; w++) {
    const p = path.join(work, `align_w${w}.log`);
    if (fs.existsSync(p)) spawnSync('gcloud', ['storage', 'cp', p, `${BIOWALLET_GCS}/align_w${w}.log`], { stdio: 'ignore' });
  }
  uploadAudit();

  // 3. merge + index (serial; full nproc)
  const mergedName = 'merged.bam';
  const mergedPath = path.join(work, mergedName);
  if (!fs.existsSync(mergedPath) || !bamOk(work, mergedName)) {
    const mergeArgs = alignedBams.map((p) => `"/work/${path.basename(p)}"`).join(' ');
    run('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `set -euo pipefail; samtools merge -f -@ ${nproc} "/work/${mergedName}" ${mergeArgs} && samtools index -@ ${nproc} "/work/${mergedName}"`] }), 'merge + index');
  }

  // 4. modkit pileup --cpg --combine-strands (keeps BOTH 5mC and 5hmC)
  const bedPath = path.join(work, bedName);
  if (!fs.existsSync(bedPath)) {
    run('docker', dockerArgs({ image: IMG_MODKIT, name: `clara-methyl-modkit-${jobShort}`, mounts: [[work, '/work', 'rw'], [refDir, '/ref', 'ro']], entrypoint: 'modkit',
      cmd: ['pileup', '--cpg', '--combine-strands', '--ref', `/ref/${refBase}`, '-t', nproc, `/work/${mergedName}`, `/work/${bedName}`] }), 'modkit pileup 5mCG/5hmCG');
  }

  // 5. bgzip + tabix
  const bedGzPath  = path.join(work, bedGzName);
  const bedTbiPath = path.join(work, bedTbiName);
  if (!fs.existsSync(bedGzPath)) {
    run('docker', dockerArgs({ image: IMG_HTSLIB, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
      cmd: ['-c', `set -euo pipefail; bgzip -f -@ ${nproc} "/work/${bedName}" && tabix -p bed "/work/${bedGzName}"`] }), 'bgzip + tabix');
  }

  // 6. QC: BOTH 5mC and 5hmC, per-CpG coverage, alt-contig fraction. modkit
  //    bedMethyl cols: $4 mod code (m=5mC, h=5hmC), $10 valid_coverage, $12 N_modified.
  logLine('[methyl] computing QC (5mCG/5hmCG, coverage, alt-contig fraction)');
  const qcMain = capture('sh', ['-c',
    `zcat "${bedGzPath}" 2>/dev/null | awk '` +
    `{ code=$4; chr=$1; cov=$10+0; nmod=$12+0; ` +
    `  if(code=="m"){mrows++} else if(code=="h"){hrows++} ` +
    `  if(chr ~ /^chr([1-9]|1[0-9]|2[0-2]|X|Y|M)$/){prim++} else {alt++} ` +
    `  if(code=="m" && chr ~ /^chr([1-9]|1[0-9]|2[0-2])$/){mauto++; mcov+=cov; mmod+=nmod; if(cov>=10)c10++; if(cov>=20)c20++} ` +
    `  if(code=="h" && chr ~ /^chr([1-9]|1[0-9]|2[0-2])$/){hcov+=cov; hmod+=nmod} } ` +
    `END{ printf "%d %d %.6f %.6f %d %.6f %.6f %d %d %d %d %.8f %d %d", ` +
    `  mrows+0, hrows+0, (mcov>0?100*mmod/mcov:0), (hcov>0?100*hmod/hcov:0), mauto+0, ` +
    `  (mauto>0?c10/mauto:0), (mauto>0?c20/mauto:0), mmod+0, mcov+0, hmod+0, hcov+0, ` +
    `  ((prim+alt)>0?alt/(prim+alt):0), prim+0, alt+0 }'`,
  ]) || '0 0 0 0 0 0 0 0 0 0 0 0 0 0';
  const f = qcMain.split(/\s+/);
  const mrows = Number(f[0]) || 0, hrows = Number(f[1]) || 0;
  const pct5mCG = Number(f[2]) || 0, pct5hmCG = Number(f[3]) || 0;
  const mAuto = Number(f[4]) || 0, frac10 = Number(f[5]) || 0, frac20 = Number(f[6]) || 0;
  const mmod = Number(f[7]) || 0, mcov = Number(f[8]) || 0, hmod = Number(f[9]) || 0, hcov = Number(f[10]) || 0;
  const altFrac = Number(f[11]) || 0, primRows = Number(f[12]) || 0, altRows = Number(f[13]) || 0;

  // median per-CpG autosomal valid coverage (m rows only). STREAMING (sort twice,
  // never materialize the array) so it cannot OOM on ~28M CpGs and silently emit
  // 0 -> a false coverage-gate failure.
  const medianStr = capture('sh', ['-c',
    `f() { zcat "${bedGzPath}" 2>/dev/null | awk '$4=="m" && $1 ~ /^chr([1-9]|1[0-9]|2[0-2])$/ {print $10}' | sort -n; }; ` +
    `M=$(f | wc -l); ` +
    `if [ "$M" -eq 0 ]; then echo 0; ` +
    `elif [ $((M%2)) -eq 1 ]; then f | sed -n "$(((M+1)/2))p"; ` +
    `else f | sed -n "$((M/2))p;$((M/2+1))p" | awk '{s+=$1} END{print s/2}'; fi`,
  ]);
  const medianCov = Number(medianStr) || 0;

  // reference identity: @SQ contig count from the merged BAM header (~195 no-alt, 3366 with-alt)
  const nSq = capture('docker', dockerArgs({ image: IMG_ALIGN, mounts: [[work, '/work', 'rw']], entrypoint: 'bash',
    cmd: ['-c', `samtools view -H "/work/${mergedName}" 2>/dev/null | grep -c "^@SQ" || true`] }));
  const nSqContigs = Number(nSq) || 0;

  // modkit effective min-mapq (from its stderr banner captured in run.log; informational)
  const mqStr = capture('sh', ['-c', `grep -ioE 'min[_-]?mapq[ =:]+[0-9]+' "${runLogPath}" 2>/dev/null | grep -oE '[0-9]+' | tail -1 || true`]);
  const minMapq: number | null = mqStr ? Number(mqStr) : null;

  // ---- hard gates ----
  const fivehmCPresent = hrows > 0 && hrows >= GATE_FIVEHMC_RATIO_MIN * mrows;
  const coveragePass   = medianCov >= GATE_MEDIAN_COV_MIN;
  const altContigPass  = altFrac <= GATE_ALT_FRAC_MAX;
  const gateFailures: string[] = [];
  if (!fivehmCPresent) gateFailures.push(`5hmC absent or <${GATE_FIVEHMC_RATIO_MIN * 100}% of 5mC rows (h=${hrows}, m=${mrows})`);
  if (!coveragePass)   gateFailures.push(`median per-CpG coverage ${medianCov}x < ${GATE_MEDIAN_COV_MIN}x`);
  if (!altContigPass)  gateFailures.push(`alt-contig call fraction ${altFrac} > ${GATE_ALT_FRAC_MAX}`);
  const gatesPassed = fivehmCPresent && coveragePass && altContigPass;
  logLine(`[methyl] QC: autosomal%5mCG=${pct5mCG.toFixed(3)} autosomal%5hmCG=${pct5hmCG.toFixed(3)} m_rows=${mrows} h_rows=${hrows} ` +
    `median_cov=${medianCov} frac>=10x=${frac10.toFixed(3)} alt_frac=${altFrac} n_sq=${nSqContigs} gates_passed=${gatesPassed}`);
  if (!gatesPassed) logLine(`[methyl] QC GATE FAILURES: ${gateFailures.join(' | ')}`);

  // 7. manifest.json
  const manifest: any = {
    schema: 'genobank.methyl.manifest/v4',
    pipeline: 'ont-methylation-minimap2-modkit',
    jobId, batchId, biosampleId: sample, creator: walletLc,
    status: gatesPassed ? 'SUCCESS' : 'FAILED',
    aligner: `minimap2 -ax map-ont -L -y -K 2g (CPU; N=${N} concurrent, ${perJobThreads} threads/job)`,
    reference: { build: opts.ref || 'GRCh38', fasta: refBase, n_sq_contigs: nSqContigs },
    inputs: { ont_bams: bamUris, n_bams: bamUris.length },
    tools: { align: IMG_ALIGN, modkit: IMG_MODKIT, htslib: IMG_HTSLIB },
    modkit: { args: ['pileup', '--cpg', '--combine-strands'], retains: ['5mC', '5hmC'], min_mapq: minMapq },
    biowalletFolder: BIOWALLET_GCS,
    outputs: { bedMethyl: `${BIOWALLET_GCS}/${bedGzName}`, bedMethyl_tbi: `${BIOWALLET_GCS}/${bedTbiName}`, mmi: mmiGcs, run_log: `${BIOWALLET_GCS}/run.log`, commands: `${BIOWALLET_GCS}/command.txt` },
    commands: COMMANDS,
    summary: {
      autosomal_percent_5mCG: pct5mCG,
      autosomal_percent_5hmCG: pct5hmCG,
      n_mod_calls_5mCG: mmod, n_valid_cov_5mCG: mcov,
      n_mod_calls_5hmCG: hmod, n_valid_cov_5hmCG: hcov,
      mod_code_row_counts: { m: mrows, h: hrows },
    },
    coverage: {
      autosomal_cpg_count: mAuto,
      median_valid_cov: medianCov,
      frac_cpg_ge_10x: frac10,
      frac_cpg_ge_20x: frac20,
    },
    qc: {
      fivehmC_present: fivehmCPresent,
      hmC_to_mC_row_ratio: mrows > 0 ? hrows / mrows : 0,
      coverage_pass: coveragePass,
      alt_contig_call_fraction: altFrac,
      alt_contig_pass: altContigPass,
      primary_rows: primRows, alt_rows: altRows,
      gates_passed: gatesPassed,
      gate_failures: gateFailures,
      gate_floors: { fivehmC_ratio_min: GATE_FIVEHMC_RATIO_MIN, median_cov_min: GATE_MEDIAN_COV_MIN, alt_frac_max: GATE_ALT_FRAC_MAX },
    },
    createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 8. publish. The bedMethyl.gz/.tbi are published ONLY on a gate PASS (a failed
  //    methylome must never be the artifact a future run keys off / anchors). The
  //    manifest (incl. FAILED status + the QC numbers) and the audit are ALWAYS
  //    uploaded so the failure is diagnosable. The non-zero exit on FAIL is what
  //    stops biofs-node from anchoring the ClaraJobNFT.
  if (gatesPassed) {
    run('gcloud', ['storage', 'cp', bedGzPath, `${BIOWALLET_GCS}/${bedGzName}`], 'upload bedMethyl.gz -> biowallet folder');
    run('gcloud', ['storage', 'cp', bedTbiPath, `${BIOWALLET_GCS}/${bedTbiName}`], 'upload bedMethyl.tbi -> biowallet folder');
  } else {
    logLine('[methyl] QC gates FAILED — NOT publishing bedMethyl.gz (manifest + log only; data kept on executor scratch)');
  }
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest -> biowallet folder');

  if (!gatesPassed) {
    logLine(`[methyl] QC GATES FAILED (hard-block): ${gateFailures.join('; ')}. Job NOT eligible to anchor.`);
    if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
    uploadAudit();
    process.exit(7); // non-zero: biofs-node marks the job failed and does NOT mint the ClaraJobNFT
  }

  logLine(`[methyl] DONE sample=${sample} bedMethyl=${BIOWALLET_GCS}/${bedGzName} autosomal%5mCG=${pct5mCG.toFixed(3)} autosomal%5hmCG=${pct5hmCG.toFixed(3)} median_cov=${medianCov}x`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  uploadAudit();
  process.exit(0);
}
