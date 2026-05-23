/**
 * `biofs cred list` — list all credentials issued against the caller's biosamples.
 *
 * Uses the existing wallet signature to identify the caller. Server-side this
 * lists the write_credentials collection filtered by owner_wallet (matches the
 * caller's wallet recovered from user_signature).
 *
 * This exposes a debug endpoint we haven't wired yet — for v1, we suggest
 * `biofs cred status <id>` if the caller knows their cred_id. A list endpoint
 * is planned but out of scope for this patch.
 */
import chalk from 'chalk';
import Table from 'cli-table3';
import { apiGet } from './lib';

export interface CredListOptions {
  biosample?: string;
  status?: string;
  json?: boolean;
}

export async function credListCommand(options: CredListOptions): Promise<void> {
  // Current API exposes status lookup by cred_id; a fleet-list endpoint is a
  // follow-up (see plan A.7 follow-ups). For now, tell the user clearly.
  if (!options.biosample) {
    console.log(chalk.yellow('ℹ  biofs cred list currently requires --biosample <serial>.'));
    console.log(chalk.gray('   Fleet-wide listing endpoint is on the biovault roadmap.'));
    console.log(chalk.gray('   Workaround: log into the GenoBank dashboard → Credentials tab.'));
    return;
  }

  try {
    const data = await apiGet('/api_biovault/credentials_for_biosample', {
      biosample_serial: options.biosample,
      ...(options.status ? { status: options.status } : {}),
    });
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (!data?.credentials?.length) {
      console.log(chalk.gray(`no credentials for biosample ${options.biosample}`));
      return;
    }
    const t = new Table({ head: ['cred_id', 'status', 'kind', 'lab', 'bytes', 'created'] });
    for (const c of data.credentials) {
      t.push([
        c.cred_id?.substring(0, 20) + '…',
        c.status,
        c.file_kind,
        c.laboratory_id,
        (c.bytes_uploaded || 0).toLocaleString(),
        (c.created_at || '').substring(0, 19),
      ]);
    }
    console.log(t.toString());
  } catch (err: any) {
    if (err.status === 404) {
      console.log(chalk.yellow('ℹ /api_biovault/credentials_for_biosample not implemented yet (planned v2).'));
      console.log(chalk.gray(`  Use \`biofs cred status <cred_id>\` if you know the id.`));
      return;
    }
    throw err;
  }
}
