/**
 * `biofs stream <id>` — stream a BioNFT-gated VCF/BAM to stdout via htsget.
 *
 * Pipes cleanly into bcftools/samtools/pysam:
 *
 *   biofs stream 0xCCe… | bcftools stats -
 *   biofs stream my-wes | bcftools view -H -
 *
 * Auto-detects 'variants' vs 'reads' from the registered filename; override
 * with --kind.
 */
import { spawnSync } from 'child_process';
import { CredentialsManager } from '../lib/auth/credentials';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import { resolveAlias } from '../lib/aliases/store';
import { getTicket, guessKindFromFilename, HtsgetKind } from '../lib/htsget/client';

export interface StreamOptions {
  kind?: HtsgetKind;
  quiet?: boolean;
  apiUrl?: string;
  htsgetUrl?: string;
}

export async function streamCommand(rawId: string, options: StreamOptions = {}): Promise<void> {
  const id = resolveAlias(rawId);

  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(3);
  }

  // Figure out the kind: user override > filename extension
  let kind: HtsgetKind = options.kind ?? 'variants';
  if (!options.kind) {
    try {
      const api = GenoBankAPIClient.getInstance();
      const bioips = await api.getMyGrantedBioIPs();
      const match = bioips.find((b: any) => (b.ip_id || '').toLowerCase() === id.toLowerCase());
      if (match?.filename) {
        kind = guessKindFromFilename(match.filename);
      }
    } catch {
      // fall through with default
    }
  }

  const ticket = await getTicket(kind, id, creds.user_signature, {
    baseUrl: options.htsgetUrl,
  });

  if (!options.quiet) {
    Logger.info(`htsget ticket: format=${ticket.format} urls=${ticket.urls.length}`);
  }

  // Stream each URL into stdout in order (curl is on every bio platform).
  for (const u of ticket.urls) {
    const result = spawnSync(
      'curl',
      ['-sSL', '--fail-with-body', '-A', 'biofs/2.7.0 (+https://genobank.io)', u.url],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (result.status !== 0) {
      Logger.error(`stream failed: curl exit ${result.status}`);
      process.exit(result.status ?? 6);
    }
  }
}
