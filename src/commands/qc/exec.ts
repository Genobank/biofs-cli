/**
 * biofs qc exec --sample <serial> --inputs <gs://a.fa.gz,gs://b.bam,gs://c_summary.txt.gz,...>
 *
 * EXECUTOR verb: VM-side long-read QC. biofs-node spawns this; no orphan script. Each input is
 * read straight from the gcsfuse RO mount (the 400 GB HiFi BAMs and 100 GB ONT BAMs are NEVER
 * downloaded, and never even fully streamed):
 *   - FASTA/FASTQ(.gz)            -> seqkit stats -a (num_seqs, sum_len, read N50)  [PacBio HiFi]
 *   - PacBio HiFi BAM/CRAM        -> `rq` predicted-accuracy head-sample (mean QV, %Q20/Q30/Q40,
 *                                    mean passes np); coverage/N50 come from the sibling .fa.gz so
 *                                    the kinetics-bloated BAM is not fully streamed
 *   - Dorado *_summary.txt.gz     -> header-aware awk over sequence_length_template +
 *                                    mean_qscore_template -> reads, yield, read N50, coverage,
 *                                    coverage of reads >=50/100/200 kb (ultralong), mean Q,
 *                                    coverage of reads >=Q20  [ONT, from the per-read summary]
 *   - other BAM (ONT, fallback)  -> single samtools stream -> length/Q metrics
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
function captureSh(script: string): string { return capture('bash', ['-c', script]); }
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
function isSummary(u: string): boolean { return /_summary\.txt\.gz$|sequencing_summary.*\.txt(\.gz)?$/i.test(u); }
function isFastaOrFastq(u: string): boolean { return /\.(fa|fasta|fna|fq|fastq)(\.gz)?$/i.test(u); }
function num(s: string): number { const v = parseFloat((s || '').replace(/,/g, '')); return isFinite(v) ? v : NaN; }
function n2(x: number): number { return +(x).toFixed(2); }

interface DatasetMetric {
  input: string; kind: string; platform: string;
  reads?: number; yield_gb?: number; read_n50?: number; mean_len?: number; max_len?: number;
  coverage_x?: number; ge50kb_cov_x?: number; ul100kb_cov_x?: number; ge200kb_cov_x?: number;
  mean_q?: number; q20_cov_x?: number;
  hifi_mean_qv?: number; hifi_pct_q20?: number; hifi_pct_q30?: number; hifi_pct_q40?: number; hifi_mean_np?: number;
  seqkit_tsv?: string; rq_line?: string; note?: string;
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

  logLine(`[qc] start sample=${sample} jobId=${jobId} genomeSize=${genomeSize}`);
  logLine(`[qc] inputs=${inputs.length} folder=${BIOWALLET_GCS}`);

  // fuse allow_other so root-in-container tools can read the gcsfuse mount
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });
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
    const m: DatasetMetric = { input: gs, kind: 'unknown', platform: 'unknown' };

    if (isSummary(gs)) {
      // ONT: per-read Dorado sequencing summary -> header-aware awk (no BAM stream)
      m.kind = 'ont-summary'; m.platform = 'ONT';
      // single gzip read: emit summary stats AND dump per-read lengths to a local temp (a SECOND
      // gcsfuse sequential read of the same summary can stall/truncate, which silently nulled N50).
      const lenTmp = path.join(work, `lens-${path.basename(rel)}.txt`);
      const p1 = captureSh(
        `gzip -dc '${local}' | awk -F'\\t' 'NR==1{for(i=1;i<=NF;i++){if($i=="sequence_length_template")LC=i; if($i=="mean_qscore_template")QC=i}; next} ` +
        `{n++; L=$LC+0; Q=$QC+0; bp+=L; if(L>=50000)bp50+=L; if(L>=100000)bp100+=L; if(L>=200000)bp200+=L; if(Q>=20)bpq20+=L; if(L>mx)mx=L; sq+=Q; print L > "${lenTmp}"} ` +
        `END{printf "reads=%d bp=%.0f bp50=%.0f bp100=%.0f bp200=%.0f bpq20=%.0f maxlen=%d meanq=%.3f", n,bp,bp50,bp100,bp200,bpq20,mx,(n>0?sq/n:0)}'`);
      const g = (re: RegExp): number => { const x = p1.match(re); return x ? num(x[1]) : NaN; };
      const reads = g(/reads=([0-9]+)/), bp = g(/bp=([0-9]+)/), bp50 = g(/bp50=([0-9]+)/), bp100 = g(/bp100=([0-9]+)/), bp200 = g(/bp200=([0-9]+)/), bpq20 = g(/bpq20=([0-9]+)/);
      const n50 = num(captureSh(`sort -nr '${lenTmp}' 2>/dev/null | awk '{t+=$1;a[NR]=$1} END{h=t/2;c=0;for(i=1;i<=NR;i++){c+=a[i]; if(c>=h){print a[i]; break}}}'; rm -f '${lenTmp}'`));
      if (isFinite(reads)) m.reads = reads;
      if (isFinite(bp)) { m.yield_gb = n2(bp / 1e9); m.coverage_x = n2(bp / genomeSize); m.mean_len = reads > 0 ? Math.round(bp / reads) : undefined; }
      if (isFinite(bp50)) m.ge50kb_cov_x = n2(bp50 / genomeSize);
      if (isFinite(bp100)) m.ul100kb_cov_x = n2(bp100 / genomeSize);
      if (isFinite(bp200)) m.ge200kb_cov_x = n2(bp200 / genomeSize);
      if (isFinite(bpq20)) m.q20_cov_x = n2(bpq20 / genomeSize);
      m.read_n50 = isFinite(n50) ? n50 : undefined;
      m.max_len = g(/maxlen=([0-9]+)/) || undefined;
      m.mean_q = g(/meanq=([0-9.]+)/) || undefined;

    } else if (isBam(gs)) {
      const hdr = captureDocker(IMG_SAMTOOLS, [[mp, '/mnt', 'ro']], 'bash', ['-c', `samtools view -H '/mnt/${rel}' 2>/dev/null | grep -m1 -oE 'PL:[A-Za-z]+' || true`]);
      m.platform = hdr.replace('PL:', '') || 'unknown';

      if (/PACBIO/i.test(m.platform)) {
        // HiFi: coverage/N50 from sibling .fa.gz (seqkit), QV from rq head-sample (no full BAM stream)
        m.kind = 'hifi-bam';
        const sib = rel.replace(/\.(bam|cram)$/i, '.fa.gz');
        if (fs.existsSync(path.join(mp, sib))) {
          const tsv = captureDocker(IMG_SEQKIT, [[mp, '/mnt', 'ro']], undefined, ['seqkit', 'stats', '-a', '-T', `/mnt/${sib}`]);
          m.seqkit_tsv = tsv; parseSeqkit(tsv, m, genomeSize);
        } else { m.note = 'no sibling .fa.gz; coverage/N50 unavailable without full BAM stream'; }
        const awkProg = `{for(i=12;i<=NF;i++){t=substr($i,1,5); if(t=="rq:f:"){v=substr($i,6)+0;n++;se+=(1-v);if(v>=0.99)q20++;if(v>=0.999)q30++;if(v>=0.9999)q40++;} if(substr($i,1,5)=="np:i:"){np+=substr($i,6)+0;npn++}}} END{if(n>0){mErr=se/n;qv=(mErr>0)?-10*log(mErr)/log(10):60;printf "reads=%d meanQV=%.2f pct_Q20=%.3f pct_Q30=%.3f pct_Q40=%.3f mean_np=%.2f",n,qv,100*q20/n,100*q30/n,100*q40/n,(npn>0?np/npn:0)}else{print "reads=0 NO_rq"}}`;
        // primary: rq head-sample over the gcsfuse mount
        let rq = captureSh(`docker run --rm -v ${mp}:/mnt:ro --entrypoint samtools ${IMG_SAMTOOLS} view /mnt/${rel} 2>/dev/null | head -n 200000 | awk '${awkProg}'`);
        // fallback: large sequential reads of a 400 GB BAM can stall over gcsfuse; re-sample by
        // streaming the object directly with `gcloud storage cat` (bypasses gcsfuse entirely).
        if (!rq || /reads=0|NO_rq/.test(rq)) {
          logLine(`[qc] rq gcsfuse read empty for ${base}; retry via gcloud storage cat stream`);
          rq = captureSh(`gcloud storage cat '${gs}' 2>/dev/null | docker run -i --rm --entrypoint samtools ${IMG_SAMTOOLS} view - 2>/dev/null | head -n 200000 | awk '${awkProg}'`);
        }
        m.rq_line = rq;
        const gg = (re: RegExp): number => { const x = rq.match(re); return x ? num(x[1]) : NaN; };
        m.hifi_mean_qv = gg(/meanQV=([0-9.]+)/) || undefined;
        m.hifi_pct_q20 = gg(/pct_Q20=([0-9.]+)/) || undefined;
        m.hifi_pct_q30 = gg(/pct_Q30=([0-9.]+)/) || undefined;
        m.hifi_pct_q40 = gg(/pct_Q40=([0-9.]+)/) || undefined;
        m.hifi_mean_np = gg(/mean_np=([0-9.]+)/) || undefined;
      } else {
        // ONT/other BAM fallback: single samtools stream -> length/Q metrics
        m.kind = 'bam-stream'; if (m.platform === 'unknown') m.platform = 'ONT';
        const awkProg2 = `{L=length($10); n++; bp+=L; if(L>=50000)bp50+=L; if(L>=100000)bp100+=L; if(L>=200000)bp200+=L; if(L>mx)mx=L} END{printf "reads=%d bp=%.0f bp50=%.0f bp100=%.0f bp200=%.0f maxlen=%d",n,bp,bp50,bp100,bp200,mx}`;
        const line = captureSh(`docker run --rm -v ${mp}:/mnt:ro --entrypoint samtools ${IMG_SAMTOOLS} view /mnt/${rel} 2>/dev/null | awk '${awkProg2}'`);
        const g = (re: RegExp): number => { const x = line.match(re); return x ? num(x[1]) : NaN; };
        const reads = g(/reads=([0-9]+)/), bp = g(/bp=([0-9]+)/), bp50 = g(/bp50=([0-9]+)/), bp100 = g(/bp100=([0-9]+)/), bp200 = g(/bp200=([0-9]+)/);
        if (isFinite(reads)) m.reads = reads;
        if (isFinite(bp)) { m.yield_gb = n2(bp / 1e9); m.coverage_x = n2(bp / genomeSize); m.mean_len = reads > 0 ? Math.round(bp / reads) : undefined; }
        if (isFinite(bp50)) m.ge50kb_cov_x = n2(bp50 / genomeSize);
        if (isFinite(bp100)) m.ul100kb_cov_x = n2(bp100 / genomeSize);
        if (isFinite(bp200)) m.ge200kb_cov_x = n2(bp200 / genomeSize);
        m.max_len = g(/maxlen=([0-9]+)/) || undefined;
      }
    } else if (isFastaOrFastq(gs)) {
      m.kind = 'reads-fasta';
      const tsv = captureDocker(IMG_SEQKIT, [[mp, '/mnt', 'ro']], undefined, ['seqkit', 'stats', '-a', '-T', `/mnt/${rel}`]);
      m.seqkit_tsv = tsv; parseSeqkit(tsv, m, genomeSize);
      m.platform = /hifi|pacbio/i.test(base) ? 'PACBIO' : (/ont|ul|nanopore|dorado|r1041/i.test(base) ? 'ONT' : 'unknown');
    } else {
      m.kind = 'skipped'; m.note = 'unrecognized extension';
    }

    logLine(`[qc] ${base} platform=${m.platform} kind=${m.kind} reads=${m.reads ?? '?'} yieldGb=${m.yield_gb ?? '?'} N50=${m.read_n50 ?? '?'} cov=${m.coverage_x ?? '?'}x` +
      (m.ul100kb_cov_x !== undefined ? ` UL100kb=${m.ul100kb_cov_x}x` : '') + (m.mean_q !== undefined ? ` meanQ=${m.mean_q}` : '') +
      (m.hifi_mean_qv !== undefined ? ` QV=${m.hifi_mean_qv} %Q20=${m.hifi_pct_q20} np=${m.hifi_mean_np}` : ''));
    metrics.push(m);
  }

  // aggregate verkko-readiness (HiFi coverage counted once: hifi-bam entries carry QV only)
  const isHifi = (m: DatasetMetric) => /PACBIO/i.test(m.platform);
  const isOnt = (m: DatasetMetric) => /ONT/i.test(m.platform);
  const sumc = (arr: number[]) => arr.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
  const hifiCov = n2(sumc(metrics.filter(isHifi).map(m => m.coverage_x || 0)));
  const ontCov = n2(sumc(metrics.filter(isOnt).map(m => m.coverage_x || 0)));
  const ontUl100 = n2(sumc(metrics.filter(isOnt).map(m => m.ul100kb_cov_x || 0)));
  const ontUl200 = n2(sumc(metrics.filter(isOnt).map(m => m.ge200kb_cov_x || 0)));

  const HIFI_MIN = 30, HIFI_STRONG = 40, UL_MIN = 15, UL_STRONG = 25;
  const hifiVerdict = hifiCov >= HIFI_STRONG ? 'STRONG' : hifiCov >= HIFI_MIN ? 'PASS' : 'LOW';
  const ulVerdict = ontUl100 >= UL_STRONG ? 'STRONG' : ontUl100 >= UL_MIN ? 'PASS' : (ontUl100 > 0 ? 'LOW' : 'NA');
  const verkkoReady = hifiVerdict !== 'LOW' && ulVerdict !== 'LOW';

  const valid = metrics.some(m => (m.coverage_x || 0) > 0);
  const manifest = {
    schema: 'genobank.qc.manifest/v1', pipeline: 'longread-qc',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    genomeSize, tools: { seqkit: IMG_SEQKIT, samtools: IMG_SAMTOOLS, summary: 'gzip+awk(sequence_length_template,mean_qscore_template)' },
    datasets: metrics,
    aggregate: {
      hifi_coverage_x: hifiCov, ont_coverage_x: ontCov,
      ont_ultralong_100kb_coverage_x: ontUl100, ont_ultralong_200kb_coverage_x: ontUl200,
      verkko: {
        thresholds: { hifi_min: HIFI_MIN, hifi_strong: HIFI_STRONG, ont_ul100kb_min: UL_MIN, ont_ul100kb_strong: UL_STRONG },
        hifi_verdict: hifiVerdict, ont_ultralong_verdict: ulVerdict, ready: verkkoReady,
      },
    },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  for (const m of metrics) {
    const tag = path.basename(m.input).replace(/[^A-Za-z0-9._-]/g, '_');
    if (m.seqkit_tsv) try { fs.writeFileSync(path.join(work, `${tag}.seqkit.tsv`), m.seqkit_tsv); } catch (_) {}
  }
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/*.seqkit.tsv ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
  spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' });

  logLine(`[qc] === verkko-readiness: HiFi ${hifiCov}x [${hifiVerdict}], ONT ${ontCov}x (UL>=100kb ${ontUl100}x [${ulVerdict}], >=200kb ${ontUl200}x) -> ${verkkoReady ? 'READY' : 'REVIEW'} ===`);
  if (!valid) { logLine('[qc] no metrics produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}

function parseSeqkit(tsv: string, m: DatasetMetric, genomeSize: number): void {
  const lines = (tsv || '').split('\n').filter(Boolean);
  if (lines.length < 2) return;
  const h = lines[0].split('\t'); const v = lines[1].split('\t');
  const col = (name: string): string => { const i = h.indexOf(name); return i >= 0 ? v[i] : ''; };
  m.reads = num(col('num_seqs')) || m.reads;
  const sumLen = num(col('sum_len'));
  if (isFinite(sumLen)) { m.yield_gb = n2(sumLen / 1e9); m.coverage_x = n2(sumLen / genomeSize); }
  m.read_n50 = num(col('N50')) || m.read_n50;
  m.mean_len = num(col('avg_len')) || m.mean_len;
  m.max_len = num(col('max_len')) || m.max_len;
}
