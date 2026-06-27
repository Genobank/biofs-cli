/**
 * biofs dipcall exec --sample <serial> --hap1 <gs hap1.fa> --hap2 <gs hap2.fa> [--ref CHM13] ...
 *
 * EXECUTOR verb: assembly-based variant calling (dipcall, Li 2018). biofs-node spawns this; no
 * orphan script. Study 2 of the long-read multiomic design: a PHASED diploid assembly (two
 * haplotype FASTAs, e.g. hifiasm asm_ctgs_m_p.fa / asm_ctgs_m_a.fa) is aligned to the reference
 * with minimap2 and dipcall emits a per-haplotype-resolved VCF + a confident-region BED. The
 * assembly-based callset is orthogonal to the read-based callers (Study 1) and surfaces variants
 * in regions read-based callers miss; the confident BED gates the comparison.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/dipcall/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface DipcallExecOptions {
  sample: string;
  hap1: string;          // gs:// haplotype-1 assembly FASTA
  hap2: string;          // gs:// haplotype-2 assembly FASTA
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_DIPCALL = process.env.DIPCALL_IMAGE || 'quay.io/biocontainers/dipcall:0.3--hdfd78af_0';
const IMG_HTSLIB  = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[dipcall] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[dipcall] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[dipcall] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

export async function dipcallExecCommand(opts: DipcallExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `dipcall-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `dipcall-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/dipcall/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[dipcall] start sample=${sample} jobId=${jobId}`);
  logLine(`[dipcall] hap1=${opts.hap1} hap2=${opts.hap2}`);

  // fuse allow_other (so the root-in-container dipcall can read the mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // reference selection honors --ref: CHM13 | GRCh38 (default). Stage to local NVMe (dipcall's
  // minimap2 indexes it + does heavy random access; local is faster and avoids gcsfuse quirks).
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta'];
  const rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(refBucket, rMp);
  let refRel = '';
  for (const rel of refCandidates) { if (fs.existsSync(path.join(rMp, rel))) { refRel = rel; break; } }
  if (!refRel) { logLine(`[dipcall] no reference fasta for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }
  const localRef = path.basename(refRel);
  run('gcloud', ['storage', 'cp', `gs://${refBucket}/${refRel}`, path.join(work, localRef)], 'stage reference to local NVMe');
  spawnSync('sh', ['-c', `gcloud storage cp gs://${refBucket}/${refRel}.fai ${work}/ 2>/dev/null || true`], { stdio: 'ignore' });
  logLine(`[dipcall] ref=${refRel}`);

  // stage the two haplotype assemblies to local NVMe
  const h1 = `${sample}.hap1.fa`, h2 = `${sample}.hap2.fa`;
  run('gcloud', ['storage', 'cp', opts.hap1, path.join(work, h1)], 'stage hap1 assembly');
  run('gcloud', ['storage', 'cp', opts.hap2, path.join(work, h2)], 'stage hap2 assembly');

  // dipcall: run-dipcall builds a makefile (minimap2 align each hap -> paftools call -> merge),
  // then make runs it, emitting <prefix>.dip.vcf.gz (variants) + <prefix>.dip.bed (confident regions).
  const prefix = `${sample}.dip`;
  const threads = capture('nproc', []) || '16';
  run('docker', ['run', '--rm', '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_DIPCALL, '-c',
    `set -euo pipefail; cd /w; run-dipcall -t ${threads} ${prefix} /w/${localRef} /w/${h1} /w/${h2} > /w/${prefix}.mak && make -j2 -f /w/${prefix}.mak`],
    'run-dipcall (minimap2 + paftools, both haplotypes -> dip VCF + confident BED)');
  const dipVcf = `${prefix}.dip.vcf.gz`;
  const dipBed = `${prefix}.dip.bed`;
  if (!fs.existsSync(path.join(work, dipVcf))) { logLine('[dipcall] dipcall produced no VCF'); uploadAudit(); process.exit(7); }
  spawnSync('sh', ['-c', `[ -f ${work}/${dipVcf}.tbi ] || docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_HTSLIB} -c "tabix -p vcf /w/${dipVcf}" 2>/dev/null || true`], { stdio: 'ignore' });

  // summarize
  const total = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${dipVcf} | grep -vc '^#'`]) || '0';
  const passN = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${dipVcf} | awk -F'\\t' '!/^#/ && $7=="PASS"' | wc -l`]) || '0';
  const bedBp = capture('sh', ['-c', `[ -f ${work}/${dipBed} ] && awk '{s+=$3-$2} END{print s}' ${work}/${dipBed} || echo 0`]) || '0';
  logLine(`[dipcall] assembly-based calls: total=${total} PASS=${passN} confident_bp=${bedBp}`);
  const valid = Number(total) > 0;

  // persist VCF (+ index) + confident BED + manifest
  run('gcloud', ['storage', 'cp', path.join(work, dipVcf), `${BIOWALLET_GCS}/${dipVcf}`], 'upload dipcall VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${dipVcf}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true; gcloud storage cp ${work}/${dipBed} ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.dipcall.manifest/v1', pipeline: 'dipcall-assembly',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { hap1: opts.hap1, hap2: opts.hap2, reference: refRel, ref: wantsCHM13 ? 'CHM13' : 'GRCh38' },
    tools: { dipcall: IMG_DIPCALL, htslib: IMG_HTSLIB },
    outputs: { dip_vcf: `${BIOWALLET_GCS}/${dipVcf}`, confident_bed: `${BIOWALLET_GCS}/${dipBed}` },
    summary: { total_variants: Number(total), pass_variants: Number(passN), confident_bp: Number(bedBp) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', path.join(work, 'manifest.json'), `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[dipcall] no variants produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[dipcall] DONE: ${total} assembly-based variants (${passN} PASS, ${bedBp} confident bp) -> ${BIOWALLET_GCS}/${dipVcf}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
