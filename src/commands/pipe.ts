/**
 * `biofs pipe <id> -- [tool args]` — pipe a BioIP stream into bcftools/samtools view.
 *
 * Auto-detects the right tool from the registered filename:
 *   .vcf/.vcf.gz/.bcf  → bcftools view
 *   .bam/.cram/.sam     → samtools view
 *   .fastq/.fq          → seqkit stats (unless --tool overrides)
 *
 * Any args after `--` pass through to the tool:
 *   biofs pipe my-wes -- -H
 *   biofs pipe my-wes -- -r chr17:1000000-2000000
 */
import { Logger } from '../lib/utils/logger';
import {
  resolveTele,
  telePipe,
  requireTool,
  installHint,
  TeleCommonOpts,
} from '../lib/tele/core';
import { nodeRegionEligible, nodeWholeEligible, tryOpenNodeWhole, pipeNodeRegionToCommand } from '../lib/tele/region_node';
import { resolveAlias } from '../lib/aliases/store';

export interface PipeOptions extends TeleCommonOpts {
  extra?: string[];
  tool?: 'bcftools' | 'samtools' | 'seqkit';
  quiet?: boolean;
  htsgetUrl?: string;
  region?: string;
  viaHtsget?: boolean;
}

function detectTool(filename: string): 'bcftools' | 'samtools' | 'seqkit' | null {
  const f = filename.toLowerCase();
  if (f.endsWith('.vcf') || f.endsWith('.vcf.gz') || f.endsWith('.bcf') || f.endsWith('.g.vcf') || f.endsWith('.g.vcf.gz')) {
    return 'bcftools';
  }
  if (f.endsWith('.bam') || f.endsWith('.cram') || f.endsWith('.sam')) return 'samtools';
  if (f.endsWith('.fastq') || f.endsWith('.fastq.gz') || f.endsWith('.fq') || f.endsWith('.fq.gz')) {
    return 'seqkit';
  }
  return null;
}

/**
 * The tool argv for `biofs pipe`. When a region is asked for and the tool is bcftools, the region is also applied here as a
 * streaming targets filter (`-t chr:start-end`): the htsget server may return the whole file for a region query (found
 * 19 November 2026, a region read of a somatic VCF came back from chr1), and `-r` cannot be used on a stream with no index.
 * samtools cannot filter an unindexed stream by region, so for reads the caller is told the region was not applied here.
 */
export function buildPipeArgs(
  tool: 'bcftools' | 'samtools' | 'seqkit',
  extra: string[],
  region?: string,
): { args: string[]; regionAppliedClientSide: boolean; regionNote?: string } {
  const clean = (extra || []).filter((x) => x !== '--');
  if (tool === 'seqkit') {
    let args = clean.length ? clean : ['stats'];
    if (args[0] === 'stats' || !clean.length) {
      args = ['stats', '-'];
    } else if (!args.includes('-')) {
      args = [...args, '-'];
    }
    return { args, regionAppliedClientSide: false, regionNote: region ? 'region is ignored for FASTQ streams' : undefined };
  }
  if (region && tool === 'bcftools') {
    const userTargets = clean.some((x) => x === '-t' || x === '--targets' || x === '-r' || x === '--regions' || x.startsWith('--targets=') || x.startsWith('--regions='));
    if (userTargets) {
      return { args: ['view', ...clean, '-'], regionAppliedClientSide: false, regionNote: 'region given and a -t/-r passed to bcftools; only the bcftools argument is applied here' };
    }
    return { args: ['view', '-t', region, ...clean, '-'], regionAppliedClientSide: true };
  }
  return {
    args: ['view', ...clean, '-'],
    regionAppliedClientSide: false,
    regionNote: region && tool === 'samtools'
      ? 'region forwarded to htsget only; samtools cannot filter an unindexed stream, so if the server returns the whole file every read is shown'
      : undefined,
  };
}

export async function pipeCommand(rawId: string, options: PipeOptions = {}): Promise<void> {
  try {
    const aliasId = resolveAlias(rawId);
    if (!options.viaHtsget && nodeRegionEligible(aliasId, options.region)) {
      // The region is cut by biofs-node with the index beside the file (GET /agent/region_read): only that region's reads or records cross the network.
      const tool = options.tool ?? detectTool(aliasId) ?? 'bcftools';
      if (tool === 'seqkit') throw new Error('a region read serves BAM and VCF files, not FASTQ');
      requireTool(tool, installHint(tool));
      const built = buildPipeArgs(tool, options.extra || [], tool === 'bcftools' ? options.region : undefined);
      if (!options.quiet) process.stderr.write(`pipe: region ${options.region} cut by biofs-node with the index beside the file${tool === 'bcftools' ? ' (and kept by bcftools view -t)' : ''}\n`);
      const code = await pipeNodeRegionToCommand(aliasId, options.region as string, tool, built.args, { quiet: options.quiet, label: `pipe → ${tool} ${built.args.slice(0, 4).join(' ')}` });
      process.exit(code);
    }
    if (!options.viaHtsget && !options.annotated && nodeWholeEligible(aliasId, options.region)) {
      // No region: biofs-node streams the exact bytes of the owner's own registered BAM, VCF or BCF (owner and consent checked there). A biocid the node does not hold (404)
      // or a format it does not serve (415, FASTQ) keeps the htsget path below.
      const opened = await tryOpenNodeWhole(aliasId);
      if (opened) {
        const wholeTool = options.tool ?? detectTool(aliasId) ?? (opened.format === 'BAM' ? 'samtools' : 'bcftools');
        requireTool(wholeTool, installHint(wholeTool));
        const wholeArgs = buildPipeArgs(wholeTool, options.extra || [], undefined).args;
        const wholeCode = await pipeNodeRegionToCommand(aliasId, undefined, wholeTool, wholeArgs, { quiet: options.quiet, label: `pipe → ${wholeTool} ${wholeArgs.slice(0, 4).join(' ')}`, opened });
        process.exit(wholeCode);
      }
    }
    const resolved = await resolveTele(rawId, {
      kind: options.kind,
      quiet: options.quiet,
      htsgetUrl: options.htsgetUrl,
      region: options.region,
      annotated: options.annotated,
    });

    const tool =
      options.tool ??
      detectTool(resolved.filenameHint) ??
      detectTool(resolved.cleanId) ??
      (resolved.layer === 'reads' ? 'samtools' : resolved.layer === 'sequences' ? 'seqkit' : 'bcftools');

    if (tool === 'bcftools') requireTool('bcftools', installHint('bcftools'));
    if (tool === 'samtools') requireTool('samtools', installHint('samtools'));
    if (tool === 'seqkit') requireTool('seqkit', installHint('seqkit'));

    const built = buildPipeArgs(tool, options.extra || [], options.region);
    const args = built.args;
    if (built.regionAppliedClientSide && !options.quiet) {
      process.stderr.write(`pipe: region ${options.region} applied by bcftools view -t on the stream (streaming targets filter)\n`);
    } else if (built.regionNote) {
      process.stderr.write(`pipe: WARNING ${built.regionNote}\n`);
    }

    const code = await telePipe(rawId, tool, args, {
      kind: options.kind || resolved.kind,
      quiet: options.quiet,
      htsgetUrl: options.htsgetUrl,
      region: options.region,
      annotated: options.annotated,
      label: `pipe → ${tool} ${args.slice(0, 4).join(' ')} ← ${resolved.cleanId}`,
    });
    process.exit(code);
  } catch (e: any) {
    Logger.error(e?.message || String(e));
    process.exit(6);
  }
}
