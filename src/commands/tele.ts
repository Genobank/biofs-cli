/**
 * `biofs tele` — TeleBioinformatics command family.
 *
 * Consent-gated vault bytes (htsget) piped into local bioinformatics tools
 * without downloading full objects to the researcher's disk.
 *
 *   biofs tele tools
 *   biofs tele stats   <id>
 *   biofs tele header  <id>
 *   biofs tele flagstat <id>
 *   biofs tele count   <id>
 *   biofs tele region  <id> <chr:start-end>
 *   biofs tele query   <id> -- -f '%CHROM\t%POS\t%REF\t%ALT\n'
 *   biofs tele filter  <id> -- -i 'QUAL>30'
 *   biofs tele view    <id> -- -H
 *   biofs tele seqkit  <id>
 *   biofs tele seqtk   <id> -- sample 1000
 *   biofs tele bedtools <id> -- intersect -b genes.bed
 *   biofs tele vt      <id> -- normalize -r ref.fa
 *   biofs tele igv     <id> [--web] [--out session.html]
 *   biofs tele jupyter <id>
 *   biofs tele pysam   <id>
 *   biofs tele mosdepth <id>   (best-effort; may need fuse)
 *
 * Tier C (annotate, DeepVariant) stays on biofs-node — see `biofs tele tools`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { Logger } from '../lib/utils/logger';
import {
  TOOL_CATALOG,
  TeleCommonOpts,
  resolveTele,
  primaryUrl,
  telePipe,
  teleStreamStdout,
  requireTool,
  installHint,
  isQuiet,
  which,
  parseGenomicRegion,
} from '../lib/tele/core';

export interface TeleCommonCli extends TeleCommonOpts {
  json?: boolean;
  web?: boolean;
  out?: string;
  open?: boolean;
  format?: string;
  include?: string;
  exclude?: string;
  tool?: string;
  htsgetUrl?: string;
  kind?: 'variants' | 'reads';
  region?: string;
  annotated?: boolean;
  quiet?: boolean;
  raw?: boolean;
  referenceName?: string;
  start?: number;
  end?: number;
}

function commonFrom(opts: TeleCommonCli): TeleCommonOpts {
  return {
    kind: opts.kind as any,
    quiet: opts.quiet,
    htsgetUrl: opts.htsgetUrl,
    annotated: opts.annotated,
    region: opts.region,
    referenceName: opts.referenceName,
    start: opts.start,
    end: opts.end,
    raw: opts.raw,
  };
}

function exitCode(code: number): never {
  process.exit(code);
}

// ---------------------------------------------------------------------------
// tools / catalog
// ---------------------------------------------------------------------------
export async function teleToolsCommand(opts: { json?: boolean } = {}): Promise<void> {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ tools: TOOL_CATALOG }, null, 2) + '\n');
    return;
  }
  process.stderr.write('TeleBioinformatics tool catalog (Tier A=stream, B=fuse/url, C=server skill)\n\n');
  const hdr = `${'id'.padEnd(28)} ${'tier'.padEnd(4)} ${'layer'.padEnd(10)} ${'tele'.padEnd(22)} tools`;
  process.stderr.write(hdr + '\n');
  process.stderr.write(`${'-'.repeat(hdr.length)}\n`);
  for (const t of TOOL_CATALOG) {
    const line = `${t.id.padEnd(28)} ${t.tier.padEnd(4)} ${String(t.layer).padEnd(10)} ${(t.tele || '').padEnd(22)} ${(t.tools || []).join(',') || '—'}`;
    process.stderr.write(line + '\n');
    process.stderr.write(`  ${t.note}\n`);
  }
  process.stderr.write(
    '\nExamples:\n' +
      '  biofs tele stats 41221040804032.deepvariant.agilent_v8.vcf\n' +
      '  biofs tele flagstat 41221040804032.deepvariant.hg38.bam\n' +
      '  biofs tele region SAMPLE.vcf chr17:7661779-7687538\n' +
      '  biofs tele igv SAMPLE.bam --web --open\n' +
      '  biofs stream SAMPLE.vcf | bcftools stats -\n',
  );
}

// ---------------------------------------------------------------------------
// stats — bcftools stats | samtools stats
// ---------------------------------------------------------------------------
export async function teleStatsCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  if (resolved.layer === 'reads') {
    requireTool('samtools', installHint('samtools'));
    const code = await telePipe(id, 'samtools', ['stats', '-'], {
      ...commonFrom(opts),
      label: `tele stats (samtools) ← ${resolved.cleanId}`,
    });
    exitCode(code);
  }
  if (resolved.layer === 'sequences') {
    return teleSeqkitCommand(id, opts);
  }
  requireTool('bcftools', installHint('bcftools'));
  const code = await telePipe(id, 'bcftools', ['stats', '-'], {
    ...commonFrom(opts),
    label: `tele stats (bcftools) ← ${resolved.cleanId}`,
  });
  exitCode(code);
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------
export async function teleHeaderCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  if (resolved.layer === 'reads') {
    requireTool('samtools', installHint('samtools'));
    const code = await telePipe(id, 'samtools', ['view', '-H', '-'], {
      ...commonFrom(opts),
      label: `tele header (samtools -H) ← ${resolved.cleanId}`,
    });
    exitCode(code);
  }
  requireTool('bcftools', installHint('bcftools'));
  const code = await telePipe(id, 'bcftools', ['view', '-h', '-'], {
    ...commonFrom(opts),
    label: `tele header (bcftools -h) ← ${resolved.cleanId}`,
  });
  exitCode(code);
}

// ---------------------------------------------------------------------------
// flagstat
// ---------------------------------------------------------------------------
export async function teleFlagstatCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  requireTool('samtools', installHint('samtools'));
  const code = await telePipe(id, 'samtools', ['flagstat', '-'], {
    ...commonFrom(opts),
    kind: opts.kind || 'reads',
    label: `tele flagstat ← ${id}`,
  });
  exitCode(code);
}

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------
export async function teleCountCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  if (resolved.layer === 'reads') {
    requireTool('samtools', installHint('samtools'));
    const code = await telePipe(id, 'samtools', ['view', '-c', '-'], {
      ...commonFrom(opts),
      label: `tele count (samtools -c) ← ${resolved.cleanId}`,
    });
    exitCode(code);
  }
  // variants: count data lines via bcftools view -H | wc -l using a small shell
  requireTool('bcftools', installHint('bcftools'));
  const url = primaryUrl(resolved.ticket);
  if (!isQuiet(opts)) {
    process.stderr.write(`tele count (variant records) ← ${resolved.cleanId}\n`);
  }
  const r = spawnSync(
    'bash',
    [
      '-c',
      `curl -sSL --fail-with-body -A 'biofs/3.18.0' ${shellQuote(url)} | bcftools view -H - | wc -l`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  exitCode(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// region
// ---------------------------------------------------------------------------
export async function teleRegionCommand(
  id: string,
  region: string,
  opts: TeleCommonCli = {},
): Promise<void> {
  const parsed = parseGenomicRegion(region);
  if (!parsed) {
    throw new Error(`invalid region '${region}' (expected chr17 or chr17:start-end)`);
  }
  const resolved = await resolveTele(id, { ...commonFrom(opts), region });
  if (resolved.layer === 'reads') {
    requireTool('samtools', installHint('samtools'));
    // Stdin BAM cannot use index-based -r; rely on htsget region params + full filter note.
    process.stderr.write(
      'note: BAM region filter over stdin is linear (no BAI). Prefer server htsget slice when available; for random access use biofs fuse.\n',
    );
    const code = await telePipe(id, 'samtools', ['view', '-', region], {
      ...commonFrom(opts),
      region,
      label: `tele region (samtools) ${region} ← ${resolved.cleanId}`,
    });
    exitCode(code);
  }
  // Plain (non-bgzip) VCF on stdin often rejects `bcftools view -r` with
  // "not compressed with bgzip". Use a linear stream-safe filter instead.
  requireTool('bcftools', installHint('bcftools'));
  const chrom = parsed.referenceName;
  const start1 = parsed.start !== undefined ? parsed.start + 1 : 1;
  const end1 = parsed.end !== undefined ? parsed.end : 2147483647;
  const url = primaryUrl(resolved.ticket);
  if (!isQuiet(opts)) {
    process.stderr.write(
      `tele region (stream filter ${chrom}:${start1}-${end1}) ← ${resolved.cleanId}\n`,
    );
  }
  // Env-based awk avoids nested quoting hell across shells.
  const r = spawnSync(
    'bash',
    [
      '-c',
      `curl -sSL --fail-with-body -A 'biofs/3.18.0' "$TELE_URL" | bcftools view - | awk 'BEGIN{c=ENVIRON["TELE_CHR"];s=ENVIRON["TELE_START"]+0;e=ENVIRON["TELE_END"]+0} /^#/{print;next} $1==c && $2>=s && $2<=e {print}'`,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        TELE_URL: url,
        TELE_CHR: chrom,
        TELE_START: String(start1),
        TELE_END: String(end1),
      },
    },
  );
  exitCode(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// query / filter / view — pass-through
// ---------------------------------------------------------------------------
export async function teleQueryCommand(
  id: string,
  extra: string[],
  opts: TeleCommonCli = {},
): Promise<void> {
  requireTool('bcftools', installHint('bcftools'));
  const fmt = opts.format || extra.find((_, i, a) => a[i - 1] === '-f') || '%CHROM\t%POS\t%REF\t%ALT\n';
  const args = ['query'];
  if (opts.format) {
    args.push('-f', opts.format);
  } else if (!extra.includes('-f')) {
    args.push('-f', fmt);
  }
  args.push(...extra.filter((x) => x !== '--'), '-');
  const code = await telePipe(id, 'bcftools', args, {
    ...commonFrom(opts),
    label: `tele query ← ${id}`,
  });
  exitCode(code);
}

export async function teleFilterCommand(
  id: string,
  extra: string[],
  opts: TeleCommonCli = {},
): Promise<void> {
  requireTool('bcftools', installHint('bcftools'));
  const args = ['view'];
  if (opts.include) args.push('-i', opts.include);
  if (opts.exclude) args.push('-e', opts.exclude);
  args.push(...extra.filter((x) => x !== '--'), '-');
  const code = await telePipe(id, 'bcftools', args, {
    ...commonFrom(opts),
    label: `tele filter ← ${id}`,
  });
  exitCode(code);
}

export async function teleViewCommand(
  id: string,
  extra: string[],
  opts: TeleCommonCli = {},
): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  if (resolved.layer === 'reads') {
    requireTool('samtools', installHint('samtools'));
    const code = await telePipe(id, 'samtools', ['view', ...extra.filter((x) => x !== '--'), '-'], {
      ...commonFrom(opts),
      label: `tele view (samtools) ← ${resolved.cleanId}`,
    });
    exitCode(code);
  }
  requireTool('bcftools', installHint('bcftools'));
  const code = await telePipe(id, 'bcftools', ['view', ...extra.filter((x) => x !== '--'), '-'], {
    ...commonFrom(opts),
    label: `tele view (bcftools) ← ${resolved.cleanId}`,
  });
  exitCode(code);
}

// ---------------------------------------------------------------------------
// seqkit / seqtk / bedtools / vt / mosdepth
// ---------------------------------------------------------------------------
export async function teleSeqkitCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  requireTool('seqkit', installHint('seqkit'));
  const code = await telePipe(id, 'seqkit', ['stats', '-'], {
    ...commonFrom(opts),
    kind: opts.kind || 'reads',
    label: `tele seqkit stats ← ${id}`,
  });
  exitCode(code);
}

export async function teleSeqtkCommand(
  id: string,
  extra: string[],
  opts: TeleCommonCli = {},
): Promise<void> {
  requireTool('seqtk', installHint('seqtk'));
  const sub = extra.length ? extra : ['seq', '-A'];
  const code = await telePipe(id, 'seqtk', [...sub.filter((x) => x !== '--'), '-'], {
    ...commonFrom(opts),
    kind: opts.kind || 'reads',
    label: `tele seqtk ← ${id}`,
  });
  exitCode(code);
}

export async function teleBedtoolsCommand(
  id: string,
  extra: string[],
  opts: TeleCommonCli = {},
): Promise<void> {
  requireTool('bedtools', installHint('bedtools'));
  if (!extra.length) {
    throw new Error('tele bedtools requires args after -- (e.g. -- intersect -b genes.bed -wa)');
  }
  // bedtools often wants -a stdin
  const args = [...extra.filter((x) => x !== '--')];
  if (!args.includes('-a') && !args.includes('stdin')) {
    // inject -a stdin after subcommand when missing
    if (args[0] && !args[0].startsWith('-')) {
      args.splice(1, 0, '-a', 'stdin');
    }
  }
  const code = await telePipe(id, 'bedtools', args, {
    ...commonFrom(opts),
    label: `tele bedtools ← ${id}`,
  });
  exitCode(code);
}

export async function teleVtCommand(
  id: string,
  extra: string[],
  opts: TeleCommonCli = {},
): Promise<void> {
  requireTool('vt', installHint('vt'));
  const args = extra.length ? extra.filter((x) => x !== '--') : ['view', '-'];
  // ensure trailing - for stdin when missing
  if (!args.includes('-')) args.push('-');
  const code = await telePipe(id, 'vt', args, {
    ...commonFrom(opts),
    label: `tele vt ← ${id}`,
  });
  exitCode(code);
}

export async function teleMosdepthCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  requireTool('mosdepth', installHint('mosdepth'));
  process.stderr.write(
    'note: mosdepth works best with an indexed local BAM (biofs fuse). Streaming is best-effort.\n',
  );
  const outPrefix = opts.out || path.join(os.tmpdir(), `biofs-mosdepth-${Date.now()}`);
  // mosdepth cannot read plain stdin BAM easily; materialize to temp via stream
  const resolved = await resolveTele(id, { ...commonFrom(opts), kind: opts.kind || 'reads' });
  const tmpBam = `${outPrefix}.stream.bam`;
  const curl = spawnSync(
    'curl',
    ['-sSL', '--fail-with-body', '-A', 'biofs/3.18.0', primaryUrl(resolved.ticket), '-o', tmpBam],
    { stdio: 'inherit' },
  );
  if (curl.status !== 0) throw new Error('failed to materialize BAM for mosdepth');
  const r = spawnSync('mosdepth', [outPrefix, tmpBam], { stdio: 'inherit' });
  try {
    fs.unlinkSync(tmpBam);
  } catch {
    /* ignore */
  }
  exitCode(r.status ?? 1);
}

