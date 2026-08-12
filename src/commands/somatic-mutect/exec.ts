/**
 * biofs somatic-mutect exec --sample <caseId> --tumor-bam <gs> --normal-bam <gs> [--ref-fasta gs://...] ...
 *
 * EXECUTOR verb: GPU-side tumor/normal somatic small-variant caller (NVIDIA Parabricks
 * mutectcaller = GPU Mutect2). biofs-node spawns this on a Parabricks GPU executor; no orphan
 * script. Both aligned BAMs (+ .bai) and the exact reference they were aligned to are staged to
 * local NVMe (Mutect2 does heavy random access; gcsfuse random reads are slow), tumor/normal
 * sample names are read from each BAM's own @RG SM tag, `pbrun mutectcaller` runs on the GPU
 * (--mutect-low-memory per the production Parabricks profile), and the somatic VCF + a typed
 * manifest are persisted to the biowallet somatic-mutect/ folder. Exits 0 on a valid call set.
 *
 * A non-blocking identity sanity check pileups a configurable hotspot locus (default KRAS G12D,
 * b37 12:25398284) in both staged BAMs and writes the alt fractions to the run log, so the run
 * itself documents which BAM carries the tumor signal.
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/somatic-mutect/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface SomaticMutectExecOptions {
  sample: string;        // case id (job label; sample names come from the BAM @RG SM tags)
  tumorBam: string;      // gs:// aligned tumor BAM
  normalBam: string;     // gs:// aligned matched-normal BAM
  refFasta?: string;     // explicit gs:// reference fasta (must match the BAM alignment reference)
  lowMemory?: boolean;   // pbrun --mutect-low-memory (default true)
  hotspot?: string;      // identity sanity pileup locus, "CTG:POS" (default 12:25398284, KRAS G12D b37)
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_SAMTOOLS = 'quay.io/biocontainers/samtools:1.19.2--h50ea8bc_1';
const IMG_PARABRICKS = process.env.PARABRICKS_IMAGE || 'nvcr.io/nvidia/clara/clara-parabricks:4.7.0-1';

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[somatic-mutect] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[somatic-mutect] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[somatic-mutect] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
}
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

export async function somaticMutectExecCommand(opts: SomaticMutectExecOptions): Promise<void> {
  const caseId = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'deepvariant-fastq-to-vcf-genobank-app';
  const jobId = opts.jobId || `somamu-${caseId}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const lowMemory = opts.lowMemory !== false;
  const hotspot = opts.hotspot || '12:25398284';

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `somamu-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/somatic-mutect/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[somatic-mutect] start case=${caseId} jobId=${jobId}`);
  logLine(`[somatic-mutect] tumor BAM=${opts.tumorBam}`);
  logLine(`[somatic-mutect] normal BAM=${opts.normalBam}`);
  logLine(`[somatic-mutect] biowallet folder: ${BIOWALLET_GCS}`);

  if (!opts.tumorBam?.startsWith('gs://') || !opts.normalBam?.startsWith('gs://')) {
    logLine('[somatic-mutect] --tumor-bam and --normal-bam must be gs:// URIs'); uploadAudit(); process.exit(1);
  }

  // Parabricks runs inside the Clara container; require the image + an NVIDIA GPU on this executor.
  const haveImg = capture('sh', ['-c', `docker image inspect ${IMG_PARABRICKS} >/dev/null 2>&1 && echo yes || echo no`]) === 'yes';
  if (!haveImg) { logLine(`[somatic-mutect] Parabricks image ${IMG_PARABRICKS} not present; this verb requires a Parabricks GPU executor`); uploadAudit(); process.exit(1); }
  const gpuName = capture('sh', ['-c', 'nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true']);
  if (!gpuName) { logLine('[somatic-mutect] no NVIDIA GPU detected (nvidia-smi); cannot run pbrun'); uploadAudit(); process.exit(1); }
  logLine(`[somatic-mutect] parabricks=${IMG_PARABRICKS} gpu=${gpuName} lowMemory=${lowMemory}`);

  // 0. stage tumor + normal BAM (+ .bai) to local NVMe (sequential copy; Mutect2 random access
  //    then runs at NVMe speed). Index fallback: <bam>.bai or <bam without .bam>.bai.
  const stage = (gsBam: string, base: string): string => {
    const local = path.join(work, `${base}.bam`);
    run('gcloud', ['storage', 'cp', gsBam, local], `stage ${base} BAM to local NVMe`);
    const baiA = `${gsBam}.bai`, baiB = gsBam.replace(/\.bam$/, '.bai');
    const gotBai = spawnSync('sh', ['-c', `gcloud storage cp ${baiA} ${local}.bai 2>/dev/null || gcloud storage cp ${baiB} ${local}.bai 2>/dev/null`], { stdio: 'ignore' });
    if (gotBai.status !== 0 || !fs.existsSync(`${local}.bai`)) {
      run('docker', ['run', '--rm', '-v', `${work}:/w:rw`, IMG_SAMTOOLS, 'samtools', 'index', `/w/${base}.bam`], `index ${base} BAM (no .bai in bucket)`);
    }
    return local;
  };
  const tumorLocal = stage(opts.tumorBam, 'tumor');
  const normalLocal = stage(opts.normalBam, 'normal');

  // sample names come from each BAM's own @RG SM tag (Parabricks requires exact SM matches)
  const smOf = (base: string): string =>
    capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_SAMTOOLS, '-c',
      `samtools view -H /w/${base}.bam | grep -m1 '^@RG' | tr '\\t' '\\n' | grep '^SM:' | cut -c4- | head -1`]);
  const tumorSM = smOf('tumor'); const normalSM = smOf('normal');
  if (!tumorSM || !normalSM) { logLine(`[somatic-mutect] missing @RG SM tag (tumor='${tumorSM}' normal='${normalSM}'); reheader the BAMs first`); uploadAudit(); process.exit(1); }
  if (tumorSM === normalSM) { logLine(`[somatic-mutect] tumor and normal share SM '${tumorSM}'; Mutect2 needs distinct sample names`); uploadAudit(); process.exit(1); }
  logLine(`[somatic-mutect] tumor SM=${tumorSM} normal SM=${normalSM}`);

  // 1. reference: exact assembly the BAMs were aligned to. Explicit --ref-fasta wins; else b37
  //    candidates (hs37d5 with decoys first — the standard Signatera/1000G alignment reference).
  const refCandidates = opts.refFasta ? [opts.refFasta] : [
    `gs://${refBucket}/reference/hs37d5/Homo_sapiens_assembly19_1000genomes_decoy.fasta`,
    `gs://${refBucket}/reference/hg19/Homo_sapiens_assembly19.fasta`,
  ];
  let refGs = '';
  for (const cand of refCandidates) {
    const ok = spawnSync('sh', ['-c', `gcloud storage ls ${cand} >/dev/null 2>&1 && gcloud storage ls ${cand}.fai >/dev/null 2>&1`], { stdio: 'ignore' });
    if (ok.status === 0) { refGs = cand; break; }
  }
  if (!refGs) { logLine(`[somatic-mutect] no reference fasta (+.fai) found among: ${refCandidates.join(', ')}`); uploadAudit(); process.exit(1); }
  const localRef = path.basename(refGs);
  run('gcloud', ['storage', 'cp', refGs, path.join(work, localRef)], 'stage reference to local NVMe');
  run('gcloud', ['storage', 'cp', `${refGs}.fai`, path.join(work, `${localRef}.fai`)], 'stage reference .fai');
  spawnSync('sh', ['-c', `gcloud storage cp ${refGs.replace(/\.(fa|fasta)$/, '.dict')} ${work}/ 2>/dev/null || gcloud storage cp ${refGs}.dict ${work}/ 2>/dev/null || true`], { stdio: 'ignore' });
  logLine(`[somatic-mutect] ref=${refGs}`);

  // 1b. identity sanity check (non-blocking): pileup the hotspot in both BAMs and log alt fractions,
  //     so the run log itself documents which BAM carries the tumor signal.
  for (const base of ['tumor', 'normal']) {
    const pile = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_SAMTOOLS, '-c',
      `samtools mpileup -r ${hotspot}-${hotspot.split(':')[1]} -f /w/${localRef} /w/${base}.bam 2>/dev/null | head -1`]);
    logLine(`[somatic-mutect] hotspot ${hotspot} ${base}: ${pile ? pile.split('\t').slice(3, 5).join(' ') : 'no coverage/parse'}`);
  }

  // 2. pbrun mutectcaller (Mutect2 tumor/normal, GPU) inside the Clara container.
  const vcfGz = `${caseId}.mutect2.vcf.gz`;
  const mutectArgs = ['pbrun', 'mutectcaller',
    '--ref', `/w/${localRef}`,
    '--in-tumor-bam', '/w/tumor.bam', '--tumor-name', tumorSM,
    '--in-normal-bam', '/w/normal.bam', '--normal-name', normalSM,
    '--out-vcf', `/w/${vcfGz}`, '--num-gpus', '1'];
  if (lowMemory) mutectArgs.push('--mutect-low-memory');
  run('docker', ['run', '--rm', '--gpus', 'all', '-v', `${work}:/w:rw`, IMG_PARABRICKS, ...mutectArgs],
    'pbrun mutectcaller (Mutect2 tumor/normal somatic calling, GPU, local NVMe)');
  const producedVcf = fs.existsSync(path.join(work, vcfGz)) ? vcfGz
    : (fs.existsSync(path.join(work, vcfGz.replace(/\.gz$/, ''))) ? vcfGz.replace(/\.gz$/, '') : '');
  if (!producedVcf) { logLine('[somatic-mutect] pbrun produced no VCF'); uploadAudit(); process.exit(7); }
  let finalVcf = producedVcf;
  if (!finalVcf.endsWith('.gz')) {
    run('docker', ['run', '--rm', '-v', `${work}:/w:rw`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `bgzip -f /w/${finalVcf}`], 'bgzip somatic VCF');
    finalVcf = `${finalVcf}.gz`;
  }
  spawnSync('sh', ['-c', `[ -f "${work}/${finalVcf}.tbi" ] || docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_HTSLIB} -c "tabix -p vcf /w/${finalVcf}"`], { stdio: 'ignore' });

  // 3. summarize
  const total = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${finalVcf} | grep -vc '^#'`]) || '0';
  const passN = capture('docker', ['run', '--rm', '-v', `${work}:/w:ro`, '--entrypoint', 'bash', IMG_HTSLIB, '-c', `zcat /w/${finalVcf} | awk -F'\\t' '!/^#/ && $7=="PASS"' | wc -l`]) || '0';
  logLine(`[somatic-mutect] Mutect2 calls: total=${total} PASS=${passN}`);
  const valid = Number(total) > 0;

  // 4. persist VCF (+ index) + manifest
  run('gcloud', ['storage', 'cp', path.join(work, finalVcf), `${BIOWALLET_GCS}/${finalVcf}`], 'upload somatic Mutect2 VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${finalVcf}.tbi ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${vcfGz.replace(/\.vcf\.gz$/, '')}*.stats ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });

  const manifest = {
    schema: 'genobank.somamu.manifest/v1', pipeline: 'somatic-mutect2',
    jobId, caseId, creator: walletLc, status: valid ? 'OK' : 'EMPTY',
    inputs: { tumorBam: opts.tumorBam, normalBam: opts.normalBam, tumorSM, normalSM, reference: refGs, lowMemory },
    tools: { parabricks_mutectcaller: IMG_PARABRICKS, htslib: IMG_HTSLIB, samtools: IMG_SAMTOOLS },
    outputs: { somatic_vcf: `${BIOWALLET_GCS}/${finalVcf}` },
    summary: { total_variants: Number(total), pass_variants: Number(passN) },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  uploadAudit();

  if (!valid) { logLine('[somatic-mutect] no variants produced.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[somatic-mutect] DONE: ${total} variants (${passN} PASS) persisted to ${BIOWALLET_GCS}/${finalVcf}`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
