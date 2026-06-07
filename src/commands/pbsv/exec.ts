/**
 * biofs pbsv exec --sample <serial> --bam <gs> [--ref auto] ...
 *
 * EXECUTOR verb: VM-side PacBio HiFi read-based structural-variant caller (pbsv). biofs-node
 * spawns this; no orphan script. Streams the aligned HiFi BAM straight from the gcsfuse RO
 * mount (the BAM is NEVER downloaded) plus the reference the BAM was aligned to, runs pbsv in
 * two stages (`pbsv discover` -> svsig.gz, then `pbsv call --hifi` -> VCF), persists the SV
 * VCF + a typed manifest to the biowallet sv-pbsv/ folder, exits 0 on a valid call set
 * (biofs-node anchors a ClaraJobNFT).
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/sv-pbsv/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface PbsvExecOptions {
  sample: string;
  bam: string;           // gs:// aligned HiFi BAM
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_PBSV   = 'quay.io/biocontainers/pbsv:2.9.0--h9ee0642_0';
const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[pbsv] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[pbsv] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[pbsv] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

export async function pbsvExecCommand(opts: PbsvExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `pbsv-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `pbsv-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/sv-pbsv/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[pbsv] start sample=${sample} jobId=${jobId}`);
  logLine(`[pbsv] BAM=${opts.bam}`);
  logLine(`[pbsv] biowallet folder: ${BIOWALLET_GCS}`);

  // fuse allow_other (so the root-in-container pbsv can read the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): BAM bucket + reference bucket
  const obkt = bucketOf(opts.bam);
  const oMp = `/mnt/gcsfuse-${obkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(refBucket, rMp);
  const bamRel = gsToLocalRel(opts.bam, obkt);
  if (!fs.existsSync(path.join(oMp, bamRel))) { logLine(`[pbsv] BAM not found at mount: ${path.join(oMp, bamRel)}`); uploadAudit(); process.exit(1); }

  // reference: prefer the EXACT assembly the HiFi BAM was aligned to (assembly38, with-alt contigs);
  // a non-matching reference (no-alt) drops the alt-contig reads from the BAM header.
  let refRel = '';
  for (const rel of ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta']) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine('[pbsv] no reference fasta (+.fai) found'); uploadAudit(); process.exit(1); }
  // optional tandem-repeat bed improves pbsv discover SV calls in repeat regions
  let trArgs = '';
  for (const tr of ['hg38/human_GRCh38_no_alt_analysis_set.trf.bed', 'GRCh38/human_GRCh38_no_alt_analysis_set.trf.bed', 'hg38/Homo_sapiens_assembly38.trf.bed']) {
    if (fs.existsSync(path.join(rMp, tr))) { trArgs = ` --tandem-repeats /r/${tr}`; break; }
  }
  logLine(`[pbsv] ref=${refRel} tandem-repeats=${trArgs ? 'yes' : 'none'}`);

  const threads = capture('nproc', []) || '8';
  const svsig = `${sample}.svsig.gz`;
  const vcfGz = `${sample}.hifi.pbsv.vcf.gz`;

  // 1. pbsv discover (signatures) over the gcsfuse-mounted aligned HiFi BAM
  run('docker', dk(IMG_PBSV, [[oMp, '/o', 'ro'], [rMp, '/r', 'ro'], [work, '/w', 'rw']], undefined,
    ['bash', '-c', `set -euo pipefail; pbsv discover${trArgs} "/o/${bamRel}" /w/${svsig}`]), 'pbsv discover');

  // 2. pbsv call (--hifi) signatures -> VCF (bgzipped)
  run('docker', dk(IMG_PBSV, [[rMp, '/r', 'ro'], [work, '/w', 'rw']], undefined,
    ['bash', '-c', `set -euo pipefail; pbsv call --hifi -j ${threads} "/r/${refRel}" /w/${svsig} /w/${vcfGz}`]), 'pbsv call --hifi');
  // index
  run('docker', dk(IMG_HTSLIB, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; tabix -p vcf /w/${vcfGz} || true`]), 'tabix SV VCF');

  // 3. summarize: SV counts by type
  const counts = capture('docker', sdk(IMG_HTSLIB, [[work, '/w', 'ro']], 'bash',
    ['-c', `zcat /w/${vcfGz} | grep -v '^#' | grep -oE 'SVTYPE=[A-Za-z]+' | sort | uniq -c | awk '{print $2"="$1}' | paste -sd, -`]).slice(1) || '');
  const total = capture('docker', sdk(IMG_HTSLIB, [[work, '/w', 'ro']], 'bash', ['-c', `zcat /w/${vcfGz} | grep -vc '^#'`])).slice(1) || '0';
  logLine(`[pbsv] pbsv calls: total=${total} byType=[${counts}]`);
  const valid = Number(total) >= 0 && fs.existsSync(path.join(work, vcfGz));

  // 4. persist VCF (+ index) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, vcfGz), `${BIOWALLET_GCS}/${vcfGz}`], 'upload SV VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${vcfGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.pbsv.manifest/v1', pipeline: 'hifi-pbsv-sv',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { bam: opts.bam, reference: refRel },
    tools: { pbsv: IMG_PBSV, htslib: IMG_HTSLIB },
    outputs: { sv_vcf: `${BIOWALLET_GCS}/${vcfGz}` },
    summary: { total_sv: Number(total), by_type: counts },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[pbsv] no SV VCF produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[pbsv] DONE: ${total} SVs persisted to ${BIOWALLET_GCS}/${vcfGz}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