// ---------------------------------------------------------------------------
// igv — desktop batch + optional IGV.js HTML
// ---------------------------------------------------------------------------
export async function teleIgvCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  const url = primaryUrl(resolved.ticket);
  const fmt = (resolved.ticket.format || '').toUpperCase();
  const isBam = fmt === 'BAM' || fmt === 'CRAM' || resolved.layer === 'reads';

  const outDir = opts.out
    ? path.dirname(path.resolve(opts.out))
    : path.join(os.homedir(), '.biofs', 'tele');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `igv-${resolved.cleanId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)}`);
  const batchPath = `${base}.igv.txt`;
  const htmlPath = opts.out?.endsWith('.html') ? path.resolve(opts.out) : `${base}.html`;

  const batch = [
    'new',
    'genome hg38',
    `load ${url}`,
    resolved.regionQuery.referenceName
      ? `goto ${resolved.regionQuery.referenceName}:${
          // display 1-based if we have start
          resolved.regionQuery.start !== undefined
            ? Number(resolved.regionQuery.start) + 1
            : 1
        }${
          resolved.regionQuery.end !== undefined ? '-' + resolved.regionQuery.end : ''
        }`
      : '# goto chr1:1-100000',
    '',
  ].join('\n');
  fs.writeFileSync(batchPath, batch, 'utf8');

  const html = buildIgvJsHtml({
    title: `TeleBioinformatics — ${resolved.cleanId}`,
    url,
    format: isBam ? 'bam' : 'vcf',
    locus: opts.region || 'chr1:1-100000',
  });
  fs.writeFileSync(htmlPath, html, 'utf8');

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          id: resolved.cleanId,
          format: resolved.ticket.format,
          stream_url: url,
          batch: batchPath,
          web: htmlPath,
          note: 'Stream URL embeds user_signature; treat as a secret capability until expiry.',
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(`IGV desktop batch: ${batchPath}\n`);
    process.stderr.write(`IGV.js session:    ${htmlPath}\n`);
    process.stderr.write(`Stream URL (secret): ${url.slice(0, 80)}…\n`);
    process.stderr.write(
      'Open HTML in a browser, or: igv.sh -b ' + batchPath + '\n',
    );
  }

  if (opts.web || opts.open) {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawnSync(opener, [htmlPath], { stdio: 'ignore' });
  }
}

