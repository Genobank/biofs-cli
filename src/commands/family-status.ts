/**
 * biofs family status <biosample_serial...>
 *
 * Shows the complete NFT pipeline status for a family of biosamples.
 * Displays BioNFT → ClaraJobNFT → OpenCravatJobNFT → TrioAnalysisNFT hierarchy.
 */

import chalk from 'chalk';
import ora from 'ora';
import { ethers } from 'ethers';
import { Logger } from '../lib/utils/logger';
import { SEQUENTIA_NETWORK } from '../lib/config/constants';

export interface FamilyStatusOptions {
  json?: boolean;
  verbose?: boolean;
}

// Contract addresses on Sequentia
const BIONFT_CONTRACT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const CLARA_JOB_NFT_CONTRACT = '0x9B70040299efd49C0BBC607395F92a9492DCcc20'; // V2 deployed Dec 7, 2025
const SEQUENTIA_RPC = 'http://54.226.180.9:8545';
const CHAIN_ID = 15132025;

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
}

export async function familyStatusCommand(
  biosampleSerials: string[],
  options: FamilyStatusOptions = {}
): Promise<void> {
  const spinner = ora('Fetching family pipeline status...').start();

  try {
    // Connect to Sequentia
    const provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC);
    const blockNumber = await provider.getBlockNumber();

    const bionft = new ethers.Contract(BIONFT_CONTRACT, BIONFT_ABI, provider);
    const claraJobNft = new ethers.Contract(CLARA_JOB_NFT_CONTRACT, CLARA_JOB_NFT_ABI, provider);

    const familyMembers: FamilyMember[] = [];

    // Fetch data for each biosample
    for (const serial of biosampleSerials) {
      try {
        const tokenId = await bionft.serialToTokenId(serial);

        if (tokenId === 0n) {
          familyMembers.push({
            serial,
            bionftTokenId: 0n,
            owner: '',
            derivatives: []
          });
          continue;
        }

        const owner = await bionft.ownerOf(tokenId);

        // Get biosample info if available
        let name = '';
        let sampleType = '';
        try {
          const info = await bionft.getBiosampleInfo(tokenId);
          name = info.ownerName || '';
          sampleType = info.sampleType || '';
        } catch {
          // Function may not exist
        }

        // Get derivatives
        const derivatives: FamilyMember['derivatives'] = [];
        const derivCount = await bionft.derivativeCount(tokenId);

        if (derivCount > 0n) {
          const derivs = await bionft.getDerivatives(tokenId);
          for (const d of derivs) {
            derivatives.push({
              contract: d.contractAddress,
              tokenId: d.tokenId,
              type: d.derivativeType,
              description: d.description,
              timestamp: d.timestamp
            });
          }
        }

        familyMembers.push({
          serial,
          name,
          bionftTokenId: tokenId,
          owner,
          derivatives
        });
      } catch (error) {
        Logger.debug(`Error fetching ${serial}: ${error}`);
        familyMembers.push({
          serial,
          bionftTokenId: 0n,
          owner: '',
          derivatives: []
        });
      }
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
          description: d.description
        }))
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
    console.log(`  ${chalk.gray('Block:')} ${blockNumber}`);
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
        console.log(chalk.gray(`${prefix} ${member.serial}: ❌ Not tokenized`));
        continue;
      }

      // BioNFT header
      const nameStr = member.name ? ` (${member.name})` : '';
      console.log(chalk.white(`${prefix} 🧬 BioNFT #${member.bionftTokenId}${nameStr}`));
      console.log(chalk.gray(`${childPrefix}├─ Serial: ${member.serial}`));
      console.log(chalk.gray(`${childPrefix}├─ Owner: ${member.owner.substring(0, 20)}...`));

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

  } catch (error: any) {
    spinner.fail(chalk.red('Failed to fetch family status'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}
