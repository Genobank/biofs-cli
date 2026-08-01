/**
 * `biofs stream <id>` — stream a BioNFT-gated VCF/BAM/CRAM/FASTQ to stdout via htsget.
 *
 * Pipes cleanly into bcftools/samtools/pysam/seqkit:
 *
 *   biofs stream 0xCCe… | bcftools stats -
 *   biofs stream my-wes | bcftools view -H -
 *   biofs stream my-bam --region chr17:7661779-7687538 | samtools view -
 *   biofs stream my.fastq.gz | seqkit stats -
 *
 * Auto-detects 'variants' vs 'reads' from the registered filename; override
 * with --kind. Region params are forwarded to htsget (server may full-file
 * until tabix slices land; client tools can still filter).
 */
import { Logger } from '../lib/utils/logger';
import { teleStreamStdout, TeleCommonOpts } from '../lib/tele/core';
import { HtsgetKind } from '../lib/htsget/client';

export interface StreamOptions {
  kind?: HtsgetKind;
  quiet?: boolean;
  apiUrl?: string;
  htsgetUrl?: string;
  annotated?: boolean;
  region?: string;
  referenceName?: string;
  /** CLI may pass strings; coerced to number in streamCommand */
  start?: number | string;
  end?: number | string;
  raw?: boolean;
}

export async function streamCommand(rawId: string, options: StreamOptions = {}): Promise<void> {
  try {
    await teleStreamStdout(rawId, {
      kind: options.kind,
      quiet: options.quiet,
      htsgetUrl: options.htsgetUrl,
      annotated: options.annotated,
      region: options.region,
      referenceName: options.referenceName,
      start:
        options.start !== undefined && options.start !== null && options.start !== ''
          ? Number(options.start)
          : undefined,
      end:
        options.end !== undefined && options.end !== null && options.end !== ''
          ? Number(options.end)
          : undefined,
      raw: options.raw,
    });
  } catch (e: any) {
    Logger.error(e?.message || String(e));
    process.exit(6);
  }
}
