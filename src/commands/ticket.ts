import chalk from 'chalk';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface TicketOptions {
  list?: boolean;
  revoke?: string;
  json?: boolean;
  verbose?: boolean;
}

function formatExpiry(isoOrEpoch: string | number): string {
  const d = typeof isoOrEpoch === 'number' ? new Date(isoOrEpoch * 1000) : new Date(isoOrEpoch);
  const now = Date.now();
  const remaining = d.getTime() - now;
  if (remaining <= 0) return chalk.red('EXPIRED');
  const mins = Math.floor(remaining / 60000);
  return `${mins}m remaining`;
}

export async function ticketCommand(options: TicketOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const apiBase = CONFIG.API_BASE_URL;
  const axios = (await import('axios')).default;

  if (options.revoke) {
    await revokeTicket(axios, apiBase, creds, options);
    return;
  }

  // Default: list active tickets
  await listTickets(axios, apiBase, creds, options);
}

async function listTickets(axios: any, apiBase: string, creds: any, options: TicketOptions): Promise<void> {
  if (!options.json) console.log(chalk.cyan('Fetching active privacy tickets...'));

  try {
    const resp = await axios.get(`${apiBase}/api_bioroutes/tickets`, {
      params: { wallet: creds.wallet_address, user_signature: creds.user_signature },
      timeout: 15000,
    });

    const tickets = resp.data?.tickets || [];

    if (options.json) {
      console.log(JSON.stringify({ tickets, count: tickets.length }, null, 2));
      return;
    }

    if (tickets.length === 0) {
      console.log(chalk.gray('  No active tickets.'));
      return;
    }

    console.log('');
    console.log(chalk.bold(`  Privacy Tickets (${tickets.length})`));
    console.log(chalk.gray('─'.repeat(60)));

    for (const t of tickets) {
      const statusColor = t.status === 'ACTIVE' ? chalk.green : t.status === 'EXPIRED' ? chalk.red : chalk.yellow;
      console.log(`  ${chalk.bold(t.ticket_id)}`);
      console.log(`    Status:     ${statusColor(t.status)}`);
      console.log(`    Scope:      ${t.scope?.join(', ') || 'all'}`);
      console.log(`    Requester:  ${t.requester_wallet?.slice(0, 10)}...`);
      console.log(`    Expires:    ${formatExpiry(t.expires_at)}`);
      console.log(`    Uses:       ${t.usage_count || 0}/${t.max_resolutions || 1}`);
      console.log('');
    }
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'tickets_unreachable', message: err.message }));
    } else {
      Logger.error(`Cannot fetch tickets: ${err.message}`);
      console.log(chalk.gray('  The /api_bioroutes/tickets endpoint may not be deployed yet.'));
    }
    process.exit(1);
  }
}

async function revokeTicket(axios: any, apiBase: string, creds: any, options: TicketOptions): Promise<void> {
  const ticketId = options.revoke!;
  if (!options.json) console.log(chalk.cyan(`Revoking ticket: ${ticketId}...`));

  try {
    const resp = await axios.post(`${apiBase}/api_bioroutes/tickets/revoke`, {
      ticket_id: ticketId,
      wallet: creds.wallet_address,
      user_signature: creds.user_signature,
    }, { timeout: 15000 });

    if (options.json) {
      console.log(JSON.stringify({ revoked: true, ticket_id: ticketId, ...resp.data }, null, 2));
    } else {
      console.log(chalk.green(`  Ticket revoked: ${ticketId}`));
      if (resp.data?.credentials_token_id) {
        console.log(chalk.gray(`  BioNFTCredentials token burned on-chain (tokenId: ${resp.data.credentials_token_id})`));
      }
    }
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ revoked: false, error: err.message }));
    } else {
      Logger.error(`Revocation failed: ${err.message}`);
      if (err.response?.status === 404) {
        console.log(chalk.gray('  Ticket not found or already revoked.'));
      }
    }
    process.exit(1);
  }
}