function buildIgvJsHtml(opts: {
  title: string;
  url: string;
  format: string;
  locus: string;
}): string {
  const trackType = opts.format === 'bam' ? 'alignment' : 'variant';
  const format = opts.format === 'bam' ? 'bam' : 'vcf';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(opts.title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/igv@2.15.5/dist/igv.min.css"/>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #fff; color: #000; }
    header { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
    h1 { font-size: 1.1rem; margin: 0 0 4px; }
    p { margin: 0; font-size: 0.85rem; color: #111; }
    #igv-div { width: 100%; }
    .warn { background: #fff7ed; border: 1px solid #fed7aa; padding: 8px 16px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>GenoBank.io TeleBioinformatics — consent-gated htsget stream in IGV.js</p>
  </header>
  <div class="warn">This page embeds a short-lived signed stream URL. Do not share the HTML file; revoke room access to cut off new tickets.</div>
  <div id="igv-div"></div>
  <script src="https://cdn.jsdelivr.net/npm/igv@2.15.5/dist/igv.min.js"></script>
  <script>
    igv.createBrowser(document.getElementById('igv-div'), {
      genome: 'hg38',
      locus: ${JSON.stringify(opts.locus)},
      tracks: [{
        name: ${JSON.stringify(opts.title)},
        type: ${JSON.stringify(trackType)},
        format: ${JSON.stringify(format)},
        url: ${JSON.stringify(opts.url)},
        order: 1
      }]
    }).catch(function(e) {
      document.getElementById('igv-div').innerHTML =
        '<p style="padding:16px">IGV.js failed to load track (CORS or format). Use the stream URL in IGV desktop, or biofs tele header / stats.</p><pre style="padding:16px;white-space:pre-wrap">' +
        String(e) + '</pre>';
    });
  </script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// jupyter / pysam snippets
// ---------------------------------------------------------------------------
export async function teleJupyterCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  const cell = `# TeleBioinformatics — GenoBank.io biofs
# Requires: pip install pysam   and local biofs CLI authenticated
# Layer: ${resolved.layer}  format: ${resolved.ticket.format}

import subprocess, sys

ID = ${JSON.stringify(resolved.id)}
# Stream consent-gated bytes into Python without writing the vault object to disk.
proc = subprocess.Popen(
    ["biofs", "stream", ID${opts.region ? `, "--region", ${JSON.stringify(opts.region)}` : ''}],
    stdout=subprocess.PIPE,
)

${
  resolved.layer === 'reads'
    ? `import pysam
bam = pysam.AlignmentFile(proc.stdout, "rb")
n = 0
for read in bam:
    n += 1
    if n <= 5:
        print(read.query_name, read.reference_name, read.reference_start)
print("reads_seen", n)
bam.close()`
    : `import sys
n_header = n_vars = 0
for line in proc.stdout:
    if line.startswith(b"#"):
        n_header += 1
        continue
    n_vars += 1
    if n_vars <= 5:
        print(line.decode().rstrip())
print("header_lines", n_header, "variant_lines", n_vars)`
}

proc.wait()
print("biofs_stream_exit", proc.returncode)
`;
  if (opts.out) {
    fs.writeFileSync(opts.out, cell, 'utf8');
    process.stderr.write(`wrote ${opts.out}\n`);
  } else {
    process.stdout.write(cell);
  }
}

export async function telePysamCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  return teleJupyterCommand(id, opts);
}

// ---------------------------------------------------------------------------
// raw stream shortcut
// ---------------------------------------------------------------------------
export async function teleStreamCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  await teleStreamStdout(id, commonFrom(opts));
}

// ---------------------------------------------------------------------------
// ticket (debug convenience under tele)
// ---------------------------------------------------------------------------
export async function teleTicketCommand(id: string, opts: TeleCommonCli = {}): Promise<void> {
  const resolved = await resolveTele(id, commonFrom(opts));
  process.stdout.write(
    JSON.stringify(
      {
        id: resolved.cleanId,
        kind: resolved.kind,
        layer: resolved.layer,
        format: resolved.ticket.format,
        region: resolved.regionQuery,
        htsget: resolved.ticket,
      },
      null,
      2,
    ) + '\n',
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
