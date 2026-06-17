/**
 * biofs repeat-genotype exec --sample <serial> --bam <gs> --catalog <gs> [--ref auto] ...
 *
 * EXECUTOR verb: VM-side tandem-repeat / repeat-expansion genotyper (TRGT, PacBio HiFi).
 * biofs-node spawns this; no orphan script. Streams the aligned HiFi BAM straight from the
 * gcsfuse RO mount (the BAM is NEVER downloaded) plus the repeat catalog BED and the reference
 * the BAM was aligned to, runs `trgt genotype`, sorts + indexes the (possibly unsorted) TRGT VCF
 * with bcftools/htslib, persists the repeat VCF + a typed manifest to the biowallet repeats/
 * folder, exits 0 on a valid call set (biofs-node anchors a ClaraJobNFT).
 * (straglr is the ONT long-read alternative; this implements TRGT for HiFi.)
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/repeats/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface RepeatGenotypeExecOptions {
  sample: string;
  bam: string;           // gs:// aligned HiFi BAM
  catalog: string;       // gs:// repeat catalog BED (repeat definitions)
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_TRGT     = 'quay.io/biocontainers/trgt:1.2.0--h9ee0642_0';
const IMG_HTSLIB   = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_BCFTOOLS = 'quay.io/biocontainers/bcftools:1.19--h8b25389_0';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[repeat-genotype] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[repeat-genotype] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[repeat-genotype] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
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

export async function repeatGenotypeExecCommand(opts: RepeatGenotypeExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `repeatgt-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `repeatgt-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/repeats/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[repeat-genotype] start sample=${sample} jobId=${jobId}`);
  logLine(`[repeat-genotype] BAM=${opts.bam}`);
  logLine(`[repeat-genotype] catalog=${opts.catalog}`);
  logLine(`[repeat-genotype] biowallet folder: ${BIOWALLET_GCS}`);

  // A repeat catalog (BED of repeat definitions) is mandatory for TRGT.
  if (!opts.catalog || !opts.catalog.startsWith('gs://')) {
    logLine('[repeat-genotype] a repeat catalog (--catalog gs://repeats.bed) is required'); uploadAudit(); process.exit(1);
  }

  // fuse allow_other (so the root-in-container TRGT can read the ubuntu-owned gcsfuse mount)
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO): aligned-BAM bucket + catalog bucket + reference bucket
  const obkt = bucketOf(opts.bam);
  const cbkt = bucketOf(opts.catalog);
  const oMp = `/mnt/gcsfuse-${obkt}`, cMp = `/mnt/gcsfuse-${cbkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(cbkt, cMp); gcsfuseRO(refBucket, rMp);
  const bamRel = gsToLocalRel(opts.bam, obkt);
  if (!fs.existsSync(path.join(oMp, bamRel))) { logLine(`[repeat-genotype] BAM not found at mount: ${path.join(oMp, bamRel)}`); uploadAudit(); process.exit(1); }
  const catalogRel = gsToLocalRel(opts.catalog, cbkt);
  if (!fs.existsSync(path.join(cMp, catalogRel))) { logLine(`[repeat-genotype] catalog not found at mount: ${path.join(cMp, catalogRel)}`); uploadAudit(); process.exit(1); }

  // reference selection honors --ref: 'CHM13'/'T2T' -> T2T-CHM13 v2.0; else GRCh38 (default).
  // Must be the EXACT assembly the HiFi BAM was aligned to, AND match the --catalog coordinates.
  const wantsCHM13 = /^(chm13|t2t)/.test((opts.ref || 'auto').toLowerCase());
  const refCandidates = wantsCHM13
    ? ['CHM13/chm13v2.0.fasta', 'CHM13/chm13v2.0.fa']
    : ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta'];
  let refRel = '';
  for (const rel of refCandidates) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) { refRel = rel; break; }
  }
  if (!refRel) { logLine(`[repeat-genotype] no reference fasta (+.fai) for ref=${opts.ref || 'auto'}`); uploadAudit(); process.exit(1); }
  logLine(`[repeat-genotype] ref=${refRel}`);

  const threads = capture('nproc', []) || '8';
  const pfx = `${sample}.trgt`;
  const rawVcfGz = `${pfx}.vcf.gz`;                 // TRGT raw output (may be unsorted)
  const sortedVcfGz = `${sample}.trgt.sorted.vcf.gz`;
  const finalVcfGz = `${sample}.trgt.vcf.gz`;       // sorted + indexed deliverable
  const spanningBam = `${pfx}.spanning.bam`;

  // 1. TRGT genotype (single pass over the gcsfuse-mounted HiFi BAM)
  //    -> <pfx>.vcf.gz + <pfx>.spanning.bam
  run('docker', dk(IMG_TRGT, [[oMp, '/o', 'ro'], [cMp, '/c', 'ro'], [rMp, '/r', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; trgt genotype --genome "/r/${refRel}" --repeats "/c/${catalogRel}" ` +
      `--reads "/o/${bamRel}" --threads ${threads} --output-prefix /w/${pfx}`]), 'TRGT repeat genotyping');

  // 2. sort + index (TRGT VCF may be unsorted) with bcftools/htslib
  run('docker', dk(IMG_BCFTOOLS, [[work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; bcftools sort -Oz -o /w/${sortedVcfGz} /w/${rawVcfGz} && mv /w/${sortedVcfGz} /w/${finalVcfGz}`]), 'bcftools sort repeat VCF');
  run('docker', dk(IMG_HTSLIB, [[work, '/w', 'rw']], 'bash', ['-c', `set -e; tabix -p vcf /w/${finalVcfGz} || true`]), 'tabix repeat VCF');
  // also index the spanning-reads BAM if TRGT produced one
  spawnSync('sh', ['-c', `[ -f ${work}/${spanningBam} ] && docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_BCFTOOLS} -c 'samtools index /w/${spanningBam}' 2>/dev/null || true`], { stdio: 'ignore' });

  // 3. summarize: number of loci genotyped
  const total = capture('docker', sdk(IMG_HTSLIB, [[work, '/w', 'ro']], 'bash', ['-c', `zcat /w/${finalVcfGz} | grep -vc '^#'`])).slice(1) || '0';
  logLine(`[repeat-genotype] TRGT genotyped loci: total=${total}`);
  const valid = Number(total) >= 0 && fs.existsSync(path.join(work, finalVcfGz));

  // 4. persist VCF (+ index, + spanning BAM) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, finalVcfGz), `${BIOWALLET_GCS}/${finalVcfGz}`], 'upload repeat VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${finalVcfGz}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${spanningBam} ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${spanningBam}.bai ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.repeatgenotype.manifest/v1', pipeline: 'hifi-trgt-repeats',
    jobId, biosampleId: sample, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { bam: opts.bam, catalog: opts.catalog, reference: refRel },
    tools: { trgt: IMG_TRGT, bcftools: IMG_BCFTOOLS, htslib: IMG_HTSLIB },
    outputs: { repeat_vcf: `${BIOWALLET_GCS}/${finalVcfGz}`, spanning_bam: `${BIOWALLET_GCS}/${spanningBam}` },
    summary: { loci_genotyped: Number(total) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[repeat-genotype] no repeat VCF produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[repeat-genotype] DONE: ${total} repeat loci genotyped -> ${BIOWALLET_GCS}/${finalVcfGz}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
