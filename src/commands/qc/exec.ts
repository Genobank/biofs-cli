/**
 * biofs qc exec --sample <serial> --inputs <gs://a.bam,gs://b.fa.gz,...> [--genome-size 3100000000]
 *
 * EXECUTOR verb: VM-side long-read QC. biofs-node spawns this; no orphan script. Each input is
 * streamed straight from the gcsfuse RO mount (the 400 GB HiFi BAMs are NEVER downloaded):
 *   - BAM/CRAM  -> cramino (read N50, yield Gb, coverage, per-length & per-quality coverage
 *                 buckets, ultralong "whales"); PacBio HiFi BAMs (PL:PACBIO) also get an `rq`
 *                 predicted-accuracy sample -> mean QV, %Q20/Q30/Q40, mean passes (np).
 *   - FASTA/FASTQ(.gz) -> seqkit stats -a (num_seqs, sum_len, read N50).
 * Coverage = yield_bp / genome_size (default 3.1 Gb, the verkko per-haploid convention).
 * Writes a uniform per-dataset manifest + an aggregate verkko-readiness verdict to the biowallet
 * qc/ folder, exits 0 on success (biofs-node anchors a ClaraJobNFT, pipeline label `longread-qc`).
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/qc/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface QcExecOptions {
  sample: string;
  inputs: string;          // CSV of gs:// inputs
  genomeSize?: string;     // bp
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
}

const IMG_CRAMINO = 'quay.io/biocontainers/cramino:0.14.5--h3ab6199_1';
const IMG_SEQKIT  = 'quay.io/biocontainers/seqkit:2.8.2--h9ee0642_0';
// minimap2 + samtools 1.23.1 (already cached on the executors)
const IMG_SAMTOOLS = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[qc] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[qc] ${label} could not start: ${r.error.message}`); }
}
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
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
function captureDocker(image: string, mounts: Array<[string, string, string]>, entrypoint: string | undefined, cmd: string[]): string {
  return capture('docker', dk(image, mounts, entrypoint, cmd));
}
function bucketOf(gs: string): string { return gs.replace('gs://', '').split('/')[0]; }
function relOf(gs: string, bucket: string): string { return gs.replace(`gs://${bucket}/`, ''); }
function isBam(u: string): boolean { return /\.(bam|cram)$/i.test(u); }
function isFastaOrFastq(u: string): boolean { return /\.(fa|fasta|fna|fq|fastq)(\.gz)?$/i.test(u); }
function num(s: string): number { const v = parseFloat((s || '').replace(/,/g, '')); return isFinite(v) ? v : NaN; }

interface DatasetMetric {
  input: string; kind: string; platform: string;
  reads?: number; yield_gb?: number; read_n50?: number; mean_len?: number;
  coverage_x?: number; ul100kb_cov_x?: number; ge50kb_cov_x?: number;
  hifi_mean_qv?: number; hifi_pct_q20?: number; hifi_pct_q30?: number; hifi_pct_q40?: number; hifi_mean_np?: number;
  cramino_report?: string; seqkit_tsv?: string; rq_line?: string; note?: string;
}

export async function qcExecCommand(opts: QcExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const jobId = opts.jobId || `qc-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const genomeSize = num(opts.genomeSize || '3100000000') || 3.1e9;
  const inputs = (opts.inputs || '').split(',').map(s => s.trim()).filter(Boolean);

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `qc-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/qc/${jobId}`;
  const threads = capture('nproc', []) || '8';

  logLine(`[qc] start sample=${sample} jobId=${jobId} genomeSize=${genomeSize}`);
  logLine(`[qc] inputs=${inputs.length} folder=${BIOWALLET_GCS}`);

  // fuse allow_other so root-in-container tools can read the gcsfuse mount
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  spawnSync('docker', ['pull', IMG_CRAMINO], { stdio: 'ignore' });
  spawnSync('docker', ['pull', IMG_SEQKIT], { stdio: 'ignore' });

  const metrics: DatasetMetric[] = [];

  for (const gs of inputs) {
    const bkt = bucketOf(gs);
    const mp = `/mnt/scratch/gcsfuse-${bkt}`;     // writable mount root (executor user may be non-root)
    gcsfuseRO(bkt, mp);
    const rel = relOf(gs, bkt);
    const local = path.join(mp, rel);
    if (!fs.existsSync(local)) { metrics.push({ input: gs, kind: 'missing', platform: 'NA', note: 'not found at mount' }); logLine(`[qc] MISSING ${gs}`); continue; }

    const base = path.basename(rel);
    const m: DatasetMetric = { input: gs, kind: isBam(gs) ? 'alignment' : 'reads', platform: 'unknown' };

    if (isBam(gs)) {
      // platform from header
      const hdr = captureDocker(IMG_SAMTOOLS, [[mp, '/mnt', 'ro']], 'bash', ['-c', `samtools view -H '/mnt/${rel}' 2>/dev/null | grep -m1 -oE 'PL:[A-Za-z]+' || true`]);
      m.platform = hdr.replace('PL:', '') || 'unknown';

      // cramino: full report (N50, yield, coverage, length+quality buckets, whales)
      const report = captureDocker(IMG_CRAMINO, [[mp, '/mnt', 'ro']], undefined, ['cramino', '-t', threads, `/mnt/${rel}`]);
      m.cramino_report = report;
      const grab = (re: RegExp): string => { const x = report.match(re); return x ? x[1] : ''; };
      m.reads = num(grab(/Number of (?:reads|alignments)\s+([0-9,]+)/i)) || undefined;
      m.yield_gb = num(grab(/Yield \[Gb\]\s+([0-9.]+)/i)) || undefined;
      m.read_n50 = num(grab(/N50\s+([0-9,]+)/i)) || undefined;
      m.mean_len = num(grab(/Mean (?:read )?length\s+([0-9,.]+)/i)) || undefined;
      // per-length coverage buckets (cramino "Coverage per ... cutoff" section)
      m.ge50kb_cov_x = num(grab(/(?:>|≥)?\s*50[ ]?kb\+?\s+([0-9.]+)/i)) || undefined;
      m.ul100kb_cov_x = num(grab(/(?:>|≥)?\s*100[ ]?kb\+?\s+([0-9.]+)/i)) || undefined;
      if (m.yield_gb && isFinite(m.yield_gb)) m.coverage_x = +( (m.yield_gb * 1e9) / genomeSize ).toFixed(2);

      // HiFi: rq predicted-accuracy QV sample (representative head-sample, low I/O)
      if (/PACBIO/i.test(m.platform)) {
        const awk = `'{for(i=12;i<=NF;i++){t=substr($i,1,5); if(t=="rq:f:"){v=substr($i,6)+0;n++;se+=(1-v);if(v>=0.99)q20++;if(v>=0.999)q30++;if(v>=0.9999)q40++;} if(substr($i,1,5)=="np:i:"){np+=substr($i,6)+0;npn++}}} END{if(n>0){mErr=se/n;qv=(mErr>0)?-10*log(mErr)/log(10):60;printf "reads=%d meanQV=%.2f pct_Q20=%.3f pct_Q30=%.3f pct_Q40=%.3f mean_np=%.2f",n,qv,100*q20/n,100*q30/n,100*q40/n,(npn>0?np/npn:0)}else{print "reads=0 NO_rq"}}'`;
        const rq = captureDocker(IMG_SAMTOOLS, [[mp, '/mnt', 'ro']], 'bash', ['-c', `samtools view '/mnt/${rel}' 2>/dev/null | head -n 1000000 | awk ${awk}`]);
        m.rq_line = rq;
        const g = (re: RegExp): number => { const x = rq.match(re); return x ? num(x[1]) : NaN; };
        m.hifi_mean_qv = g(/meanQV=([0-9.]+)/) || undefined;
        m.hifi_pct_q20 = g(/pct_Q20=([0-9.]+)/) || undefined;
        m.hifi_pct_q30 = g(/pct_Q30=([0-9.]+)/) || undefined;
        m.hifi_pct_q40 = g(/pct_Q40=([0-9.]+)/) || undefined;
        m.hifi_mean_np = g(/mean_np=([0-9.]+)/) || undefined;
      }
    } else if (isFastaOrFastq(gs)) {
      const tsv = captureDocker(IMG_SEQKIT, [[mp, '/mnt', 'ro']], undefined, ['seqkit', 'stats', '-a', '-T', `/mnt/${rel}`]);
      m.seqkit_tsv = tsv;
      const lines = tsv.split('\n').filter(Boolean);
      if (lines.length >= 2) {
        const h = lines[0].split('\t'); const v = lines[1].split('\t');
        const col = (name: string): string => { const i = h.indexOf(name); return i >= 0 ? v[i] : ''; };
        m.reads = num(col('num_seqs')) || undefined;
        const sumLen = num(col('sum_len'));
        if (isFinite(sumLen)) { m.yield_gb = +(sumLen / 1e9).toFixed(3); m.coverage_x = +((sumLen) / genomeSize).toFixed(2); }
        m.read_n50 = num(col('N50')) || undefined;
        m.mean_len = num(col('avg_len')) || undefined;
      }
      m.platform = /PACBIO/i.test(base) || /hifi/i.test(base) ? 'PACBIO' : (/ont|ul|nanopore|dorado|r1041/i.test(base) ? 'ONT' : 'unknown');
    } else {
      m.kind = 'skipped'; m.note = 'unrecognized extension';
    }
    logLine(`[qc] ${base} platform=${m.platform} reads=${m.reads ?? '?'} yieldGb=${m.yield_gb ?? '?'} N50=${m.read_n50 ?? '?'} cov=${m.coverage_x ?? '?'}x` + (m.hifi_mean_qv ? ` QV=${m.hifi_mean_qv} %Q20=${m.hifi_pct_q20}` : '') + (m.ul100kb_cov_x ? ` UL100kb=${m.ul100kb_cov_x}x` : ''));
    metrics.push(m);
  }

  // aggregate verkko-readiness
  const isHifi = (m: DatasetMetric) => /PACBIO/i.test(m.platform);
  const isOnt = (m: DatasetMetric) => /ONT/i.test(m.platform);
  const sum = (arr: number[]) => arr.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
  const hifiCov = +sum(metrics.filter(isHifi).map(m => m.coverage_x || 0)).toFixed(2);
  const ontCov = +sum(metrics.filter(isOnt).map(m => m.coverage_x || 0)).toFixed(2);
  const ontUl100 = +sum(metrics.filter(isOnt).map(m => m.ul100kb_cov_x || 0)).toFixed(2);

  const HIFI_MIN = 30, HIFI_STRONG = 40, UL_MIN = 15, UL_STRONG = 25;
  const hifiVerdict = hifiCov >= HIFI_STRONG ? 'STRONG' : hifiCov >= HIFI_MIN ? 'PASS' : 'LOW';
  const ulVerdict = ontUl100 >= UL_STRONG ? 'STRONG' : ontUl100 >= UL_MIN ? 'PASS' : (ontUl100 > 0 ? 'LOW' : 'NA');
  const verkkoReady = hifiVerdict !== 'LOW' && ulVerdict !== 'LOW';

  const valid = metrics.some(m => (m.coverage_x || 0) > 0);
  const manifest = {
    schema: 'genobank.qc.manifest/v1', pipeline: 'longread-qc',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    genomeSize, tools: { cramino: IMG_CRAMINO, seqkit: IMG_SEQKIT, samtools: IMG_SAMTOOLS },
    datasets: metrics,
    aggregate: {
      hifi_coverage_x: hifiCov, ont_coverage_x: ontCov, ont_ultralong_100kb_coverage_x: ontUl100,
      verkko: {
        thresholds: { hifi_min: HIFI_MIN, hifi_strong: HIFI_STRONG, ont_ul100kb_min: UL_MIN, ont_ul100kb_strong: UL_STRONG },
        hifi_verdict: hifiVerdict, ont_ultralong_verdict: ulVerdict, ready: verkkoReady,
      },
    },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // persist raw tool outputs too (defensive: numbers always recoverable from the report)
  for (const m of metrics) {
    const tag = path.basename(m.input).replace(/[^A-Za-z0-9._-]/g, '_');
    if (m.cramino_report) try { fs.writeFileSync(path.join(work, `${tag}.cramino.txt`), m.cramino_report); } catch (_) {}
    if (m.seqkit_tsv) try { fs.writeFileSync(path.join(work, `${tag}.seqkit.tsv`), m.seqkit_tsv); } catch (_) {}
  }
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/*.cramino.txt ${work}/*.seqkit.tsv ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
  spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' });

  logLine(`[qc] === verkko-readiness: HiFi ${hifiCov}x [${hifiVerdict}], ONT ${ontCov}x (UL>=100kb ${ontUl100}x [${ulVerdict}]) -> ${verkkoReady ? 'READY' : 'REVIEW'} ===`);
  if (!valid) { logLine('[qc] no metrics produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
