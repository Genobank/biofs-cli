/**
 * biofs ont-variants exec --sample <serial> --modbam <gs> [--model ...] [--ref auto] ...
 *
 * EXECUTOR verb: VM-side ONT small-variant caller (Clair3). biofs-node spawns this; no orphan
 * script. Reads the aligned modBAM from the gcsfuse RO mount (never downloaded) plus the
 * reference the BAM was aligned to, runs Clair3 with the R10.4.1 sup model matched to the
 * dorado basecaller, restricted to the primary chromosomes, persists the SNV/indel VCF + a
 * typed manifest to the biowallet ont-variants/ folder, exits 0 on a valid call set.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/ont-variants/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface OntVariantsExecOptions {
  sample: string;
  modbam: string;        // gs:// merged aligned ONT modBAM
  model?: string;        // Clair3 model name (auto-picked from the image if empty)
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_CLAIR3 = 'hkubal/clair3:latest';
// primary chromosomes only (assembly38 is chr-prefixed); skip chrM + the 3000+ alt/decoy contigs
const PRIMARY_CTGS = Array.from({ length: 22 }, (_, i) => `chr${i + 1}`).concat(['chrX', 'chrY']).join(',');

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[ont-variants] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[ont-variants] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[ont-variants] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

// pick the best ONT R10.4.1 sup Clair3 model bundled in the image
function pickModel(): string {
  const listed = capture('docker', ['run', '--rm', '--entrypoint', 'bash', IMG_CLAIR3, '-c', 'ls /opt/models 2>/dev/null']);
  const models = listed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  // need a plain sup model: the merged modBAM has no move-table (mv:) tag, and bacteria/finetuned do not apply
  const r10sup = models.filter((m) => /r104?1/.test(m) && /sup/.test(m) && !/with_mv|bacteria|finetuned/.test(m)).sort();
  if (r10sup.length) return r10sup[r10sup.length - 1];
  const r10 = models.filter((m) => /r104?1/.test(m)).sort();
  if (r10.length) return r10[r10.length - 1];
  return 'r1041_e82_400bps_sup_v500';
}

export async function ontVariantsExecCommand(opts: OntVariantsExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `ontvar-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `ontvar-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const outDir = path.join(work, 'clair3'); fs.mkdirSync(outDir, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/ont-variants/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[ont-variants] start sample=${sample} jobId=${jobId}`);
  logLine(`[ont-variants] modBAM=${opts.modbam}`);
  logLine(`[ont-variants] biowallet folder: ${BIOWALLET_GCS}`);

  // fuse allow_other (so root-in-container Clair3 reads the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): modBAM bucket + reference bucket
  const obkt = bucketOf(opts.modbam);
  const oMp = `/mnt/gcsfuse-${obkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(refBucket, rMp);
  const modbamRel = gsToLocalRel(opts.modbam, obkt);
  if (!fs.existsSync(path.join(oMp, modbamRel))) { logLine(`[ont-variants] modBAM not found at mount: ${path.join(oMp, modbamRel)}`); uploadAudit(); process.exit(1); }

  // reference selection honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; else GRCh38 (default).
  // Must be the EXACT assembly the modBAM was aligned to, or contigs in the BAM header are dropped.
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta'];
  let refRel = '';
  for (const rel of refCandidates) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine(`[ont-variants] no reference fasta (+.fai) for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }

  const model = opts.model || pickModel();
  const threads = capture('nproc', []) || '8';
  logLine(`[ont-variants] ref=${refRel} model=${model} threads=${threads} ctgs=primary(chr1-22,X,Y)`);

  // 1. Clair3 (ONT) restricted to primary chromosomes
  run('docker', ['run', '--rm',
    '-v', `${oMp}:/o:ro`, '-v', `${rMp}:/r:ro`, '-v', `${work}:/w:rw`,
    '--entrypoint', 'bash', IMG_CLAIR3, '-c',
    `set -euo pipefail; /opt/bin/run_clair3.sh ` +
    `--bam_fn="/o/${modbamRel}" --ref_fn="/r/${refRel}" --threads=${threads} --platform=ont ` +
    `--model_path="/opt/models/${model}" --output=/w/clair3 --ctg_name=${PRIMARY_CTGS} --sample_name=${sample}`],
    'Clair3 ONT small-variant calling');

  const mergedVcf = path.join(outDir, 'merge_output.vcf.gz');
  if (!fs.existsSync(mergedVcf)) { logLine('[ont-variants] Clair3 produced no merge_output.vcf.gz'); uploadAudit(); process.exit(7); }
  const finalVcf = `${sample}.ont.clair3.vcf.gz`;
  run('sh', ['-c', `cp "${mergedVcf}" "${work}/${finalVcf}" && cp "${mergedVcf}.tbi" "${work}/${finalVcf}.tbi" 2>/dev/null || cp "${mergedVcf}" "${work}/${finalVcf}"`], 'stage final VCF');
  spawnSync('sh', ['-c', `[ -f "${work}/${finalVcf}.tbi" ] || docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_HTSLIB} -c "tabix -p vcf /w/${finalVcf}"`], { stdio: 'ignore' });

  // 2. summarize
  const total = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${finalVcf} | grep -vc '^#'`]) || '0';
  const passN = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${finalVcf} | awk -F'\\t' '!/^#/ && $7=="PASS"' | wc -l`]) || '0';
  logLine(`[ont-variants] Clair3 calls: total=${total} PASS=${passN}`);
  const valid = Number(total) > 0;

  // 3. persist VCF (+ index) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, finalVcf), `${BIOWALLET_GCS}/${finalVcf}`], 'upload ONT VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${finalVcf}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.ontvariants.manifest/v1', pipeline: 'ont-clair3-snv',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { modbam: opts.modbam, reference: refRel, model, ctgs: 'primary' },
    tools: { clair3: IMG_CLAIR3, htslib: IMG_HTSLIB },
    outputs: { snv_indel_vcf: `${BIOWALLET_GCS}/${finalVcf}` },
    summary: { total_variants: Number(total), pass_variants: Number(passN) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[ont-variants] no variants produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[ont-variants] DONE: ${total} variants (${passN} PASS) persisted to ${BIOWALLET_GCS}/${finalVcf}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
