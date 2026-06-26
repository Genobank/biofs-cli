/**
 * biofs sv-call exec --sample <serial> --modbam <gs> [--ref auto] ...
 *
 * EXECUTOR verb: VM-side ONT structural-variant caller (Sniffles2). biofs-node spawns this;
 * no orphan script. Streams the aligned modBAM straight from the gcsfuse RO mount (the
 * 366 GB BAM is NEVER downloaded) plus the reference the BAM was aligned to, runs Sniffles2,
 * persists the SV VCF + a typed manifest to the biowallet sv/ folder, exits 0 on a valid
 * call set (biofs-node anchors a ClaraJobNFT).
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/sv/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface SvCallExecOptions {
  sample: string;
  modbam: string;        // gs:// merged aligned ONT modBAM
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_ALIGN    = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_HTSLIB   = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_SNIFFLES = 'quay.io/biocontainers/sniffles:2.5.3--pyhdfd78af_0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[sv-call] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[sv-call] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[sv-call] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

export async function svCallExecCommand(opts: SvCallExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `svcall-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `svcall-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/sv/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[sv-call] start sample=${sample} jobId=${jobId}`);
  logLine(`[sv-call] modBAM=${opts.modbam}`);
  logLine(`[sv-call] biowallet folder: ${BIOWALLET_GCS}`);

  // fuse allow_other (so the root-in-container Sniffles2 can read the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): modBAM bucket + reference bucket
  const obkt = bucketOf(opts.modbam);
  const oMp = `/mnt/gcsfuse-${obkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(refBucket, rMp);
  const modbamRel = gsToLocalRel(opts.modbam, obkt);
  if (!fs.existsSync(path.join(oMp, modbamRel))) { logLine(`[sv-call] modBAM not found at mount: ${path.join(oMp, modbamRel)}`); uploadAudit(); process.exit(1); }

  // reference selection honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; else GRCh38 (default).
  // Must be the EXACT assembly the modBAM was aligned to, or alt-contig reads drop from the header.
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta'];
  let refRel = '';
  for (const rel of refCandidates) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine(`[sv-call] no reference fasta (+.fai) for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }
  // optional tandem-repeat bed improves Sniffles2 SV calls in repeat regions (reference-specific)
  const trCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.trf.bed', 'CHM13/chm13v2.0_tandem_repeats.bed']
    : ['hg38/human_GRCh38_no_alt_analysis_set.trf.bed', 'GRCh38/human_GRCh38_no_alt_analysis_set.trf.bed', 'hg38/Homo_sapiens_assembly38.trf.bed'];
  let trArgs = '';
  for (const tr of trCandidates) {
    if (fs.existsSync(path.join(rMp, tr))) { trArgs = ` --tandem-repeats /r/${tr}`; break; }
  }
  logLine(`[sv-call] ref=${refRel} tandem-repeats=${trArgs ? 'yes' : 'none'}`);

  const threads = capture('nproc', []) || '8';
  const vcfGz = `${sample}.ont.sniffles.vcf.gz`;

  // 1. Sniffles2 (single pass over the gcsfuse-mounted modBAM)
  run('docker', dk(IMG_SNIFFLES, [[oMp, '/o', 'ro'], [rMp, '/r', 'ro'], [work, '/w', 'rw']], undefined,
    ['bash', '-c', `set -euo pipefail; sniffles --input "/o/${modbamRel}" --reference "/r/${refRel}"${trArgs} ` +
      `--vcf /w/${vcfGz} --threads ${threads} --output-rnames --allow-overwrite`]), 'Sniffles2 SV calling');
  // index
  run('docker', dk(IMG_HTSLIB, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; tabix -p vcf /w/${vcfGz} || true`]), 'tabix SV VCF');

  // 2. summarize: SV counts by type
  //   NOTE: capture(cmd,args) calls spawnSync(cmd,args); the FIRST element of args is argv[1].
  //   sdk(...) prepends 'docker' to its array, so `capture('docker', sdk(...))` spawned
  //   `docker docker run ...` -> "'docker' is not a docker command" -> nonzero exit ->
  //   capture()='' -> ''.slice(1)='' -> total='0'. That is why a VCF with 38,611 real SVs
  //   was reported as 0. Use the plain `['run', ...]` argv (no sdk wrapper) and no .slice(1),
  //   exactly like hifi-deepvariant/ont-variants/liftover.
  const dockerArgs = (sh: string): string[] => ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', sh];
  const counts = capture('docker', dockerArgs(`zcat /w/${vcfGz} | grep -v '^#' | grep -oE 'SVTYPE=[A-Z]+' | sort | uniq -c | awk '{print $2"="$1}' | paste -sd, -`)) || '';
  const total = capture('docker', dockerArgs(`zcat /w/${vcfGz} | grep -vc '^#'`)) || '0';
  logLine(`[sv-call] Sniffles2 calls: total=${total} byType=[${counts}]`);
  const valid = Number(total) > 0 && fs.existsSync(path.join(work, vcfGz));

  // 3. persist VCF (+ index) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, vcfGz), `${BIOWALLET_GCS}/${vcfGz}`], 'upload SV VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${vcfGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.svcall.manifest/v1', pipeline: 'ont-sniffles-sv',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { modbam: opts.modbam, reference: refRel },
    tools: { sniffles: IMG_SNIFFLES, htslib: IMG_HTSLIB },
    outputs: { sv_vcf: `${BIOWALLET_GCS}/${vcfGz}` },
    summary: { total_sv: Number(total), by_type: counts },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[sv-call] no SV VCF produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[sv-call] DONE: ${total} SVs persisted to ${BIOWALLET_GCS}/${vcfGz}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
