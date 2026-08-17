/**
 * biofs tokenize biosample <serial>
 *
 * Mints a BioNFT from the deployed BioNFT contract on Sequentia for a biosample.
 * Creates a custodian BioWallet and links existing S3 files.
 *
 * BioNFT Contract: 0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd
 * Sequentia Chain ID: 15132025
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { SEQUENTIA_NETWORK, API_CONFIG } from '../lib/config/constants';

export interface TokenizeBiosampleOptions {
  ownerName?: string;
  owner?: string;
  role?: string;
  sampleType?: string;
  captureKit?: string;
  quiet?: boolean;
  yes?: boolean;
}

// Contract addresses on Sequentia
const BIONFT_CONTRACT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const SEQUENTIA_RPC = 'http://54.226.180.9:8545';
const CHAIN_ID = 15132025;

// Minter key (validator account with gas) - REQUIRED via environment variable
function getMinterKey(): string {
  const key = process.env.SEQUENTIA_MINTER_KEY;
  if (!key) {
    throw new Error('SEQUENTIA_MINTER_KEY environment variable is required');
  }
  return key;
}

// BioNFT ABI (minimal for minting)
const BIONFT_ABI = [
  'function mintBiosample(address to, string biosampleSerial, string ownerName, string sampleType, string captureKit, string metadataUri) returns (uint256)',
  'function serialToTokenId(string biosampleSerial) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event BiosampleMinted(uint256 indexed tokenId, string biosampleSerial, address indexed owner, string ownerName)'
];

export async function tokenizeBiosampleCommand(
  biosampleSerial: string,
  options: TokenizeBiosampleOptions = {}
): Promise<void> {
  const spinner = ora('Initializing BioNFT tokenization...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const network = SEQUENTIA_NETWORK;

    if (!options.quiet) {
      spinner.stop();
      console.log(chalk.cyan('\n🧬 BioFS Biosample Tokenization'));
      console.log(chalk.gray('━'.repeat(50)));
      console.log(`\n🔬 Biosample: ${chalk.white(biosampleSerial)}`);
      console.log(`🔐 Your Wallet: ${chalk.white(credentials.wallet_address)}`);
      console.log(`🌐 Network: ${chalk.white(network.name)} (Chain ID: ${CHAIN_ID})`);
      console.log(`📜 Contract: ${chalk.gray(BIONFT_CONTRACT)}\n`);
    }

    // Step 1: Connect to Sequentia
    spinner.start('Step 1/5: Connecting to Sequentia blockchain...');

    const provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC);
    const blockNumber = await provider.getBlockNumber();

    spinner.succeed(`Step 1/5: Connected to Sequentia (Block: ${blockNumber})`);

    // Step 2: Check if biosample already tokenized
    spinner.start('Step 2/5: Checking tokenization status...');

    const bionft = new ethers.Contract(BIONFT_CONTRACT, BIONFT_ABI, provider);
    const existingTokenId = await bionft.serialToTokenId(biosampleSerial);

    if (existingTokenId > 0n) {
      const owner = await bionft.ownerOf(existingTokenId);
      spinner.succeed(`Step 2/5: Already tokenized as BioNFT #${existingTokenId}`);

      console.log('');
      console.log(chalk.yellow('⚠️  This biosample is already tokenized:'));
      console.log(`   ${chalk.cyan('Token ID:')} #${existingTokenId}`);
      console.log(`   ${chalk.cyan('Owner:')} ${owner}`);
      console.log('');
      return;
    }

    spinner.succeed('Step 2/5: Biosample not yet tokenized');

    // Step 3: Query S3 for biosample files
    spinner.start('Step 3/5: Discovering biosample files in S3...');

    let files: string[] = [];
    try {
      const response = await axios.get(`${API_CONFIG.base}/api_biofs_fuse/list`, {
        params: {
          biosample: biosampleSerial,
          wallet: credentials.wallet_address,
          signature: credentials.user_signature
        }
      });

      if (response.data.files) {
        files = response.data.files;
      }
    } catch (error) {
      // Files may exist but not be indexed yet
      Logger.debug(`S3 query error: ${error}`);
    }

    if (files.length > 0) {
      spinner.succeed(`Step 3/5: Found ${files.length} file(s) in S3`);
      if (!options.quiet) {
        console.log(chalk.gray('   Files:'));
        files.slice(0, 5).forEach(f => console.log(chalk.gray(`   - ${f}`)));
        if (files.length > 5) {
          console.log(chalk.gray(`   ... and ${files.length - 5} more`));
        }
      }
    } else {
      spinner.warn('Step 3/5: No files found in S3 (will tokenize anyway)');
    }

    // Get owner info if not provided
    let ownerName = options.ownerName;
    let role = options.role || 'patient';
    let sampleType = options.sampleType || 'exome';
    let captureKit = options.captureKit || 'agilent_v8';

    if (!ownerName && !options.yes) {
      spinner.stop();
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'ownerName',
          message: 'Owner name:',
          default: `Patient ${biosampleSerial.slice(-4)}`
        },
        {
          type: 'list',
          name: 'role',
          message: 'Role:',
          choices: ['patient', 'mother', 'father', 'child', 'proband', 'sibling'],
          default: 'patient'
        },
        {
          type: 'list',
          name: 'sampleType',
          message: 'Sample type:',
          choices: ['exome', 'genome', 'panel', 'array'],
          default: 'exome'
        }
      ]);
      ownerName = answers.ownerName;
      role = answers.role;
      sampleType = answers.sampleType;
    } else if (!ownerName) {
      ownerName = `Patient ${biosampleSerial.slice(-4)}`;
    }

    // Confirmation
    if (!options.yes && !options.quiet) {
      console.log('');
      console.log(chalk.bold('📋 BioNFT Details:'));
      console.log(`   ${chalk.cyan('Biosample:')} ${biosampleSerial}`);
      console.log(`   ${chalk.cyan('Owner:')} ${ownerName}`);
      console.log(`   ${chalk.cyan('Role:')} ${role}`);
      console.log(`   ${chalk.cyan('Sample Type:')} ${sampleType}`);
      console.log(`   ${chalk.cyan('Capture Kit:')} ${captureKit}`);
      console.log('');

      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: chalk.yellow('Mint BioNFT for this biosample?'),
        default: true
      }]);

      if (!confirm) {
        console.log(chalk.yellow('\n❌ Tokenization cancelled.\n'));
        return;
      }
    }

    // Step 4: Resolve the ROOT OWNER biowallet. Every biofile is owned by exactly one
    // legitimate biowallet, never a throwaway. Root ownership goes to an explicit
    // --owner biowallet, otherwise to the authenticated caller. A random ephemeral
    // wallet is never generated, and no private key is ever created or printed here.
    spinner.start('Step 4/5: Resolving root owner biowallet...');
    let ownerAddress: string;
    if (options.owner) {
      if (!ethers.isAddress(options.owner)) {
        throw new Error(`--owner must be a valid biowallet address, got: ${options.owner}`);
      }
      ownerAddress = ethers.getAddress(options.owner);
    } else {
      ownerAddress = ethers.getAddress(credentials.wallet_address);
    }
    spinner.succeed(`Step 4/5: Root owner biowallet: ${ownerAddress}`);

    // Step 5: Mint BioNFT
    spinner.start('Step 5/5: Minting BioNFT on Sequentia...');

    const minterWallet = new ethers.Wallet(getMinterKey(), provider);
    const bionftWithSigner = bionft.connect(minterWallet);

    // Generate metadata URI
    const metadata = {
      name: `BioNFT: ${ownerName} (${biosampleSerial})`,
      description: `Root ownership NFT for biosample ${biosampleSerial}. This NFT represents ownership of all genomic data derived from this biosample.`,
      image: 'https://genobank.io/images/bionft-default.png',
      external_url: `https://biofs.genobank.app/biosample/${biosampleSerial}`,
      attributes: [
        { trait_type: 'Biosample ID', value: biosampleSerial },
        { trait_type: 'Owner', value: ownerName },
        { trait_type: 'Role', value: role },
        { trait_type: 'Sample Type', value: sampleType },
        { trait_type: 'Capture Kit', value: captureKit },
        { trait_type: 'Standard', value: 'ERC-721 + Story Protocol Compatible' },
        { trait_type: 'Files', value: files.length.toString() }
      ]
    };

    const metadataUri = 'data:application/json;base64,' +
      Buffer.from(JSON.stringify(metadata)).toString('base64');

    // Estimate gas
    let gasEstimate: bigint;
    try {
      gasEstimate = await bionftWithSigner.getFunction('mintBiosample').estimateGas(
        ownerAddress,
        biosampleSerial,
        ownerName,
        sampleType,
        captureKit,
        metadataUri
      );
    } catch (error) {
      Logger.debug(`Gas estimation error: ${error}`);
      gasEstimate = 500000n;
    }

    // Send transaction
    const tx = await bionftWithSigner.getFunction('mintBiosample')(
      ownerAddress,
      biosampleSerial,
      ownerName,
      sampleType,
      captureKit,
      metadataUri,
      { gasLimit: gasEstimate + 50000n }
    );

    spinner.text = 'Step 5/5: Waiting for confirmation...';
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      throw new Error('Transaction failed');
    }

    // Get token ID
    const tokenId = await bionft.serialToTokenId(biosampleSerial);

    spinner.succeed(`Step 5/5: BioNFT #${tokenId} minted successfully!`);

    // Display results
    console.log(chalk.gray('\n' + '━'.repeat(50)));
    console.log(chalk.green.bold('🎉 BioNFT Tokenization Complete!'));
    console.log(chalk.gray('━'.repeat(50) + '\n'));

    console.log(`${chalk.cyan('🔬 Biosample:')}     ${chalk.white(biosampleSerial)}`);
    console.log(`${chalk.cyan('🏷️  Token ID:')}      ${chalk.white('#' + tokenId.toString())}`);
    console.log(`${chalk.cyan('👤 Owner:')}         ${chalk.white(ownerName)} (${role})`);
    console.log(`${chalk.cyan('👤 Owner Wallet:')}   ${chalk.white(ownerAddress)}`);
    console.log(`${chalk.cyan('📁 Files:')}         ${chalk.white(files.length.toString())} genomic file(s)`);
    console.log(`${chalk.cyan('🌐 Network:')}       ${chalk.white(network.name)} (Chain ID: ${CHAIN_ID})`);
    console.log(`${chalk.cyan('🔐 TX Hash:')}       ${chalk.gray(receipt.hash)}`);
    console.log(`${chalk.cyan('📦 Block:')}         ${chalk.white(receipt.blockNumber.toString())}`);
    console.log(`${chalk.cyan('⛽ Gas Used:')}      ${chalk.white(receipt.gasUsed.toString())}`);


    console.log(chalk.gray('💡 Next steps:'));
    console.log(chalk.gray(`   biofs access grant ${biosampleSerial} --agent <lab_wallet>  # Grant access to lab`));
    console.log(chalk.gray(`   biofs job submit-clara ${biosampleSerial}                   # Submit Clara job`));
    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Tokenization failed'));
    Logger.error(`Error: ${error.message}`);

    if (error.code === 'CALL_EXCEPTION') {
      console.log(chalk.red('\n❌ Smart contract call failed'));
      console.log(chalk.gray('   This may be due to:'));
      console.log(chalk.gray('   - Insufficient gas'));
      console.log(chalk.gray('   - Contract not deployed'));
      console.log(chalk.gray('   - Invalid parameters'));
    }

    throw error;
  }
}


