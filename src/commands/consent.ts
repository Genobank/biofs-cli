/**
 * biofs consent payload | submit
 *
 * The subject-signed consent flow for an AI-agent session, dispatched through biofs-node.
 *
 * Why two steps rather than one. biofs-node CANNOT mint this consent for you. The
 * signature it holds from login is over a fixed string and says nothing about this
 * particular grant, so it proves key possession and not assent. The ConsentGrant contract
 * demands an EIP-712 signature by the SUBJECT over the exact grant terms, which is what
 * stops an operator, a laboratory, or this CLI from creating consent about a person
 * rather than by them. So: the node builds the terms, the data owner signs them in their
 * own wallet, and the node relays the signed grant and pays the gas. The owner never has
 * to hold a volatile token to consent, or to withdraw.
 *
 * What the grant expresses that a normal access token cannot: the AI tool is a separate,
 * separately revocable principal. Cutting off the tool leaves the human's own access
 * intact, and cutting off the human cascades to everything delegated from it.
 */
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import fs from 'fs';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface ConsentOptions { json?: boolean; quiet?: boolean; days?: string; }

/** biofs consent payload --session <id> --biocid <biocid> [--days N] */
export async function consentPayloadCommand(
  session: string, biocid: string, options: ConsentOptions = {}
): Promise<void> {
  const creds = await getCredentials();
  if (!creds) { Logger.error('Not logged in. Run: biofs login'); process.exit(1); }
  if (!biocid || !biocid.startsWith('biocid://')) {
    Logger.error('A biocid:// is required. Biodata is addressed by biocid, never by a storage path.');
    process.exit(1);
  }

  const spinner = options.quiet || options.json ? null : ora('Building consent terms...').start();
  const url = `${BIOFS_NODE_BASE}/consent_session_payload`
    + `?session=${encodeURIComponent(session)}&biocid=${encodeURIComponent(biocid)}`
    + `&days=${encodeURIComponent(options.days || '1')}`
    + `&wallet=${encodeURIComponent(creds.wallet_address)}&signature=${encodeURIComponent(creds.user_signature)}`;

  const r = await axios.get(url, { validateStatus: (s) => s < 500 });
  if (r.status !== 200 || r.data?.error) {
    spinner?.fail('Could not build consent terms');
    Logger.error(r.data?.error || `HTTP ${r.status}`);
    process.exit(1);
  }
  spinner?.succeed('Consent terms ready');

  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }

  const h = r.data.human_readable || {};
  console.log('');
  console.log(chalk.bold('  You would be granting'));
  console.log(`    ${chalk.cyan(h.you_are_granting || '(unspecified)')}`);
  console.log(`    to            ${h.to}`);
  console.log(`    through       ${chalk.yellow(h.through_ai_tool || 'an AI assistant')}`);
  console.log(`    session       ${h.session}`);
  console.log(`    expires in    ${h.expires_in_days} day(s)`);
  console.log(`    ${chalk.green(h.revocable || '')}`);
  console.log('');
  console.log(chalk.gray('  Sign the typed data below with the data owner\'s wallet, then:'));
  console.log(chalk.gray(`    biofs consent submit --session ${h.session} --message <file.json> --signature 0x...`));
  console.log('');
  console.log(JSON.stringify(r.data.typedData, null, 2));
}

/** biofs consent submit --session <id> --message <json|@file> --signature 0x... */
export async function consentSubmitCommand(
  session: string, message: string, signature: string, options: ConsentOptions = {}
): Promise<void> {
  const creds = await getCredentials();
  if (!creds) { Logger.error('Not logged in. Run: biofs login'); process.exit(1); }

  let msg: any;
  try {
    const raw = message.startsWith('@') || fs.existsSync(message)
      ? fs.readFileSync(message.replace(/^@/, ''), 'utf8') : message;
    msg = JSON.parse(raw);
    if (msg.typedData?.message) msg = msg.typedData.message;   // accept the whole payload
  } catch (e) {
    Logger.error(`--message must be JSON or a path to it: ${e}`);
    process.exit(1);
  }

  const spinner = options.quiet || options.json ? null : ora('Relaying signed consent on-chain...').start();
  const r = await axios.post(`${BIOFS_NODE_BASE}/consent_session_submit`,
    { session, message: msg, signature, wallet: creds.wallet_address, signature_auth: creds.user_signature },
    { validateStatus: (s) => s < 500 });

  if (r.status !== 200 || r.data?.error) {
    spinner?.fail('Consent grant refused');
    Logger.error(r.data?.error || `HTTP ${r.status}`);
    process.exit(1);
  }
  spinner?.succeed('Consent granted on-chain');

  if (options.json) { console.log(JSON.stringify(r.data, null, 2)); return; }
  console.log('');
  console.log(`  ${chalk.bold('grant id')}  ${r.data.grant_id}`);
  console.log(`  ${chalk.bold('tx')}        ${r.data.tx}`);
  console.log(`  ${chalk.bold('block')}     ${r.data.block}`);
  console.log('');
  console.log(chalk.gray(`  ${r.data.note || ''}`));
}
