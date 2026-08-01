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

export interface PipeOptions extends TeleCommonOpts {
  extra?: string[];
  tool?: 'bcftools' | 'samtools' | 'seqkit';
  quiet?: boolean;
  htsgetUrl?: string;
  region?: string;
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

export async function pipeCommand(rawId: string, options: PipeOptions = {}): Promise<void> {
  try {
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

    const extra = (options.extra || []).filter((x) => x !== '--');
    let args: string[];
    if (tool === 'seqkit') {
      args = extra.length ? extra : ['stats'];
      if (!args.includes('-') && args[0] !== 'stats') {
        /* leave as-is */
      }
      if (args[0] === 'stats' || !extra.length) {
        args = ['stats', '-'];
      } else if (!args.includes('-')) {
        args = [...args, '-'];
      }
    } else {
      args = ['view', ...extra, '-'];
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
