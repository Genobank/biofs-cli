/**
 * Canonical biodata type aliases.
 *
 * Inventory, Sequentia metadata, and filename sniffing historically used
 * different strings for the same bytes (`opencravat` vs `sqlite`, `gvcf` vs
 * `vcf`, `VCF` vs `vcf`). `biofs files --filter sqlite` therefore returned
 * zero rows even when hundreds of annotated sqlites were in cache.
 */

const ALIASES: Record<string, string[]> = {
  bam: ['bam', 'cram', 'sam', 'alignment'],
  cram: ['cram', 'bam', 'alignment'],
  sam: ['sam', 'bam'],
  vcf: ['vcf', 'gvcf', 'vcf_chunk', 'bcf', 'somatic-vcf', 'germline-vcf'],
  gvcf: ['gvcf', 'vcf'],
  bcf: ['bcf', 'vcf'],
  sqlite: ['sqlite', 'opencravat', 'database', 'pas', 'db'],
  opencravat: ['opencravat', 'sqlite', 'pas'],
  fastq: ['fastq', 'fq'],
  fq: ['fq', 'fastq'],
  pdf: ['pdf'],
  json: ['json'],
};

export function normalizeTypeToken(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/^\./, '');
}

export function detectFileType(filename: string): string {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.g.vcf.gz') || name.endsWith('.gvcf.gz') || name.endsWith('.gvcf')) return 'gvcf';
  if (name.endsWith('.vcf.gz') || name.endsWith('.vcf') || name.endsWith('.bcf')) return 'vcf';
  if (name.endsWith('.fastq.gz') || name.endsWith('.fq.gz') || name.endsWith('.fastq') || name.endsWith('.fq')) return 'fastq';
  if (name.endsWith('.bam') || name.endsWith('.sam')) return 'bam';
  if (name.endsWith('.cram')) return 'cram';
  if (name.endsWith('.bai') || name.endsWith('.crai') || name.endsWith('.tbi') || name.endsWith('.csi')) return 'genomic_index';
  if (name.endsWith('.sqlite') || name.endsWith('.pas') || name.endsWith('.db')) return 'sqlite';
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'report_html';
  if (name.endsWith('.txt') || name.endsWith('.md')) return 'txt';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1);
  return 'file';
}

export function fileMatchesTypeFilter(filter: string, file: { type?: string; filename?: string; biocid?: string }): boolean {
  const f = normalizeTypeToken(filter);
  if (!f) return true;
  const type = normalizeTypeToken(file.type || '');
  const name = String(file.filename || '').toLowerCase();
  const biocid = String(file.biocid || '').toLowerCase();
  const aliases = ALIASES[f] || [f];
  if (type && aliases.includes(type)) return true;
  if (type === f) return true;
  if (name.endsWith('.' + f) || name.endsWith('.' + f + '.gz')) return true;
  if (biocid.includes('/' + f + '/')) return true;
  if (f === 'sqlite' && (name.endsWith('.pas') || name.endsWith('.sqlite') || type === 'opencravat')) return true;
  if ((f === 'bam' || f === 'cram') && (name.endsWith('.bam') || name.endsWith('.cram'))) return true;
  return false;
}

export function isHeavyGenomicName(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return (
    /\.(bam|cram|sam|fastq|fq|vcf|gvcf|bcf)(\.gz)?$/i.test(n) ||
    n.endsWith('.sqlite') ||
    n.endsWith('.pas')
  );
}
