/**
 * biofs family status <biosample_serial...>
 *
 * Shows the complete NFT pipeline status for a family of biosamples.
 * Displays BioNFT → ClaraJobNFT → OpenCravatJobNFT → TrioAnalysisNFT hierarchy.
 */

import chalk from 'chalk';
import ora from 'ora';
import { spawnSync } from 'child_process';
import { ethers } from 'ethers';
import { Logger } from '../lib/utils/logger';
import { SEQUENTIA_NETWORK, CONFIG } from '../lib/config/constants';

export interface FamilyStatusOptions {
  json?: boolean;
  verbose?: boolean;
  noInventory?: boolean;       // skip bioroutes.inventory enrichment (chain-only)
  bionftAddress?: string;      // override BioNFT contract (legacy deployments)
  claraAddress?: string;       // override ClaraJobNFT contract
}

// Canonical Sequentia v4 contracts (env-overridable via constants.ts).
// Legacy deployments can be queried by passing --bionft-address / --clara-address.
const SEQUENTIA_RPC = SEQUENTIA_NETWORK.rpc;
const CHAIN_ID = SEQUENTIA_NETWORK.chainId;
const DEFAULT_BIONFT_CONTRACT = CONFIG.CONTRACTS.BIONFT;
// ClaraJobNFT has no canonical entry in constants yet — current deployment
// is at 0x1D19e75A... per project_clara_parabricks_agent memory (April 2026).
// Earlier V2 from Dec 2025 was 0x9B70040299efd49C0BBC607395F92a9492DCcc20.
const DEFAULT_CLARA_JOB_NFT_CONTRACT = '0x9B70040299efd49C0BBC607395F92a9492DCcc20';

// ABIs
const BIONFT_ABI = [
  'function serialToTokenId(string biosampleSerial) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getDerivatives(uint256 tokenId) view returns (tuple(address contractAddress, uint256 tokenId, string derivativeType, string description, uint256 timestamp, bytes32 dataHash)[])',
  'function derivativeCount(uint256 tokenId) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function getBiosampleInfo(uint256 tokenId) view returns (string serial, string ownerName, string sampleType, string captureKit, uint256 mintedAt)'
];

const CLARA_JOB_NFT_ABI = [
  'function totalSupply() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)'
];

interface FamilyMember {
  serial: string;
  name?: string;
  role?: string;
  bionftTokenId: bigint;
  owner: string;
  derivatives: Array<{
    contract: string;
    tokenId: bigint;
    type: string;
    description: string;
    timestamp: bigint;
  }>;
  inventory?: {
    fileTypes: number;
    totalBytes: number;
    labs: string[];
    summary: Record<string, number>;
    sourceLabHints: string[];
  };
}

/**
 * Pull file inventory for a biosample by shelling out to the same route_mount.py
 * the `biofs route check` command uses. Falls back gracefully if IAP/SSH or the
 * resolver is unreachable.
 */
function fetchInventorySummary(serial: string, debug: boolean): FamilyMember['inventory'] | undefined {
  const res = spawnSync(
    'gcloud',
    [
      'compute', 'ssh', 'genobank-production',
      '--zone=us-central1-a', '--tunnel-through-iap',
      '--command',
      `/home/ubuntu/Genobank_APIs/production_api/plugins/genoclaw/.venv/bin/python3 /home/ubuntu/bioroutes_dryrun/route_mount.py check ${serial} 2>&1`,
    ],
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 30000 }
  );
  if (res.status !== 0 || !res.stdout) {
    if (debug) Logger.debug(`inventory fetch failed for ${serial}: ${res.stderr || 'no output'}`);
    return undefined;
  }
  const lines = res.stdout.split('\n');
  const summary: Record<string, number> = {};
  let totalBytes = 0;
  const labHints = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[(\w+(?:_\w+)*)\s*\]/);
    if (!m) continue;
    const ftype = m[1];
    summary[ftype] = (summary[ftype] || 0) + 1;
    // Bytes are on the following gs:// line: "    gs://... NNNNN bytes"
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const bm = lines[j].match(/(\d+)\s+bytes\s*$/);
      if (bm) {
        totalBytes += parseInt(bm[1], 10);
        break;
      }
    }
    // Lab hint from path (augenomics, deepvariant, neochrom, etc.)
    const pathMatch = lines[i + 1] && lines[i + 1].match(/gs:\/\/([^/\s]+)/);
    if (pathMatch) {
      const bucket = pathMatch[1].toLowerCase();
      if (bucket.includes('augenomics')) labHints.add('AUGenomics');
      if (bucket.includes('neochrom')) labHints.add('Neochromosome');
      if (bucket.includes('color')) labHints.add('Color');
      if (bucket.includes('ultima')) labHints.add('Ultima');
      if (bucket.includes('deepvariant')) labHints.add('DeepVariant-pipeline');
    }
  }
  if (Object.keys(summary).length === 0) return undefined;
  return {
    fileTypes: Object.keys(summary).length,
    totalBytes,
    labs: Array.from(labHints),
    summary,
    sourceLabHints: Array.from(labHints),
  };
}

