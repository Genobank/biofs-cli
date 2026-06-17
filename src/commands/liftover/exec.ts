/**
 * biofs liftover exec --sample <serial> --vcf <gs CHM13 VCF> --to GRCh38 [--ref-from CHM13] ...
 *
 * EXECUTOR verb: VM-side cross-reference VCF liftover (CrossMap). biofs-node spawns this; no
 * orphan script. Reads a CHM13-coordinate VCF from the gcsfuse RO mount (never downloaded),
 * normalizes multiallelics (bcftools norm -m-), then lifts it to GRCh38 with CrossMap using the
 * CHM13v2.0->GRCh38 chain + the GRCh38 target FASTA. The lifted GRCh38 VCF feeds ClinVar/OpenCRAVAT
 * annotation; the CrossMap reject file (records that fail to lift) is persisted FIRST-CLASS because
 * the failed-lift set is the T2T-specific candidate set (calls in CHM13 regions absent from GRCh38).
 * Nothing is silently dropped.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/liftover/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface LiftoverExecOptions {
  sample: string;
  vcf: string;           // gs:// source VCF (CHM13 coordinates)
  refFrom?: string;      // source assembly (default CHM13)
  to?: string;           // target assembly (default GRCh38)
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_BCFTOOLS = 'quay.io/biocontainers/bcftools:1.19--h8b25389_0';
const IMG_HTSLIB   = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_CROSSMAP = 'quay.io/biocontainers/crossmap:0.7.0--pyhdfd78af_0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[liftover] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[liftover] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[liftover] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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
function firstExisting(rMp: string, cands: string[]): string {
  for (const rel of cands) { if (fs.existsSync(path.join(rMp, rel))) return rel; }
  return '';
}

export async function liftoverExecCommand(opts: LiftoverExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `liftover-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const target = (opts.to || 'GRCh38');

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `liftover-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/liftover/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[liftover] start sample=${sample} jobId=${jobId}`);
  logLine(`[liftover] source VCF=${opts.vcf} (CHM13) -> target=${target}`);
  logLine(`[liftover] biowallet folder: ${BIOWALLET_GCS}`);

  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): VCF bucket + reference bucket
  const vbkt = bucketOf(opts.vcf);
  const vMp = `/mnt/gcsfuse-${vbkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(vbkt, vMp); gcsfuseRO(refBucket, rMp);
  const vcfRel = gsToLocalRel(opts.vcf, vbkt);
  if (!fs.existsSync(path.join(vMp, vcfRel))) { logLine(`[liftover] source VCF not found at mount: ${path.join(vMp, vcfRel)}`); uploadAudit(); process.exit(1); }

  // chain (CHM13v2.0 -> GRCh38) + GRCh38 target FASTA, both from the reference mount.
  const chainRel = firstExisting(rMp, ['CHM13/chm13v2.0_to_GRCh38.chain', 'CHM13/chm13v2.0-to-grch38.chain', 'CHM13/chm13v2.0ToGRCh38.over.chain', 'CHM13/chm13v2.0_to_GRCh38.chain.gz']);
  if (!chainRel) { logLine('[liftover] no CHM13->GRCh38 chain under CHM13/ (stage chm13v2.0_to_GRCh38.chain)'); uploadAudit(); process.exit(1); }
  const tgtRel = firstExisting(rMp, ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta']);
  if (!tgtRel) { logLine('[liftover] no GRCh38 target FASTA found'); uploadAudit(); process.exit(1); }
  logLine(`[liftover] chain=${chainRel} target=${tgtRel}`);

  // 1. split multiallelics before liftover so each allele lifts independently (faithful per-allele
  //    rejects). No -f reference needed for splitting; CrossMap re-validates ref alleles vs GRCh38.
  const normVcf = 'norm.vcf.gz';
  run('docker', ['run', '--rm', '-v', `${vMp}:/v:ro`, '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_BCFTOOLS, '-c',
    `set -euo pipefail; bcftools norm -m- /v/${vcfRel} -Oz -o /w/${normVcf}`],
    'bcftools norm -m- (split multiallelics)');

  // 2. CrossMap liftover -> GRCh38. CrossMap writes <out> (mapped) + <out>.unmap (rejects).
  const liftedRaw = 'lifted.grch38.vcf';
  run('docker', ['run', '--rm', '-v', `${rMp}:/r:ro`, '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_CROSSMAP, '-c',
    `set -euo pipefail; CrossMap vcf /r/${chainRel} /w/${normVcf} /r/${tgtRel} /w/${liftedRaw}`],
    'CrossMap vcf (CHM13 -> GRCh38)');
  if (!fs.existsSync(path.join(work, liftedRaw))) { logLine('[liftover] CrossMap produced no output VCF'); uploadAudit(); process.exit(7); }

  // 3. sort + bgzip + index the lifted VCF; keep the reject (.unmap) first-class.
  const finalVcf = `${sample}.grch38.vcf.gz`;
  const rejectVcf = `${sample}.liftover_reject.vcf`;
  run('docker', ['run', '--rm', '-v', `${rMp}:/r:ro`, '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_BCFTOOLS, '-c',
    `set -euo pipefail; bcftools sort /w/${liftedRaw} -Oz -o /w/${finalVcf} && tabix -p vcf /w/${finalVcf}; ` +
    `[ -f /w/${liftedRaw}.unmap ] && cp /w/${liftedRaw}.unmap /w/${rejectVcf} || : ; true`],
    'sort + bgzip + index lifted VCF; stage reject');

  // 4. summarize lift rate
  const liftedN = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${finalVcf} | grep -vc '^#'`]) || '0';
  const rejectN = capture('sh', ['-c', `[ -f ${work}/${rejectVcf} ] && grep -vc '^#' ${work}/${rejectVcf} || echo 0`]) || '0';
  const totalIn = Number(liftedN) + Number(rejectN);
  const liftRate = totalIn > 0 ? (Number(liftedN) / totalIn * 100).toFixed(2) : '0';
  logLine(`[liftover] lifted=${liftedN} rejected=${rejectN} (${liftRate}% lift rate)`);
  const valid = Number(liftedN) > 0;

  // 5. persist lifted VCF (+ index) + reject (first-class) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, finalVcf), `${BIOWALLET_GCS}/${finalVcf}`], 'upload GRCh38-lifted VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${finalVcf}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  spawnSync('sh', ['-c', `[ -f ${work}/${rejectVcf} ] && gzip -f ${work}/${rejectVcf} && gcloud storage cp ${work}/${rejectVcf}.gz ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.liftover.manifest/v1', pipeline: 'liftover-crossmap',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { vcf: opts.vcf, source: 'CHM13', target, chain: chainRel, target_fasta: tgtRel },
    tools: { crossmap: IMG_CROSSMAP, bcftools: IMG_BCFTOOLS, htslib: IMG_HTSLIB },
    outputs: { grch38_vcf: `${BIOWALLET_GCS}/${finalVcf}`, reject_vcf: `${BIOWALLET_GCS}/${rejectVcf}.gz` },
    summary: { lifted: Number(liftedN), rejected: Number(rejectN), lift_rate_pct: Number(liftRate) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', path.join(work, 'manifest.json'), `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[liftover] nothing lifted.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[liftover] DONE: ${liftedN} lifted (${liftRate}%), ${rejectN} rejected -> ${BIOWALLET_GCS}/${finalVcf}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
