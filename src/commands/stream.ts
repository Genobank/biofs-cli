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
import { nodeRegionEligible, streamNodeRegionToStdout } from '../lib/tele/region_node';
import { resolveAlias } from '../lib/aliases/store';
import { HtsgetKind } from '../lib/htsget/client';

export interface StreamOptions {
  kind?: HtsgetKind;
  quiet?: boolean;
  apiUrl?: string;
  htsgetUrl?: string;
  annotated?: boolean;
  region?: string;
  viaHtsget?: boolean;
  referenceName?: string;
  /** CLI may pass strings; coerced to number in streamCommand */
  start?: number | string;
  end?: number | string;
  raw?: boolean;
}

export async function streamCommand(rawId: string, options: StreamOptions = {}): Promise<void> {
  try {
    const aliasId = resolveAlias(rawId);
    if (!options.viaHtsget && !options.annotated && nodeRegionEligible(aliasId, options.region)) {
      // The region is cut by biofs-node with the index beside the file (GET /agent/region_read): a valid BAM or bgzipped VCF of that region only.
      await streamNodeRegionToStdout(aliasId, options.region as string, { quiet: options.quiet });
      return;
    }
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