function formatBytes(n: number): string {
  if (n > 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export async function familyStatusCommand(
  biosampleSerials: string[],
  options: FamilyStatusOptions = {}
): Promise<void> {
  const spinner = ora('Fetching family pipeline status...').start();

  const bionftAddr = options.bionftAddress || DEFAULT_BIONFT_CONTRACT;
  const claraAddr = options.claraAddress || DEFAULT_CLARA_JOB_NFT_CONTRACT;
  let blockNumber: number | null = null;
  let chainReachable = false;
  let provider: ethers.JsonRpcProvider | null = null;
  let bionft: ethers.Contract | null = null;
  let claraJobNft: ethers.Contract | null = null;

  try {
    provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC, undefined, { staticNetwork: true } as any);
    blockNumber = await provider.getBlockNumber();
    chainReachable = true;
    bionft = new ethers.Contract(bionftAddr, BIONFT_ABI, provider);
    claraJobNft = new ethers.Contract(claraAddr, CLARA_JOB_NFT_ABI, provider);
  } catch (e: any) {
    spinner.warn(chalk.yellow(`Chain RPC unreachable at ${SEQUENTIA_RPC} — proceeding with off-chain inventory only.`));
    Logger.debug(`RPC error: ${e?.message || e}`);
  }

  const familyMembers: FamilyMember[] = [];

  for (const serial of biosampleSerials) {
    let tokenId = 0n;
    let owner = '';
    let name = '';
    const derivatives: FamilyMember['derivatives'] = [];

    if (chainReachable && bionft) {
      try {
        tokenId = await bionft.serialToTokenId(serial);
        if (tokenId !== 0n) {
          owner = await bionft.ownerOf(tokenId);
          try {
            const info = await bionft.getBiosampleInfo(tokenId);
            name = info.ownerName || '';
          } catch {
            // function may not exist on this deployment
          }
          try {
            const derivCount = await bionft.derivativeCount(tokenId);
            if (derivCount > 0n) {
              const derivs = await bionft.getDerivatives(tokenId);
              for (const d of derivs) {
                derivatives.push({
                  contract: d.contractAddress,
                  tokenId: d.tokenId,
                  type: d.derivativeType,
                  description: d.description,
                  timestamp: d.timestamp,
                });
              }
            }
          } catch {
            // derivatives API may not exist on this deployment
          }
        }
      } catch (e: any) {
        Logger.debug(`Chain query failed for ${serial}: ${e?.message || e}`);
      }
    }

    let inventory: FamilyMember['inventory'] | undefined;
    if (!options.noInventory) {
      try {
        inventory = fetchInventorySummary(serial, !!options.verbose);
      } catch (e: any) {
        Logger.debug(`Inventory fetch threw for ${serial}: ${e?.message || e}`);
      }
    }

    familyMembers.push({
      serial,
      name,
      bionftTokenId: tokenId,
      owner,
      derivatives,
      inventory,
    });
  }

  spinner.stop();

  // JSON output
  if (options.json) {
    const output = familyMembers.map(m => ({
      serial: m.serial,
      name: m.name,
      bionft_token_id: m.bionftTokenId.toString(),
      owner: m.owner,
      derivatives: m.derivatives.map(d => ({
        contract: d.contract,
        token_id: d.tokenId.toString(),
        type: d.type,
        description: d.description,
      })),
      inventory: m.inventory ? {
        file_types: m.inventory.fileTypes,
        total_bytes: m.inventory.totalBytes,
        labs: m.inventory.labs,
        summary: m.inventory.summary,
      } : null,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Display formatted output
  const network = SEQUENTIA_NETWORK;

  console.log('');
  console.log(chalk.cyan('═'.repeat(70)));
  console.log(chalk.bold.cyan('  🧬 FAMILY GENOMIC PIPELINE STATUS'));
  console.log(chalk.cyan('═'.repeat(70)));
  console.log(`  ${chalk.gray('Network:')} ${network.name} (Chain ID: ${CHAIN_ID})`);
  console.log(`  ${chalk.gray('RPC:')} ${chainReachable ? chalk.green('✓ ') + SEQUENTIA_RPC : chalk.red('✗ ') + SEQUENTIA_RPC + ' (unreachable)'}`);
  console.log(`  ${chalk.gray('Block:')} ${blockNumber ?? chalk.gray('n/a')}`);
  console.log(`  ${chalk.gray('BioNFT:')} ${bionftAddr}`);
  console.log(chalk.cyan('═'.repeat(70)));

    // Calculate totals
    const totalBioNFTs = familyMembers.filter(m => m.bionftTokenId > 0n).length;
    const totalDerivatives = familyMembers.reduce((sum, m) => sum + m.derivatives.length, 0);

    console.log('');
    console.log(chalk.bold('📊 Summary:'));
    console.log(`   ${chalk.green('✓')} ${totalBioNFTs}/${biosampleSerials.length} BioNFTs minted`);
    console.log(`   ${chalk.yellow('→')} ${totalDerivatives} total derivatives linked`);
    console.log('');

    // Display each family member
    for (let i = 0; i < familyMembers.length; i++) {
      const member = familyMembers[i];
      const isLast = i === familyMembers.length - 1;
      const prefix = isLast ? '└─' : '├─';
      const childPrefix = isLast ? '   ' : '│  ';

      if (member.bionftTokenId === 0n) {
        // Even without on-chain BioNFT, surface off-chain inventory so the
        // sample isn't reported as "missing" when it actually exists.
        const labelTokenless = member.inventory
          ? chalk.yellow(`${prefix} ${member.serial}: ⚠️  Not on-chain (off-chain inventory present)`)
          : chalk.gray(`${prefix} ${member.serial}: ❌ Not tokenized, no inventory found`);
        console.log(labelTokenless);
        if (member.inventory) {
          console.log(chalk.gray(`${childPrefix}├─ Files: ${member.inventory.fileTypes} types  |  Size: ${formatBytes(member.inventory.totalBytes)}`));
          if (member.inventory.labs.length > 0) {
            console.log(chalk.gray(`${childPrefix}├─ Lab hints: ${member.inventory.labs.join(', ')}`));
          }
          const top = Object.entries(member.inventory.summary)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ');
          console.log(chalk.gray(`${childPrefix}└─ Top types: ${top}`));
        }
        console.log('');
        continue;
      }

      // BioNFT header
      const nameStr = member.name ? ` (${member.name})` : '';
      console.log(chalk.white(`${prefix} 🧬 BioNFT #${member.bionftTokenId}${nameStr}`));
      console.log(chalk.gray(`${childPrefix}├─ Serial: ${member.serial}`));
      console.log(chalk.gray(`${childPrefix}├─ Owner: ${member.owner.substring(0, 20)}...`));
      if (member.inventory) {
        console.log(chalk.gray(`${childPrefix}├─ Inventory: ${member.inventory.fileTypes} file types, ${formatBytes(member.inventory.totalBytes)} (${member.inventory.labs.join(', ')})`));
      }

      // Derivatives
      if (member.derivatives.length === 0) {
        console.log(chalk.yellow(`${childPrefix}└─ No derivatives linked`));
      } else {
        for (let j = 0; j < member.derivatives.length; j++) {
          const d = member.derivatives[j];
          const dIsLast = j === member.derivatives.length - 1;
          const dPrefix = dIsLast ? '└─' : '├─';

          // Icon based on type
          let icon = '📄';
          let color = chalk.white;
          switch (d.type) {
            case 'clara_job':
              icon = '🔬';
              color = chalk.yellow;
              break;
            case 'opencravat':
              icon = '📊';
              color = chalk.cyan;
              break;
            case 'claude_ai':
              icon = '🤖';
              color = chalk.magenta;
              break;
            case 'trio_analysis':
              icon = '👨‍👩‍👧';
              color = chalk.green;
              break;
          }

          console.log(color(`${childPrefix}${dPrefix} ${icon} ${d.type} #${d.tokenId}`));

          if (options.verbose) {
            console.log(chalk.gray(`${childPrefix}${dIsLast ? '   ' : '│  '}   Contract: ${d.contract.substring(0, 20)}...`));
            console.log(chalk.gray(`${childPrefix}${dIsLast ? '   ' : '│  '}   ${d.description.substring(0, 40)}...`));
          }
        }
      }

      console.log('');
    }

    // Pipeline legend
    console.log(chalk.cyan('─'.repeat(70)));
    console.log(chalk.bold('📋 Pipeline Legend:'));
    console.log(`   ${chalk.white('🧬 BioNFT')}      → Root ownership token (ERC-721)`);
    console.log(`   ${chalk.yellow('🔬 clara_job')}  → DeepVariant VCF (FASTQ → VCF)`);
    console.log(`   ${chalk.cyan('📊 opencravat')} → Annotated variants (VCF → SQLite)`);
    console.log(`   ${chalk.magenta('🤖 claude_ai')}  → AI analysis report`);
    console.log(`   ${chalk.green('👨‍👩‍👧 trio')}       → Family trio analysis`);
    console.log(chalk.cyan('─'.repeat(70)));

    // Next steps
    const needsClara = familyMembers.filter(m =>
      m.bionftTokenId > 0n && !m.derivatives.some(d => d.type === 'clara_job')
    );

    if (needsClara.length > 0) {
      console.log('');
      console.log(chalk.bold('💡 Next Steps:'));
      for (const m of needsClara) {
        console.log(chalk.gray(`   biofs link clara ${m.serial}  # Link Clara job for ${m.name || m.serial}`));
      }
    }

  console.log('');
}


