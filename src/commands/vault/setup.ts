/**
 * `biofs vault setup` — scaffolds ~/genobank/vault/ for the logged-in wallet.
 *
 * Writes a manifest listing every BioNFT the caller owns across BioAssetVault
 * (biosample parents + data file children) and BioNFTCredentials (rent
 * agreements + ingest tickets). Does NOT download any data yet — run
 * `biofs vault mount` for that.
 *
 * This is the portable alternative to the full biofs-fuse Rust FUSE driver:
 * it works on macOS + Linux, needs no kernel signing, no root privileges,
 * no external services. Tradeoff: data is materialized as real files on
 * disk (subject to ~/.cache eviction) instead of streamed on-read.
 */
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialsManager } from '../../lib/auth/credentials';
import {
  createBioNFTClient,
  INGEST_TICKET_MIN,
  RENT_AGREEMENT_MIN,
  RENT_AGREEMENT_MAX,
} from '../../lib/bionft/client';
import { Logger } from '../../lib/utils/logger';

export interface VaultSetupOptions {
  path?: string;
  force?: boolean;
}

export async function vaultSetupCommand(options: VaultSetupOptions): Promise<void> {
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds?.wallet_address) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(3);
  }
  const wallet = creds.wallet_address.toLowerCase();

  const vaultPath = options.path || path.join(os.homedir(), 'genobank', 'vault');
  if (fs.existsSync(vaultPath) && !options.force) {
    console.log(chalk.yellow(`⚠  ${vaultPath} already exists. Use --force to re-scaffold.`));
    const manifest = path.join(vaultPath, '.manifest.json');
    if (fs.existsSync(manifest)) {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      console.log(chalk.gray(`   existing manifest: ${m.bionfts?.length ?? 0} BioNFTs, wallet ${m.wallet?.slice(0, 10)}…`));
    }
    return;
  }
  fs.mkdirSync(vaultPath, { recursive: true });

  const client = createBioNFTClient({ readOnly: true });
  console.log(chalk.gray(`discovering BioNFTs owned by ${wallet.slice(0, 10)}… on Sequentia (this takes a moment)`));

  // Vanilla ERC-1155 doesn't expose a tokens-of-owner view. For v1 we walk the
  // contract counters forward and balanceOf-check each tokenId. Ranges:
  //   biosample parent:    1..nextParentId-1
  //   data file child:     1_000_001..nextChildId-1
  //   rent agreement:      2_000_001..nextRentAgreementId-1
  //   ingest ticket:       3_000_001..nextIngestTicketId-1
  // A chain-indexer microservice (plan §F.5) is the scalable version; this
  // O(N) walk is fine for v1 since total supply is a few thousand tokens.

  const nextParent = BigInt(await client.vault.nextParentId());
  const nextChild = BigInt(await client.vault.nextChildId());
  const nextRent = BigInt(await client.creds.nextRentAgreementId());
  const nextTicket = BigInt(await client.creds.nextIngestTicketId());

  const owned: Array<{ tokenId: string; category: string; contract: string }> = [];

  async function scan(label: string, contract: any, from: bigint, to: bigint, category: string) {
    if (to <= from) return;
    const total = Number(to - from);
    process.stderr.write(`  scanning ${label} (${total} tokens)... `);
    let found = 0;
    for (let id = from; id < to; id++) {
      try {
        const bal: bigint = await contract.balanceOf(wallet, id);
        if (bal > 0n) {
          owned.push({ tokenId: id.toString(), category, contract: await contract.getAddress() });
          found++;
        }
      } catch { /* continue */ }
    }
    process.stderr.write(chalk.green(`${found} owned\n`));
  }

  await scan('biosample parents', client.vault, 1n, nextParent, 'BIOSAMPLE_PARENT');
  await scan('data file children', client.vault, 1_000_001n, nextChild, 'DATA_FILE_CHILD');
  await scan('rent agreements', client.creds, RENT_AGREEMENT_MIN, nextRent, 'RENT_AGREEMENT');
  await scan('ingest tickets', client.creds, INGEST_TICKET_MIN, nextTicket, 'INGEST_TICKET');

  // Pre-create per-BioNFT subdirectories + a README in each
  for (const bionft of owned) {
    const slug = `${bionft.category.toLowerCase()}-${bionft.tokenId}`;
    const dir = path.join(vaultPath, slug);
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'annotated'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'metadata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'),
      `# BioNFT #${bionft.tokenId} · ${bionft.category}

On-chain contract: ${bionft.contract}
Wallet:            ${wallet}

Populated by \`biofs vault mount\`. Until you run that, these directories
are empty scaffolds. The \`annotated/\` directory will contain the
OpenCRAVAT-annotated VCF when Phase D's htsget stream finishes.

View the on-chain record: \`biofs bionft view ${bionft.tokenId}\`
Revoke (RENT_AGREEMENT or INGEST_TICKET only): \`biofs bionft revoke ${bionft.tokenId}\`
`);
  }

  const manifest = {
    wallet,
    vault_path: vaultPath,
    scaffold_version: 1,
    created_at: new Date().toISOString(),
    contracts: {
      bioAssetVault: await client.vault.getAddress(),
      bioNFTCredentials: await client.creds.getAddress(),
      sequentia_rpc: 'https://seqrpc.genobank.app',
      chain_id: 15132025,
    },
    bionfts: owned,
  };
  fs.writeFileSync(path.join(vaultPath, '.manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(chalk.green('\n✓ vault scaffolded'));
  console.log(chalk.gray(`  ${vaultPath}`));
  console.log(chalk.gray(`  ${owned.length} BioNFT${owned.length === 1 ? '' : 's'} detected`));
  for (const c of ['BIOSAMPLE_PARENT', 'DATA_FILE_CHILD', 'RENT_AGREEMENT', 'INGEST_TICKET']) {
    const n = owned.filter(b => b.category === c).length;
    if (n) console.log(chalk.gray(`    ${c.padEnd(18)} ${n}`));
  }
  console.log('\nNext: ' + chalk.cyan('biofs vault mount') + '   ← downloads annotated VCFs via htsget');
}
