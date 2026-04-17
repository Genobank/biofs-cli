/**
 * biofs link clara <biosample_serial>
 *
 * Mints a ClaraJobNFT for existing VCF output and links it as a derivative to the BioNFT.
 *
 * Prerequisites:
 * - Biosample must have a BioNFT minted
 * - VCF file must exist in GCS (Clara job completed)
 *
 * Contracts:
 * - BioNFT: 0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd
 * - ClaraJobNFT: 0xdCd99012D796A4b250386cD6AcF5386316A8c3f8
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { SEQUENTIA_NETWORK } from '../lib/config/constants';

export interface LinkClaraOptions {
  vcfPath?: string;
  quiet?: boolean;
  yes?: boolean;
}

// Contract addresses on Sequentia
const BIONFT_CONTRACT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const CLARA_JOB_NFT_CONTRACT = '0x9B70040299efd49C0BBC607395F92a9492DCcc20'; // V2 deployed Dec 7, 2025
const SEQUENTIA_RPC = 'http://54.226.180.9:8545';
const CHAIN_ID = 15132025;

// GCS bucket for VCF files (migrated from AWS S3 April 2026).
// Bucket name uses hyphens (GCS rule) where the legacy S3 bucket used dots.
// Override via env for dev / future migrations.
const GCS_BUCKET = process.env.GENOBANK_VCF_BUCKET
  || 'deepvariant-fastq-to-vcf-genobank-app';
const GCS_PUBLIC_BASE = `https://storage.googleapis.com/${GCS_BUCKET}`;

// Minter key (validator account with gas) - REQUIRED via environment variable
function getMinterKey(): string {
  const key = process.env.SEQUENTIA_MINTER_KEY;
  if (!key) {
    throw new Error('SEQUENTIA_MINTER_KEY environment variable is required');
  }
  return key;
}

// ABIs
const BIONFT_ABI = [
  'function serialToTokenId(string biosampleSerial) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getDerivatives(uint256 tokenId) view returns (tuple(address contractAddress, uint256 tokenId, string derivativeType, string description, uint256 timestamp, bytes32 dataHash)[])',
  'function derivativeCount(uint256 tokenId) view returns (uint256)',
  'function linkDerivative(uint256 parentTokenId, address derivativeContract, uint256 derivativeTokenId, string derivativeType, string description, bytes32 dataHash)'
];

const CLARA_JOB_NFT_ABI = [
  'function totalSupply() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function mintJob(address to, string biosampleSerial, string vcfPath, string pipeline, string referenceGenome, bytes32 vcfHash, string metadataUri) returns (uint256)',
  'function safeMint(address to, string uri) returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function biosampleToTokenId(string biosample) view returns (uint256)'
];

export async function linkClaraCommand(
  biosampleSerial: string,
  options: LinkClaraOptions = {}
): Promise<void> {
  // Security: biosample serials are numeric. Reject anything else before it
  // reaches any shell / GCS / HTTP context. See audit H1 (CVE-avoidance).
  if (!/^\d{6,20}$/.test(biosampleSerial)) {
    throw new Error(
      `Invalid biosample serial "${biosampleSerial}" — must be 6–20 digits`
    );
  }

  const spinner = ora('Initializing Clara job linking...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const network = SEQUENTIA_NETWORK;

    if (!options.quiet) {
      spinner.stop();
      console.log(chalk.cyan('\n🔗 BioFS Link Clara Job as Derivative'));
      console.log(chalk.gray('━'.repeat(50)));
      console.log(`\n🔬 Biosample: ${chalk.white(biosampleSerial)}`);
      console.log(`🌐 Network: ${chalk.white(network.name)} (Chain ID: ${CHAIN_ID})`);
      console.log(`📜 BioNFT: ${chalk.gray(BIONFT_CONTRACT)}`);
      console.log(`📜 ClaraJobNFT: ${chalk.gray(CLARA_JOB_NFT_CONTRACT)}\n`);
    }

    // Step 1: Connect to Sequentia
    spinner.start('Step 1/6: Connecting to Sequentia blockchain...');

    const provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC);
    const blockNumber = await provider.getBlockNumber();

    spinner.succeed(`Step 1/6: Connected to Sequentia (Block: ${blockNumber})`);

    // Step 2: Check BioNFT exists
    spinner.start('Step 2/6: Verifying BioNFT ownership...');

    const bionft = new ethers.Contract(BIONFT_CONTRACT, BIONFT_ABI, provider);
    const bionftTokenId = await bionft.serialToTokenId(biosampleSerial);

    if (bionftTokenId === 0n) {
      spinner.fail('Step 2/6: BioNFT not found');
      throw new Error(`Biosample ${biosampleSerial} is not tokenized. Run "biofs tokenize biosample ${biosampleSerial}" first.`);
    }

    const bionftOwner = await bionft.ownerOf(bionftTokenId);
    spinner.succeed(`Step 2/6: BioNFT #${bionftTokenId} owned by ${bionftOwner.substring(0, 10)}...`);

    // Step 3: Check if Clara derivative already linked
    spinner.start('Step 3/6: Checking existing derivatives...');

    const derivativeCount = await bionft.derivativeCount(bionftTokenId);
    let alreadyLinked = false;

    if (derivativeCount > 0n) {
      const derivatives = await bionft.getDerivatives(bionftTokenId);
      for (const d of derivatives) {
        if (d.derivativeType === 'clara_job') {
          alreadyLinked = true;
          spinner.warn(`Step 3/6: Clara job already linked as derivative #${d.tokenId}`);

          if (!options.quiet) {
            console.log(chalk.yellow('\n⚠️  This biosample already has a Clara job linked:'));
            console.log(`   ${chalk.cyan('Contract:')} ${d.contractAddress}`);
            console.log(`   ${chalk.cyan('Token ID:')} #${d.tokenId}`);
            console.log(`   ${chalk.cyan('Description:')} ${d.description}`);
            console.log('');
          }
          return;
        }
      }
    }

    spinner.succeed('Step 3/6: No existing Clara derivative found');

    // Step 4: Check VCF file exists in Google Cloud Storage
    spinner.start('Step 4/6: Locating VCF file in GCS...');

    let vcfPath = options.vcfPath;
    let vcfSize = 0;

    if (!vcfPath) {
      // Try to find VCF file automatically
      const possiblePaths = [
        `output/${biosampleSerial}/${biosampleSerial}.deepvariant.g.vcf`,
        `output/${biosampleSerial}/${biosampleSerial}.deepvariant.vcf`,
        `output/${biosampleSerial}/${biosampleSerial}.deepvariant.agilent_v8.vcf`
      ];

      for (const filePath of possiblePaths) {
        try {
          // GCS public JSON API — HEAD on storage.googleapis.com/<bucket>/<object>
          const response = await axios.head(`${GCS_PUBLIC_BASE}/${filePath}`, {
            timeout: 5000
          });
          if (response.status === 200) {
            vcfPath = `gs://${GCS_BUCKET}/${filePath}`;
            vcfSize = parseInt(response.headers['content-length'] || '0');
            break;
          }
        } catch {
          // Try next path
        }
      }

      if (!vcfPath) {
        // Fall back to `gcloud storage ls` via execFileSync (argv array — no shell
        // interpolation). Serial is regex-validated above; defense-in-depth: never
        // pass user input through a shell string.
        try {
          const { execFileSync } = require('child_process');
          const raw = execFileSync(
            'gcloud',
            ['storage', 'ls', `gs://${GCS_BUCKET}/output/${biosampleSerial}/`],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
          ) as string;

          // gcloud storage ls emits one gs:// URI per line. Pick the first VCF.
          const firstLine = raw
            .split(/\r?\n/)
            .find(l => /\.(?:g\.)?vcf(?:\.gz)?$/.test(l));

          if (firstLine) {
            const gsUri = firstLine.trim();
            // Validate URI shape: gs://<bucket>/<object-path> with safe chars
            if (/^gs:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(gsUri)) {
              vcfPath = gsUri;
              // Size is unavailable from `gcloud storage ls` without --long.
              // Caller treats vcfSize===0 as "unknown but present."
              vcfSize = 0;
            }
          }
        } catch {
          // gcloud CLI not available or error — try "gcloud storage ls -l" last-ditch
          try {
            const { execFileSync } = require('child_process');
            const raw = execFileSync(
              'gcloud',
              ['storage', 'ls', '-l', `gs://${GCS_BUCKET}/output/${biosampleSerial}/`],
              { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
            ) as string;
            const line = raw.split(/\r?\n/).find(l => /\.(?:g\.)?vcf(?:\.gz)?$/.test(l));
            if (line) {
              // -l output: "<size>  <date>  gs://bucket/path"
              const parts = line.trim().split(/\s+/);
              const uri = parts[parts.length - 1];
              if (/^gs:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(uri)) {
                vcfPath = uri;
                vcfSize = parseInt(parts[0] || '0', 10);
              }
            }
          } catch {
            // gcloud not available or final failure — let outer check handle
          }
        }
      }
    }

    if (!vcfPath) {
      spinner.fail('Step 4/6: VCF file not found');
      throw new Error(`No VCF file found for biosample ${biosampleSerial}. Run Clara job first or specify --vcf-path.`);
    }

    spinner.succeed(`Step 4/6: Found VCF at ${vcfPath.substring(0, 50)}...`);

    // Step 5: Mint ClaraJobNFT
    spinner.start('Step 5/6: Minting ClaraJobNFT...');

    const minterWallet = new ethers.Wallet(getMinterKey(), provider);
    const claraJobNft = new ethers.Contract(CLARA_JOB_NFT_CONTRACT, CLARA_JOB_NFT_ABI, provider);
    const claraJobNftWithSigner = claraJobNft.connect(minterWallet);

    // Generate VCF hash
    const vcfHash = ethers.keccak256(ethers.toUtf8Bytes(vcfPath));

    // Generate metadata
    const metadata = {
      name: `Clara DeepVariant VCF: ${biosampleSerial}`,
      description: `DeepVariant variant calling results for biosample ${biosampleSerial}. Generated by NVIDIA Clara Parabricks GPU pipeline.`,
      image: 'https://genobank.io/images/clara-job-nft.png',
      external_url: `https://biofs.genobank.app/vcf/${biosampleSerial}`,
      attributes: [
        { trait_type: 'Biosample ID', value: biosampleSerial },
        { trait_type: 'Pipeline', value: 'deepvariant' },
        { trait_type: 'Reference Genome', value: 'hg38' },
        { trait_type: 'VCF Path', value: vcfPath },
        { trait_type: 'Parent BioNFT', value: `#${bionftTokenId}` },
        { trait_type: 'Type', value: 'Derivative' }
      ]
    };

    const metadataUri = 'data:application/json;base64,' +
      Buffer.from(JSON.stringify(metadata)).toString('base64');

    // Mint ClaraJobNFT using mintJob function
    // Use typed contract interface to ensure proper encoding
    const mintTx = await (claraJobNftWithSigner as any).mintJob(
      bionftOwner,  // Mint to BioNFT owner
      biosampleSerial,
      vcfPath,
      'deepvariant',
      'hg38',
      vcfHash,
      metadataUri,
      { gasLimit: 1000000n }
    );

    const mintReceipt = await mintTx.wait();
    if (mintReceipt.status !== 1) {
      throw new Error('ClaraJobNFT mint transaction failed');
    }

    // Get new token ID
    const newClaraTokenId = await claraJobNft.totalSupply();

    spinner.succeed(`Step 5/6: ClaraJobNFT #${newClaraTokenId} minted`);

    // Step 6: Link as derivative to BioNFT
    spinner.start('Step 6/6: Linking as derivative to BioNFT...');

    const bionftWithSigner = bionft.connect(minterWallet);

    const linkTx = await (bionftWithSigner as any).linkDerivative(
      bionftTokenId,
      CLARA_JOB_NFT_CONTRACT,
      newClaraTokenId,
      'clara_job',
      `Clara Parabricks DeepVariant VCF from biosample ${biosampleSerial}`,
      vcfHash,
      { gasLimit: 500000n }
    );

    const linkReceipt = await linkTx.wait();
    if (linkReceipt.status !== 1) {
      throw new Error('Derivative linking transaction failed');
    }

    spinner.succeed('Step 6/6: Derivative linked successfully');

    // Display results
    console.log(chalk.gray('\n' + '━'.repeat(50)));
    console.log(chalk.green.bold('🎉 Clara Job Linked as Derivative!'));
    console.log(chalk.gray('━'.repeat(50) + '\n'));

    console.log(chalk.bold('📊 NFT Hierarchy:'));
    console.log(`   ${chalk.cyan('BioNFT')} #${bionftTokenId} (${biosampleSerial})`);
    console.log(`     └─ ${chalk.yellow('ClaraJobNFT')} #${newClaraTokenId} (DeepVariant VCF)`);
    console.log('');

    console.log(`${chalk.cyan('🔬 Biosample:')}     ${chalk.white(biosampleSerial)}`);
    console.log(`${chalk.cyan('🏷️  Parent BioNFT:')} ${chalk.white('#' + bionftTokenId.toString())}`);
    console.log(`${chalk.cyan('🧬 ClaraJobNFT:')}   ${chalk.white('#' + newClaraTokenId.toString())}`);
    console.log(`${chalk.cyan('📁 VCF Path:')}      ${chalk.gray(vcfPath)}`);
    console.log(`${chalk.cyan('🔐 Mint TX:')}       ${chalk.gray(mintReceipt.hash)}`);
    console.log(`${chalk.cyan('🔗 Link TX:')}       ${chalk.gray(linkReceipt.hash)}`);

    console.log(chalk.gray('\n💡 Next steps:'));
    console.log(chalk.gray(`   biofs link opencravat ${biosampleSerial}  # Annotate VCF and link`));
    console.log(chalk.gray(`   biofs family status ${biosampleSerial}    # View family pipeline`));
    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Linking failed'));
    Logger.error(`Error: ${error.message}`);

    if (error.code === 'CALL_EXCEPTION') {
      console.log(chalk.red('\n❌ Smart contract call failed'));
      console.log(chalk.gray('   Check contract deployment and parameters'));
    }

    throw error;
  }
}


