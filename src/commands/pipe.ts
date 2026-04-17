/**
 * `biofs pipe <id> -- [tool args]` — pipe a BioIP stream into bcftools/samtools view.
 *
 * Auto-detects the right tool from the registered filename:
 *   .vcf/.vcf.gz/.bcf  → bcftools view
 *   .bam/.cram/.sam     → samtools view
 *
 * Any args after `--` pass through to the tool:
 *   biofs view my-wes -- -H -r chr17:1000000-2000000
 */
import { spawn } from 'child_process';
import { CredentialsManager } from '../lib/auth/credentials';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import { resolveAlias } from '../lib/aliases/store';
import { getTicket, guessKindFromFilename } from '../lib/htsget/client';

export interface PipeOptions {
  extra?: string[];
  tool?: 'bcftools' | 'samtools';
  quiet?: boolean;
  htsgetUrl?: string;
}

function detectTool(filename: string): 'bcftools' | 'samtools' | null {
  const f = filename.toLowerCase();
  if (f.endsWith('.vcf') || f.endsWith('.vcf.gz') || f.endsWith('.bcf')) return 'bcftools';
  if (f.endsWith('.bam') || f.endsWith('.cram') || f.endsWith('.sam')) return 'samtools';
  return null;
}

export async function pipeCommand(rawId: string, options: PipeOptions = {}): Promise<void> {
  const id = resolveAlias(rawId);

  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(3);
  }

  // Look up filename to pick the right tool
  const api = GenoBankAPIClient.getInstance();
  let filename: string | undefined;
  try {
    const bioips = await api.getMyGrantedBioIPs();
    const match = bioips.find((b: any) => (b.ip_id || '').toLowerCase() === id.toLowerCase());
    filename = match?.filename;
  } catch {
    // proceed with user override only
  }

  const tool = options.tool ?? (filename ? detectTool(filename) : null);
  if (!tool) {
    Logger.error(
      `no bioinformatics tool detected for ${filename ?? id} — pass --tool bcftools|samtools`,
    );
    process.exit(1);
  }

  const kind = filename ? guessKindFromFilename(filename) : 'variants';
  const ticket = await getTicket(kind, id, creds.user_signature, {
    baseUrl: options.htsgetUrl,
  });
  if (ticket.urls.length !== 1) {
    Logger.warn(
      `ticket has ${ticket.urls.length} URLs; view only pipes the first (multi-URL concat is streamCommand's job)`,
    );
  }
  const url = ticket.urls[0].url;

  if (!options.quiet) {
    Logger.info(`piping htsget (${ticket.format}) into ${tool} view …`);
  }

  // curl | tool view <extraArgs> -
  const curl = spawn(
    'curl',
    ['-sSL', '--fail-with-body', '-A', 'biofs/2.7.0 (+https://genobank.io)', url],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const toolArgs = ['view', ...(options.extra ?? []), '-'];
  const toolProc = spawn(tool, toolArgs, { stdio: [curl.stdout!, 'inherit', 'inherit'] });

  toolProc.on('exit', (code) => {
    process.exit(code ?? 0);
  });
  curl.on('exit', (code) => {
    if (code !== 0 && toolProc.exitCode === null) {
      Logger.error(`curl failed: exit ${code}`);
      toolProc.kill();
    }
  });
}
