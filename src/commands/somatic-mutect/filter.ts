/**
 * biofs somatic-mutect filter --vcf <gs://raw.mutect2.vcf.gz> --ref-fasta <gs://ref.fasta> [--stats <gs>] [--out-dir <gs folder>]
 *
 * CPU verb: GATK FilterMutectCalls over a raw Parabricks mutectcaller VCF. Runs wherever invoked
 * (front node or executor) via the broadinstitute/gatk container; no GPU needed. Stages the raw
 * VCF (+ .tbi, + Mutect2 .stats), the reference (+ .fai + .dict) to local scratch, runs
 * FilterMutectCalls, and persists the filtered VCF (+ index + filtering stats + a typed manifest)
 * beside the raw VCF (or to --out-dir). The filtered PASS set is the manufacturing-grade somatic
 * call set that panel selection consumes.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface SomaticMutectFilterOptions {
  vcf: string;        // gs:// raw mutect2 VCF (.vcf.gz)
  refFasta: string;   // gs:// reference fasta the calls were made against
  stats?: string;     // gs:// Mutect2 stats file (default: <vcf>.stats)
  outDir?: string;    // gs:// output folder (default: the raw VCF's folder)
}

const IMG_GATK = process.env.GATK_IMAGE || 'broadinstitute/gatk:4.5.0.0';
const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';

function run(cmd: string, args: string[], label: string): void {
  Logger.info(`[somatic-mutect filter] ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error || r.status !== 0) { Logger.error(`[somatic-mutect filter] ${label} failed (${r.status ?? r.error?.message})`); process.exit(r.status ?? 1); }
}
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

export async function somaticMutectFilterCommand(opts: SomaticMutectFilterOptions): Promise<void> {
  if (!opts.vcf?.startsWith('gs://') || !opts.refFasta?.startsWith('gs://')) {
    Logger.error('--vcf and --ref-fasta must be gs:// URIs'); process.exit(1);
  }
  const statsGs = opts.stats || `${opts.vcf}.stats`;
  const outDir = (opts.outDir || opts.vcf.slice(0, opts.vcf.lastIndexOf('/'))).replace(/\/$/, '');
  const work = fs.mkdtempSync('/tmp/somamu-filter-');
  const rawName = path.basename(opts.vcf);
  const refName = path.basename(opts.refFasta);
  const filteredName = rawName.replace(/\.vcf\.gz$/, '.filtered.vcf.gz');

  run('gcloud', ['storage', 'cp', opts.vcf, path.join(work, rawName)], 'stage raw VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${opts.vcf}.tbi ${work}/ 2>/dev/null || true`], { stdio: 'ignore' });
  run('gcloud', ['storage', 'cp', statsGs, path.join(work, `${rawName}.stats`)], 'stage Mutect2 stats');
  run('gcloud', ['storage', 'cp', opts.refFasta, path.join(work, refName)], 'stage reference');
  run('gcloud', ['storage', 'cp', `${opts.refFasta}.fai`, path.join(work, `${refName}.fai`)], 'stage reference .fai');
  const dictGs = opts.refFasta.replace(/\.(fa|fasta)$/, '.dict');
  const gotDict = spawnSync('sh', ['-c', `gcloud storage cp ${dictGs} ${work}/ 2>/dev/null || gcloud storage cp ${opts.refFasta}.dict ${work}/ 2>/dev/null`], { stdio: 'ignore' });
  if (gotDict.status !== 0) { Logger.error('reference .dict not found beside the fasta (FilterMutectCalls requires it)'); process.exit(1); }
  spawnSync('sh', ['-c', `[ -f ${work}/${rawName}.tbi ] || docker run --rm -v ${work}:/w:rw --entrypoint bash ${IMG_HTSLIB} -c "tabix -p vcf /w/${rawName}"`], { stdio: 'inherit' });

  run('docker', ['run', '--rm', '-v', `${work}:/w:rw`, IMG_GATK, 'gatk', 'FilterMutectCalls',
    '-V', `/w/${rawName}`, '-R', `/w/${refName}`, '--stats', `/w/${rawName}.stats`,
    '--filtering-stats', `/w/filteringStats.tsv`, '-O', `/w/${filteredName}`],
    `GATK FilterMutectCalls (${IMG_GATK})`);
  if (!fs.existsSync(path.join(work, filteredName))) { Logger.error('FilterMutectCalls produced no output'); process.exit(7); }

  const total = capture('sh', ['-c', `docker run --rm -v ${work}:/w:ro --entrypoint bash ${IMG_HTSLIB} -c "zcat /w/${filteredName} | grep -vc '^#'"`]) || '0';
  const passN = capture('sh', ['-c', `docker run --rm -v ${work}:/w:ro --entrypoint bash ${IMG_HTSLIB} -c "zcat /w/${filteredName} | awk -F'\\t' '!/^#/ && \\$7==\\"PASS\\"' | wc -l"`]) || '0';

  run('gcloud', ['storage', 'cp', path.join(work, filteredName), `${outDir}/${filteredName}`], 'upload filtered VCF');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/${filteredName}.tbi ${outDir}/ 2>/dev/null || true; gcloud storage cp ${work}/filteringStats.tsv ${outDir}/ 2>/dev/null || true`], { stdio: 'ignore' });
  const manifest = {
    schema: 'genobank.somamu.filter/v1', tool: IMG_GATK,
    inputs: { raw_vcf: opts.vcf, stats: statsGs, reference: opts.refFasta },
    outputs: { filtered_vcf: `${outDir}/${filteredName}`, filtering_stats: `${outDir}/filteringStats.tsv` },
    summary: { total_variants: Number(total), pass_variants: Number(passN) },
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(work, 'filter-manifest.json'), JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', path.join(work, 'filter-manifest.json'), `${outDir}/filter-manifest.json`], 'upload filter manifest');
  Logger.info(`[somatic-mutect filter] DONE: total=${total} PASS=${passN} -> ${outDir}/${filteredName}`);
  console.log(JSON.stringify(manifest.summary));
  process.exit(0);
}
