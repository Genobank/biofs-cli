/** `biofs cred status <cred_id>` — show server-side state of a credential. */
import chalk from 'chalk';
import { apiGet } from './lib';

export interface CredStatusOptions {
  json?: boolean;
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  issued: chalk.blue,
  consumed: chalk.green,
  quarantined: chalk.red,
  burned: chalk.gray,
  failed: chalk.red,
};

export async function credStatusCommand(credId: string, options: CredStatusOptions): Promise<void> {
  const data = await apiGet('/api_biovault/credential_status', { cred_id: credId });
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const statusColor = STATUS_COLORS[data.status] || chalk.white;
  console.log(chalk.cyan('═'.repeat(66)));
  console.log(chalk.bold(`  Credential ${credId}`));
  console.log(chalk.cyan('═'.repeat(66)));
  const row = (k: string, v: any) => console.log(chalk.gray(`  ${k.padEnd(32)}`), v);
  row('status', statusColor(data.status || 'unknown'));
  row('owner_wallet', data.owner_wallet);
  row('biosample_id', data.biosample_id);
  row('laboratory_id', data.laboratory_id);
  row('file_kind', data.file_kind);
  row('object_path', data.object_path);
  row('bytes_uploaded', (data.bytes_uploaded || 0).toLocaleString());
  row('estimated_size_bytes', (data.estimated_size_bytes || 0).toLocaleString());
  row('verified', data.verified === null ? chalk.gray('pending') : data.verified ? chalk.green('yes') : chalk.red('mismatch'));
  row('created_at', data.created_at);
  row('consumed_at', data.consumed_at || chalk.gray('not yet'));
  console.log(chalk.cyan('═'.repeat(66)));
}
