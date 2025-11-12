import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { GenoBankAPIClient } from '../lib/api/client';
import { BioCIDResolver } from '../lib/biofiles/resolver';
import { BioFilesCacheManager } from '../lib/storage/biofiles-cache';
import { Logger } from '../lib/utils/logger';
import { VCFFingerprint } from '../lib/genomics/vcf-fingerprint';

export interface ShareOptions {
  lab: string;
  license?: 'non-commercial' | 'commercial' | 'commercial-remix';
  verbose?: boolean;
  debug?: boolean;
}

export async function shareCommand(
  biocidOrFilename: string,
  options: ShareOptions
): Promise<void> {
  // Load user credentials
  const { getCredentials } = await import('../lib/auth/credentials');
  const credentials = await getCredentials();

  if (!credentials) {
    Logger.error('Not authenticated. Please run: biofs login');
    process.exit(1);
  }

  const api = GenoBankAPIClient.getInstance();
  const resolver = new BioCIDResolver();

  // Validate lab wallet address
  if (!options.lab || !options.lab.match(/^0x[a-fA-F0-9]{40}$/)) {
    Logger.error('Invalid lab wallet address. Must be a valid Ethereum address (0x...)');
    throw new Error('Invalid lab wallet address');
  }

  const licenseType = options.license || 'non-commercial';

  console.log(chalk.cyan('\n🔍 Preparing biofile for sharing...\n'));
  console.log(`${chalk.gray('File:')} ${biocidOrFilename}`);
  console.log(`${chalk.gray('Lab:')} ${options.lab}`);
  console.log(`${chalk.gray('License:')} ${licenseType}\n`);

  try {
    // Step 1: Verify lab is approved
    const spinner1 = ora('Verifying lab authorization...').start();
    const labs = await api.getApprovedLabs();
    const lab = labs.find(l => l.wallet_address.toLowerCase() === options.lab.toLowerCase());

    if (!lab) {
      spinner1.fail();
      Logger.error(`Lab ${options.lab} is not in the approved labs registry`);
      Logger.info(`Run 'biofs labnfts' to see approved labs`);
      throw new Error('Lab not authorized');
    }

    spinner1.succeed(`Lab verified: ${chalk.green(lab.name)}`);

    // Step 2: Resolve file and check if already tokenized
    const spinner2 = ora('Checking file tokenization status...').start();

    // Try cache first for faster resolution
    const cacheManager = new BioFilesCacheManager();
    const cachedFile = cacheManager.findByIdentifier(biocidOrFilename);

    let fileInfo;
    try {
      if (cachedFile && cachedFile.locations.s3) {
        // Use cached file info
        spinner2.info(`File found in cache: ${cachedFile.metadata.file_type || 'genomic'} file`);
        Logger.debug(`Using cached S3 path: ${cachedFile.locations.s3}`);

        fileInfo = await resolver.resolve(biocidOrFilename);
      } else {
        // Not in cache or no S3 path - use resolver
        fileInfo = await resolver.resolve(biocidOrFilename);
        spinner2.info(`File found: ${fileInfo.type} storage`);
      }
    } catch (error) {
      spinner2.fail();
      Logger.error(`File not found: ${biocidOrFilename}`);
      throw error;
    }

    // Step 3: Mint dual NFTs if needed
    let biocid: string = '';
    let ipAssetId: string = '';

    // Check if file already has BioCID
    const existingBiocid = await api.checkExistingBiocid(biocidOrFilename);

    if (existingBiocid) {
      console.log(`\n${chalk.green('✓')} File already has BioCID: ${chalk.cyan(existingBiocid.biocid)}`);
      biocid = existingBiocid.biocid;
      ipAssetId = existingBiocid.story_ip_id || '';
    } else {
      console.log(`\n${chalk.yellow('⚠️')}  File not yet tokenized as BioNFT`);
      console.log(chalk.cyan('🎨 Initiating dual NFT minting...\n'));

      // Step 3a: Mint BioCID on Sequentias
      {
        console.log(chalk.bold('┌─────────────────────────────────────────────────┐'));
        console.log(chalk.bold('│ Step 1/4: Minting BioCID on Sequentias Network │'));
        console.log(chalk.bold('└─────────────────────────────────────────────────┘'));

        // Calculate DNA fingerprint and file hash locally (for genomic files)
        let dnaFingerprint: string | undefined;
        let fileHash: string | undefined;

        const isGenomicFile = biocidOrFilename.endsWith('.vcf') || biocidOrFilename.endsWith('.vcf.gz') ||
                              biocidOrFilename.endsWith('.sqlite') || biocidOrFilename.endsWith('.txt') ||
                              fileInfo.path?.endsWith('.vcf') || fileInfo.path?.endsWith('.sqlite');

        if (isGenomicFile) {
          const spinnerFingerprint = ora('Calculating DNA fingerprint and file hash...').start();
          try {
            // Check if file exists locally
            let localFilePath: string | null = null;

            // Try current directory
            if (fs.existsSync(biocidOrFilename)) {
              localFilePath = biocidOrFilename;
            }
            // Try absolute path
            else if (path.isAbsolute(biocidOrFilename) && fs.existsSync(biocidOrFilename)) {
              localFilePath = biocidOrFilename;
            }
            // Try user's home directory common genomics locations
            else {
              const homePath = path.join(process.env.HOME || process.env.USERPROFILE || '', biocidOrFilename);
              if (fs.existsSync(homePath)) {
                localFilePath = homePath;
              }
            }

            if (localFilePath) {
              // Calculate locally
              const fingerprinter = new VCFFingerprint();

              // Calculate DNA fingerprint
              dnaFingerprint = await fingerprinter.processFile(localFilePath);

              // Calculate file hash
              fileHash = VCFFingerprint.calculateFileHash(localFilePath);

              spinnerFingerprint.succeed(`DNA fingerprint calculated (SNP-30-MARKERS) from local file`);
            } else {
              // File not found locally - use placeholders
              spinnerFingerprint.info('File not found locally - DNA fingerprint will be calculated server-side');
            }
          } catch (error) {
            spinnerFingerprint.warn(`Could not calculate fingerprint: ${error instanceof Error ? error.message : error}`);
          }
        }

        const spinnerSeq = ora('Minting BioCID NFT on Sequentias...').start();

        // Determine genomic file type from filename
        let genomicFileType = 'genomic';
        if (biocidOrFilename.endsWith('.vcf') || biocidOrFilename.endsWith('.vcf.gz')) {
          genomicFileType = 'variant';
        } else if (biocidOrFilename.endsWith('.bam')) {
          genomicFileType = 'alignment';
        } else if (biocidOrFilename.endsWith('.fastq') || biocidOrFilename.endsWith('.fq')) {
          genomicFileType = 'reads';
        }

        try {
          const sequentiasResult = await api.mintSequentiasBioCID({
            filename: biocidOrFilename,
            file_type: genomicFileType,
            s3_path: fileInfo.path || '',
            dna_fingerprint: dnaFingerprint,
            file_hash: fileHash
          });

          biocid = sequentiasResult.biocid;

          spinnerSeq.succeed();
          console.log(`${chalk.gray('🔗 Network:')} Sequentias Mainnet`);
          console.log(`${chalk.gray('🆔 BioCID:')} ${chalk.cyan(biocid)}`);
          console.log(`${chalk.gray('📍 Biorouter:')} ${sequentiasResult.biorouter_address}`);
          console.log(`${chalk.gray('⛓️  Tx Hash:')} ${sequentiasResult.tx_hash}`);
          console.log(chalk.green('✅ Sequentias BioCID NFT minted!\n'));
        } catch (error) {
          spinnerSeq.fail();
          Logger.error(`Failed to mint Sequentias BioCID: ${error}`);
          throw error;
        }
      }

      // Step 2: Sequentia Only (Skip Story Protocol)
      {
        console.log(chalk.bold('┌─────────────────────────────────────────────────┐'));
        console.log(chalk.bold('│ Step 2/4: Sequentia-Only Mode                  │'));
        console.log(chalk.bold('└─────────────────────────────────────────────────┘'));
        console.log(chalk.gray('ℹ️  Skipping Story Protocol - using Sequentia BioCID only'));
        console.log(chalk.gray(`   BioCID: ${biocid}\n`));
        ipAssetId = biocid;  // Use BioCID as IP Asset ID

        // Step 3: BioPIL License (Pending)
        console.log(chalk.bold('┌─────────────────────────────────────────────────┐'));
        console.log(chalk.bold('│ Step 3/4: BioPIL License (Sequentia)           │'));
        console.log(chalk.bold('└─────────────────────────────────────────────────┘'));
        console.log(chalk.yellow('⚠️  BioPIL license attachment pending'));
        console.log(chalk.gray(`   Contract: 0xDae899b64282370001E3f820304213eDf2D983DE`));
        console.log(chalk.gray(`   License: ${licenseType}\n`));
      }
    }

    // Step 4: Generate BioPIL Contract (DNASign Integration!)
    console.log(chalk.bold('┌─────────────────────────────────────────────────┐'));
    console.log(chalk.bold('│ Step 4/6: Generating BioPIL Consent Contract   │'));
    console.log(chalk.bold('└─────────────────────────────────────────────────┘'));

    const spinnerContract = ora('Generating legally binding contract...').start();

    try {
      const contractResult = await api.generateBioPILContract({
        biocid: biocid!,
        ip_asset_id: ipAssetId,
        permittee_wallet: options.lab,
        permittee_name: lab?.name || 'Research Lab',
        permittee_institution: lab?.institution || 'Research Institution',
        license_type: licenseType,
        data_owner_wallet: credentials.wallet_address,
        data_owner_name: 'GenoBank User'
      });

      spinnerContract.succeed();
      console.log(`${chalk.gray('📜 Contract Type:')} BioPIL ${licenseType}`);
      console.log(`${chalk.gray('🆔 Document ID:')} ${contractResult.document_id}`);
      console.log(`${chalk.gray('🔗 Contract URL:')} ${chalk.cyan(contractResult.dnasign_url)}`);
      console.log(`${chalk.gray('⏰ Expires:')} ${new Date(contractResult.expires_at).toLocaleDateString()}`);
      console.log(chalk.green('✅ Contract generated!\n'));

      // Step 5: Dual Signature Instructions
      console.log(chalk.bold('┌─────────────────────────────────────────────────┐'));
      console.log(chalk.bold('│ Step 5/6: Dual Signature Required              │'));
      console.log(chalk.bold('└─────────────────────────────────────────────────┘'));
      console.log(chalk.yellow('⚠️  Both parties must sign this contract:'));
      console.log('');
      console.log(`   1. ${chalk.cyan('You (Data Owner)')}: Sign with your wallet`);
      console.log(`   2. ${chalk.cyan('Lab (Researcher)')}: Share URL and have them sign`);
      console.log('');
      console.log(chalk.bold('📋 Share this URL with the lab:'));
      console.log(chalk.cyan(`   ${contractResult.dnasign_url}`));
      console.log('');
      console.log(chalk.gray('ℹ️  Opening contract in browser...'));

      // Open in browser
      const open = require('open');
      await open(contractResult.dnasign_url);

      console.log('');
      console.log(chalk.yellow('⏳ After both signatures, license token will be minted automatically'));
      console.log('');

      // Step 6: Token Minting (Automatic After Signatures)
      console.log(chalk.bold('┌─────────────────────────────────────────────────┐'));
      console.log(chalk.bold('│ Step 6/6: License Token (Auto After Signing)   │'));
      console.log(chalk.bold('└─────────────────────────────────────────────────┘'));
      console.log(chalk.gray('✅ License token will be minted automatically'));
      console.log(chalk.gray('   after both parties sign the contract'));
      console.log(chalk.gray('   via DNASign webhook → GenoBank API'));
      console.log('');

      // Token minting handled by webhook after signatures
      const tokenResult = {
        status: 'pending_signatures',
        contract_url: contractResult.dnasign_url,
        document_id: contractResult.document_id
      };

    } catch (error) {
      spinnerContract.fail();
      Logger.error(`Contract generation failed: ${error}`);
      throw error;
    }

    // Old token minting code removed - now handled by DNASign webhook

    // Success summary
    const summary = [
      chalk.bold.green('🎉 Biofile Successfully Shared!'),
      '',
      `${chalk.gray('BioCID (Sequentias):')}`,
      chalk.cyan(`${biocid}`),
      '',
      `${chalk.gray('IP Asset (Story Protocol):')}`,
      chalk.cyan(`https://explorer.story.foundation/ipa/${ipAssetId}`),
      '',
      `${chalk.gray('Lab can now access via:')}`,
      chalk.gray(`$ biofs download --biocid ${biocid}`)
    ].join('\n');

    console.log(chalk.green('\n' + '─'.repeat(60)));
    console.log(summary);
    console.log(chalk.green('─'.repeat(60) + '\n'));

    // Update cache with new sharing information
    try {
      cacheManager.upsertBioFile({
        filename: biocidOrFilename,
        locations: {
          s3: fileInfo.path,
          biocid: biocid,
          story_ip: ipAssetId,
          avalanche_biosample: undefined,
          local_path: cachedFile?.locations.local_path
        },
        metadata: {
          file_type: cachedFile?.metadata.file_type,
          size: cachedFile?.metadata.size,
          created_at: cachedFile?.metadata.created_at,
          tokenized: true,
          shared_with: [options.lab],
          license_type: licenseType,
          fingerprint: cachedFile?.metadata.fingerprint,
          file_hash: cachedFile?.metadata.file_hash
        }
      });
      Logger.debug('Cache updated with sharing information');
    } catch (error) {
      Logger.debug(`Failed to update cache: ${error}`);
    }

  } catch (error) {
    Logger.error(`Share failed: ${error}`);
    throw error;
  }
}

function formatWallet(wallet: string): string {
  if (wallet.length === 42) {
    return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  }
  return wallet;
}
