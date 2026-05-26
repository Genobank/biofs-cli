/**
 * biofs inventory cohort — extract a filtered cohort of biosample serials.
 *
 * Wraps GET /api_bioroutes/inventory/cohort. Per CLAUDE.md "ALL jobs via
 * biofs-cli + biofs-node": this is the canonical way to ask the protocol
 * "give me the serials I should process next" (e.g. all AUGenomics FASTQ-only).
 *
 * Output formats:
 *   default: pretty list with header (serial-per-line on stdout for shell-pipe)
 *   --json:  full JSON {serials, n, filter, auth_role, scoped_lab}
 *
 * Example:
 *   biofs inventory cohort --originlab augenomics --has fastq --missing vcf,gvcf --paired
 *   biofs inventory cohort --originlab augenomics --has fastq --missing vcf --paired --output cohort.txt
 *
 * Then feed the file to:
 *   biofs cohort-pipeline --serials cohort.txt
 */

import * as fs from 'fs';
import chalk from 'chalk';
import axios from 'axios';
import { CredentialsManager } from '../../lib/auth/credentials';
import { CONFIG } from '../../lib/config/constants';
import { Logger } from '../../lib/utils/logger';

export interface InventoryCohortOptions {
  originlab?: string;
  has?: string;
  missing?: string;
  paired?: boolean;
  limit?: string;
  output?: string;
  json?: boolean;
}

export async function inventoryCohortCommand(opts: InventoryCohortOptions): Promise<void> {
  if (!opts.originlab) {
    Logger.error('--originlab is required (e.g. augenomics, neochromosome, somos, tecbase, genobank)');
    process.exit(1);
  }
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  const params: Record<string, string> = {
    wallet: creds.wallet_address,
    signature: creds.user_signature,
    originlab: opts.originlab,
  };
  if (opts.has) params.has_filetype = opts.has;
  if (opts.missing) params.missing_filetype = opts.missing;
  if (opts.paired) params.paired = 'true';
  if (opts.limit) params.limit = opts.limit;

  try {
    const url = `${CONFIG.API_BASE_URL}/api_bioroutes/inventory/cohort`;
    const resp = await axios.get(url, { params, timeout: 60_000, validateStatus: (s: number) => s < 500 });

    if (resp.status === 403) {
      Logger.error(`Cohort query denied: ${resp.data?.error || 'unauthorized'}`);
      console.log(chalk.gray('  Only bioroutes admins or lab custodians scoped to this lab can query cohort.'));
      process.exit(1);
    }
    if (resp.status >= 400) {
      Logger.error(`Cohort query failed (HTTP ${resp.status}): ${resp.data?.error || 'unknown'}`);
      process.exit(1);
    }

    const d = resp.data;

    if (opts.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    if (opts.output) {
      fs.writeFileSync(opts.output, d.serials.join('\n') + '\n');
      console.error(chalk.green(`✓ Wrote ${d.n} serials to ${opts.output}`));
      console.error(chalk.gray(`  filter: originlab=${opts.originlab} has=${opts.has||'(any)'} missing=${opts.missing||'(none)'} paired=${!!opts.paired}`));
      console.error(chalk.gray(`  next:   biofs cohort-pipeline --serials ${opts.output}`));
      return;
    }

    // Default: print summary to stderr, serials to stdout (so it pipes cleanly)
    console.error(chalk.bold(`\nBioRoutes Cohort  (${d.auth_role}${d.scoped_lab ? `, lab=${d.scoped_lab}` : ''})`));
    console.error(chalk.gray('─'.repeat(60)));
    console.error(`  originlab:        ${chalk.white(d.filter.originlab)}`);
    console.error(`  has_filetype:     ${chalk.white((d.filter.has_filetype || []).join(', ') || '(any)')}`);
    console.error(`  missing_filetype: ${chalk.white((d.filter.missing_filetype || []).join(', ') || '(none)')}`);
    console.error(`  paired:           ${chalk.white(String(!!d.filter.paired))}`);
    console.error(`  serials returned: ${chalk.green(d.n)}`);
    console.error('');
    for (const s of d.serials) console.log(s);
  } catch (err: any) {
    if (err.response) {
      Logger.error(`Cohort query failed (HTTP ${err.response.status}): ${err.response.data?.error || err.message}`);
    } else if (err.request) {
      Logger.error(`Cannot reach ${CONFIG.API_BASE_URL}/api_bioroutes/inventory/cohort`);
    } else {
      Logger.error(`Cohort query failed: ${err.message}`);
    }
    process.exit(1);
  }
}
