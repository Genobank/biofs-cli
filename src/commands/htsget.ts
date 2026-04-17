/**
 * `biofs htsget` — low-level GA4GH htsget operations.
 *
 *   biofs htsget service-info             # show endpoint metadata
 *   biofs htsget ticket variants|reads <id>   # fetch raw ticket JSON
 *
 * For day-to-day use, prefer `biofs stream` or `biofs view` which hide the
 * ticket dance. This command is here for debugging + scripting.
 */
import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { resolveAlias } from '../lib/aliases/store';
import { getServiceInfo, getTicket, HtsgetKind } from '../lib/htsget/client';

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
  opts: { json?: boolean } = {},
): Promise<void> {
  const id = resolveAlias(rawId);
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(3);
  }
  const ticket = await getTicket(kind, id, creds.user_signature);
  process.stdout.write(JSON.stringify({ htsget: ticket }, null, 2) + '\n');
}
