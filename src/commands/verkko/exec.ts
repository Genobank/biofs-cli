/**
 * biofs verkko exec --sample <serial> --hifi <gs://a,...> --nano <gs://b,...> [opts]
 *
 * EXECUTOR verb: VM-side verkko 2.3.2 T2T assembly. biofs-node spawns this AFTER it has resolved
 * the input biocids -> gs:// via bioroutes.inventory and verified consent (BioNFT gate). The
 * executor therefore only ever sees gated, resolved gs:// paths (never a raw biocid, never an
 * un-gated path). It streams the reads over gcsfuse-RO (never downloaded as source), downsamples
 * HiFi to --hifi-prop, extracts ONT ultralong (>= --ont-minlen) to fastq, runs verkko (local),
 * and persists the assembly + a typed manifest to the biowallet verkko/ folder. Multi-day job.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/verkko/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface VerkkoExecOptions {
  sample: string;
  hifi: string;            // CSV of RESOLVED gs:// HiFi reads (gated by biofs-node)
  nano: string;            // CSV of RESOLVED gs:// ONT reads (gated by biofs-node)
  hifiProp?: string;
  ontMinlen?: string;
  localMemory?: string;
  localCpus?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
}

const IMG_SEQKIT = 'quay.io/biocontainers/seqkit:2.8.2--h9ee0642_0';
const IMG_SAMTOOLS = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_VERKKO = 'verkko-bc:2.3.2';   // verkko 2.3.2 + bc shim (built on the executor)

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string, fatal = true): number {
  logLine(`[verkko] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[verkko] ${label} could not start: ${r.error.message}`); if (fatal) process.exit(1); return 1; }
  if (r.status !== 0 && fatal) { logLine(`[verkko] ${label} exited ${r.status}`); }
  return r.status ?? 1;
}
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
function isMounted(mp: string): boolean { return capture('sh', ['-c', `mount | grep -F ' ${mp} ' || true`]).length > 0; }
function gcsfuseRO(bucket: string): string {
  const mp = `/mnt/scratch/gcsfuse-${bucket}`;
  fs.mkdirSync(mp, { recursive: true });
  if (!isMounted(mp)) run('gcsfuse', ['--implicit-dirs', '-o', 'ro', '-o', 'allow_other', bucket, mp], `gcsfuse ${bucket}`);
  return mp;
}
function dk(image: string, mounts: Array<[string, string, string]>, entrypoint: string | undefined, cmd: string[]): string[] {
  const a = ['run', '--rm']; for (const [h, c, m] of mounts) a.push('-v', `${h}:${c}:${m}`);
  if (entrypoint !== undefined) a.push('--entrypoint', entrypoint); a.push(image, ...cmd); return a;
}
function bucketOf(gs: string): string { return gs.replace('gs://', '').split('/')[0]; }
function relOf(gs: string, bucket: string): string { return gs.replace(`gs://${bucket}/`, ''); }

export async function verkkoExecCommand(opts: VerkkoExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const jobId = opts.jobId || `verkko-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const hifi = (opts.hifi || '').split(',').map(s => s.trim()).filter(Boolean);
  const nano = (opts.nano || '').split(',').map(s => s.trim()).filter(Boolean);
  const hifiProp = opts.hifiProp || '1.0';
  const ontMinlen = String(parseInt(opts.ontMinlen || '100000', 10) || 100000);
  const mem = String(parseInt(opts.localMemory || '320', 10) || 320);
  const cpus = String(parseInt(opts.localCpus || '80', 10) || 80);

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, jobId);
  for (const d of ['hifi', 'ont', 'asm', 'tmp']) fs.mkdirSync(path.join(work, d), { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/verkko/${jobId}`;

  logLine(`[verkko] START ${new Date().toISOString()} job=${jobId} sample=${sample}`);
  logLine(`[verkko] HiFi=${hifi.length} ONT=${nano.length} hifiProp=${hifiProp} ontMinlen=${ontMinlen} mem=${mem}G cpus=${cpus}`);
  logLine(`[verkko] out=${BIOWALLET_GCS}`);
  if (hifi.length === 0 || nano.length === 0) { logLine('[verkko] missing resolved HiFi/ONT inputs'); process.exit(2); }

  // fuse allow_other so root-in-container tools can read the gcsfuse mount
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // === STAGE 1: HiFi downsample to --hifi-prop ===
  logLine(`[verkko] === STAGE 1: HiFi downsample (prop=${hifiProp}) ===`);
  for (const gs of hifi) {
    const bkt = bucketOf(gs); const mp = gcsfuseRO(bkt); const rel = relOf(gs, bkt);
    if (!fs.existsSync(path.join(mp, rel))) { logLine(`[verkko] HiFi missing at mount: ${gs}`); process.exit(3); }
    const base = path.basename(rel).replace(/\.(fa|fasta|fq|fastq)(\.gz)?$/i, '');
    run('docker', dk(IMG_SEQKIT, [[mp, '/o', 'ro'], [work, '/w', 'rw']], undefined,
      ['seqkit', 'sample', '-p', hifiProp, '-s', '11', `/o/${rel}`, '-o', `/w/hifi/${base}.ds.fa.gz`]), `seqkit sample ${base}`);
  }

  // === STAGE 2: ONT -> fastq, keep >= ontMinlen (ultralong) ===
  logLine(`[verkko] === STAGE 2: ONT -> fastq, keep >= ${ontMinlen} bp ===`);
  for (const gs of nano) {
    const bkt = bucketOf(gs); const mp = gcsfuseRO(bkt); const rel = relOf(gs, bkt);
    if (!fs.existsSync(path.join(mp, rel))) { logLine(`[verkko] ONT missing at mount: ${gs}`); process.exit(3); }
    const base = path.basename(rel).replace(/\.(bam|cram|fq|fastq)(\.gz)?$/i, '');
    const inner = `samtools fastq -@ 8 '/o/${rel}' 2>/dev/null | awk 'NR%4==1{h=$0} NR%4==2{s=$0;f=(length(s)>=${ontMinlen})} NR%4==3{p=$0} NR%4==0{if(f){print h;print s;print p;print $0}}' | gzip > /w/ont/${base}.ul.fastq.gz`;
    run('docker', dk(IMG_SAMTOOLS, [[mp, '/o', 'ro'], [work, '/w', 'rw']], 'bash', ['-c', inner]), `samtools fastq + >=${ontMinlen} ${base}`);
  }
  logLine(`[verkko] staged hifi: ${capture('sh', ['-c', `ls -1 ${work}/hifi/ 2>/dev/null | tr '\\n' ' '`])}`);
  logLine(`[verkko] staged ont:  ${capture('sh', ['-c', `ls -1 ${work}/ont/ 2>/dev/null | tr '\\n' ' '`])}`);

  // === STAGE 3: verkko (local) — multi-day ===
  logLine(`[verkko] === STAGE 3: verkko 2.3.2 (local-memory=${mem}G local-cpus=${cpus}) ${new Date().toISOString()} ===`);
  const vInner = `mkdir -p /w/tmp; export TMPDIR=/w/tmp; verkko -d /w/asm --hifi /w/hifi/*.fa.gz --nano /w/ont/*.ul.fastq.gz --local-memory ${mem} --local-cpus ${cpus}`;
  const vrc = run('docker', dk(IMG_VERKKO, [[work, '/w', 'rw']], 'bash', ['-c', vInner]), 'verkko assembly', false);
  logLine(`[verkko] verkko exit=${vrc} ${new Date().toISOString()}`);

  // === STAGE 4: persist + manifest ===
  const asmFasta = path.join(work, 'asm', 'assembly.fasta');
  const valid = fs.existsSync(asmFasta) && fs.statSync(asmFasta).size > 0;
  let stats = '';
  if (valid) {
    stats = capture('docker', dk(IMG_SEQKIT, [[work, '/w', 'ro']], undefined, ['seqkit', 'stats', '-a', '-T', '/w/asm/assembly.fasta']));
    try { fs.writeFileSync(path.join(work, 'assembly.seqkit.tsv'), stats); } catch (_) {}
    logLine(`[verkko] assembly stats:\n${stats}`);
    spawnSync('sh', ['-c', `gcloud storage cp ${work}/asm/assembly*.fasta ${work}/asm/assembly.homopolymer-compressed.gfa ${work}/asm/assembly.scfmap ${work}/asm/assembly*.csv ${work}/assembly.seqkit.tsv ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  } else {
    logLine(`[verkko] WARNING: assembly.fasta missing/empty (verkko exit=${vrc})`);
  }

  const manifest = {
    schema: 'genobank.verkko.manifest/v1', pipeline: 'verkko-t2t',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'FAILED',
    tools: { verkko: IMG_VERKKO, seqkit: IMG_SEQKIT, samtools: IMG_SAMTOOLS },
    inputs: { hifi, nano, hifiProp, ontMinlen, localMemory: mem, localCpus: cpus },
    outputs: valid ? {
      assembly: `${BIOWALLET_GCS}/assembly.fasta`,
      haplotype1: `${BIOWALLET_GCS}/assembly.haplotype1.fasta`,
      haplotype2: `${BIOWALLET_GCS}/assembly.haplotype2.fasta`,
      gfa: `${BIOWALLET_GCS}/assembly.homopolymer-compressed.gfa`,
    } : {},
    assembly_stats: stats, verkko_exit: vrc,
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const mPath = path.join(work, 'manifest.json');
  fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', mPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest', false);
  try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
  spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' });

  logLine(`[verkko] DONE ${new Date().toISOString()} status=${valid ? 'OK' : 'FAILED'} -> ${BIOWALLET_GCS}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(valid ? 0 : 7);
}
