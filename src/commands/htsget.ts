/**
 * `biofs htsget` — low-level GA4GH htsget operations.
 *
 *   biofs htsget service-info
 *   biofs htsget ticket variants|reads <id>
 *   biofs htsget ticket variants SAMPLE.vcf --region chr17:1-100000
 *
 * For day-to-day use, prefer `biofs stream`, `biofs tele`, or `biofs pipe`.
 */
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { resolveAlias } from '../lib/aliases/store';
import {
  getServiceInfo,
  getTicket,
  HtsgetKind,
  parseGenomicRegion,
  buildTicketRequestUrl,
} from '../lib/htsget/client';

export async function htsgetServiceInfoCommand(opts: { json?: boolean } = {}): Promise<void> {
  const info = await getServiceInfo();
  if (opts.json) {
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    return;
  }
  console.log(`htsget service: ${info.name}  (${info.version})`);
  console.log(`  id:           ${info.id}`);
  console.log(`  org:          ${info.organization?.name ?? ''}  ${info.organization?.url ?? ''}`);
  console.log(`  description:  ${info.description ?? ''}`);
  if (info.htsget) {
    console.log(`  datatypes:    ${(info.htsget.datatype ?? []).join(', ')}`);
    console.log(`  formats:      ${(info.htsget.formats ?? []).join(', ')}`);
  }
}

export async function htsgetTicketCommand(
  kind: HtsgetKind,
  rawId: string,
  opts: {
    json?: boolean;
    region?: string;
    referenceName?: string;
    start?: string | number;
    end?: string | number;
    annotated?: boolean;
    htsgetUrl?: string;
  } = {},
): Promise<void> {
  const id = resolveAlias(rawId);
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(3);
  }
  const query: Record<string, string | number | undefined> = {};
  if (opts.annotated) query.annotated = 'true';
  if (opts.region) {
    const p = parseGenomicRegion(opts.region);
    if (p) {
      query.referenceName = p.referenceName;
      if (p.start !== undefined) query.start = p.start;
      if (p.end !== undefined) query.end = p.end;
    }
  }
  if (opts.referenceName) query.referenceName = opts.referenceName;
  if (opts.start !== undefined && opts.start !== '') query.start = Number(opts.start);
  if (opts.end !== undefined && opts.end !== '') query.end = Number(opts.end);

  const ticket = await getTicket(kind, id, creds.user_signature, {
    baseUrl: opts.htsgetUrl,
    query,
  });
  process.stdout.write(
    JSON.stringify(
      {
        htsget: ticket,
        request: buildTicketRequestUrl(kind, id, { baseUrl: opts.htsgetUrl, query }),
      },
      null,
      2,
    ) + '\n',
  );
}
