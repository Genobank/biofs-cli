import chalk from 'chalk';
import { BioRoutesClient } from '../lib/bioroutes/client';
import { CredentialsManager } from '../lib/auth/credentials';
import { CONFIG } from '../lib/config/constants';
import { Logger } from '../lib/utils/logger';

export interface MatchOptions {
  owner: string;
  snps?: string;
  snpFile?: string;
  json?: boolean;
  verbose?: boolean;
}

interface SnpInput {
  rsid: string;
  chrom: string;
  pos: string;
  genotype: string;
}

function parseSnpString(input: string): SnpInput[] {
  return input.split(',').map(s => {
    const parts = s.trim().split(':');
    if (parts.length !== 4) {
      throw new Error(
        `Invalid SNP format: "${s}". Expected rsid:chrom:pos:genotype (e.g. rs367789441:1:68082:TT). ` +
        'Do NOT use chr17:41276045:G:A format — convert to paper canonical form first.'
      );
    }
    if (!parts[0].startsWith('rs') && !parts[0].startsWith('i')) {
      throw new Error(
        `Invalid rsid "${parts[0]}" in "${s}". Must start with "rs" or "i". ` +
        'The canonical encoding is rsid:chrom:pos:genotype per ICISSP 2024 Table 1.'
      );
    }
    return { rsid: parts[0], chrom: parts[1], pos: parts[2], genotype: parts[3] };
  });
}

export async function matchCommand(options: MatchOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(1);
  }

  if (!options.owner) {
    Logger.error('--owner <wallet> is required.');
    process.exit(1);
  }

  if (!options.snps && !options.snpFile) {
    Logger.error('Provide --snps <rsid:chrom:pos:gt,...> or --snp-file <path>.');
    process.exit(1);
  }

  let snps: SnpInput[];
  if (options.snps) {
    snps = parseSnpString(options.snps);
  } else {
    const fs = await import('fs/promises');
    const content = await fs.readFile(options.snpFile!, 'utf-8');
    snps = parseSnpString(content.replace(/\n/g, ',').replace(/,,/g, ','));
  }

  if (options.verbose) {
    Logger.debug(`Parsed ${snps.length} SNPs for matching`);
    Logger.debug(`Owner wallet: ${options.owner}`);
  }

  if (!options.json) {
    console.log(chalk.cyan(`Matching ${snps.length} SNPs against owner ${options.owner.slice(0, 10)}...`));
  }

  const apiBase = CONFIG.API_BASE_URL;
  const axios = (await import('axios')).default;

  // Stage 1: Matcher query — returns Y/N only (per ICISSP 2024 §6)
  if (!options.json) console.log(chalk.gray('  Stage 1: Matcher (Bloom pre-check + accumulator)...'));
  let matcherResult: any;
  try {
    const resp = await axios.post(`${apiBase}/api_bioroutes/matcher/query`, {
      owner_wallet: options.owner,
      snps: snps.map(s => ({ rsid: s.rsid, chrom: s.chrom, pos: s.pos, genotype: s.genotype })),
      requester_wallet: creds.wallet_address,
    }, { timeout: 30000 });
    matcherResult = resp.data;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'matcher_unreachable', message: err.message }));
    } else {
      Logger.error(`Matcher service unreachable: ${err.message}`);
      console.log(chalk.gray('  The /api_bioroutes/matcher/query endpoint may not be deployed yet.'));
    }
    process.exit(1);
  }

  if (!matcherResult.match) {
    if (options.json) {
      console.log(JSON.stringify({ match: false, confidence: matcherResult.confidence, snp_count: snps.length }));
    } else {
      console.log(chalk.yellow(`  No match. Confidence: ${matcherResult.confidence}`));
    }
    return;
  }

  if (!options.json) {
    console.log(chalk.green(`  Match confirmed (${matcherResult.confidence})`));
    console.log(chalk.gray('  Stage 2: Minting Privacy Ticket (EIP-712)...'));
  }

  // Stage 2: Privacy-record match — mint ticket
  let ticketResult: any;
  try {
    const resp = await axios.post(`${apiBase}/api_bioroutes/privacy_record_match/mint_ticket`, {
      matcher_query_id: matcherResult.query_id,
      scope: ['vcf'],
      ttl_sec: 900,
    }, {
      headers: { Authorization: `Bearer ${creds.user_signature}` },
      timeout: 30000,
    });
    ticketResult = resp.data;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ match: true, ticket_error: err.message }));
    } else {
      Logger.error(`Ticket mint failed: ${err.message}`);
      console.log(chalk.gray('  Owner may need to approve via EIP-712 signature.'));
    }
    process.exit(1);
  }

  if (!options.json) {
    console.log(chalk.green(`  Ticket minted: ${ticketResult.ticket_jwt?.slice(0, 30)}...`));
    console.log(chalk.gray('  Stage 3: Resolving via ticket...'));
  }

  // Stage 3: Resolver — consume ticket, get presigned URL
  let resolverResult: any;
  try {
    const resp = await axios.post(`${apiBase}/api_bioroutes/resolver/resolve`, {}, {
      headers: { Authorization: `Ticket ${ticketResult.ticket_jwt}` },
      timeout: 30000,
    });
    resolverResult = resp.data;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ match: true, ticket: ticketResult.ticket_jwt, resolve_error: err.message }));
    } else {
      Logger.error(`Resolver failed: ${err.message}`);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify({
      match: true,
      confidence: matcherResult.confidence,
      ticket_id: ticketResult.ticket_id,
      access_url: resolverResult.access_url,
      masking_rules: resolverResult.masking_rules,
      resolution_log: resolverResult.resolution_log,
    }, null, 2));
  } else {
    console.log('');
    console.log(chalk.bold.green('Match resolved successfully'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(`  Confidence:   ${matcherResult.confidence}`);
    console.log(`  Ticket:       ${ticketResult.ticket_id}`);
    console.log(`  Access URL:   ${resolverResult.access_url?.slice(0, 60)}...`);
    if (resolverResult.masking_rules) {
      console.log(`  Masking:      ${JSON.stringify(resolverResult.masking_rules)}`);
    }
    console.log('');
  }
}
