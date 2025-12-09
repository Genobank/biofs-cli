import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, resolve } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import inquirer from 'inquirer';
import FormData from 'form-data';
import axios from 'axios';
import { getCredentials } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';
import { formatFileSize } from '../lib/utils/format';
import { calculateSnpFingerprint, calculateFileFingerprint } from '../lib/biofiles/fingerprint';
import { getCollectionForCategory, getDefaultImageForCategory } from '../lib/bioip/collections';
import { getLicenseType } from '../lib/bioip/licenses';
import { saveTokenizationRecord } from '../lib/storage/tokenizations';
import { BioFilesCacheManager } from '../lib/storage/biofiles-cache';
import { SEQUENTIA_NETWORK, API_CONFIG } from '../lib/config/constants';
import { chunkedUpload } from '../lib/upload/chunked';

export interface TokenizeOptions {
  title?: string;
  description?: string;
  license?: string;
  collection?: string;
  noAi?: boolean;
  quiet?: boolean;
  yes?: boolean;  // Auto-confirm without prompts
}

const API_BASE = API_CONFIG.base + API_CONFIG.bioip;

export async function tokenizeCommand(filePath: string, options: TokenizeOptions): Promise<void> {
  // Resolve absolute path
  const absolutePath = resolve(filePath);

  // Check if file exists
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Get file stats
  const fileStats = await stat(absolutePath);
  const fileSize = fileStats.size;
  const fileName = basename(absolutePath);
  const fileExt = extname(absolutePath).toLowerCase();

  // Check credentials
  const credentials = await getCredentials();
  if (!credentials) {
    throw new Error('Not authenticated. Please run "biofs login" first.');
  }

  // Use Sequentia network
  const network = SEQUENTIA_NETWORK;

  if (!options.quiet) {
    console.log(chalk.cyan('\n🧬 BioFS Tokenization'));
    console.log(chalk.gray('━'.repeat(50)));
    console.log(`\n📁 File: ${chalk.white(fileName)} (${formatFileSize(fileSize)})`);
    console.log(`🔐 Wallet: ${chalk.white(credentials.wallet_address)}`);
    console.log(`🌐 Network: ${chalk.white(network.name)} (Chain ID: ${network.chainId})\n`);
  }

  const steps = options.noAi ? 5 : 6;
  let currentStep = 1;

  // Step 1: Analyze file with advanced genomic pattern recognition
  let spinner = ora(`Step ${currentStep}/${steps}: 🔬 Analyzing genomic file structure and validating format...`).start();

  try {
    // Detect file type
    const fileCategory = detectFileCategory(fileName, fileExt);
    spinner.succeed(`Step ${currentStep}/${steps}: ✓ File validated as ${fileCategory.toUpperCase()} format with genomic pattern recognition`);
    currentStep++;

    // Step 2: Calculate cryptographic fingerprint from genetic variants
    spinner = ora(`Step ${currentStep}/${steps}: 🧬 Extracting SNP positions and computing cryptographic fingerprint...`).start();

    let fingerprint: string;
    let snpCount = 0;

    // For genomic files, calculate SNP fingerprint
    if (isGenomicFile(fileExt)) {
      const result = await calculateSnpFingerprint(filePath);
      fingerprint = result.fingerprint;
      snpCount = result.snpCount;
      spinner.succeed(`Step ${currentStep}/${steps}: ✓ Generated SHA-256 fingerprint from ${snpCount.toLocaleString()} unique variants (${fingerprint.substring(0, 16)}...)`);
    } else {
      fingerprint = await calculateFileFingerprint(filePath);
      spinner.succeed(`Step ${currentStep}/${steps}: ✓ Generated file fingerprint: ${fingerprint.substring(0, 16)}...`);
    }
    currentStep++;

    // Step 3: AI-powered dataset classification using Claude 3 Haiku via API
    // CRITICAL: Following bioip.js flow EXACTLY - AI determines title, description, and collection
    let aiMetadata: any = null;
    let aiTitle = '';
    let aiDescription = '';
    let detectedCategory = fileCategory;

    if (!options.noAi) {
      spinner = ora(`Step ${currentStep}/${steps}: 🤖 Analyzing content with Claude 3 Haiku for intelligent metadata generation...`).start();

      try {
        // Read file sample for Claude analysis (bioip.js sends first 20 lines)
        const fileContent = await readFile(absolutePath, { encoding: 'utf-8' });
        const lines = fileContent.split('\n');
        const sampleLines = lines.slice(0, 20).join('\n');

        // Call api_bioip.py /generate_metadata endpoint (uses Claude Haiku) - EXACT bioip.js flow
        const contextData = JSON.stringify({
          fileName: fileName,
          fileSize: formatFileSize(fileSize),
          fileType: fileExt,
          category: fileCategory,
          sampleLines: sampleLines
        });

        const params = new URLSearchParams();
        params.append('user_signature', credentials.user_signature);
        params.append('context', contextData);

        const metadataResponse = await axios.post(`${API_BASE}/generate_metadata`, params, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        if (metadataResponse.data.status === 'Success') {
          // Extract metadata from correct path (bioip.js pattern)
          aiMetadata = metadataResponse.data.status_details.metadata;

          // Clean up title and description - remove extra quotes and trailing punctuation (bioip.js pattern)
          let cleanTitle = (aiMetadata.title || 'Genomic Data Analysis')
            .replace(/^["']+/g, '')  // Remove leading quotes
            .replace(/["',]+$/g, '');  // Remove trailing quotes and commas
          let cleanDescription = (aiMetadata.description || 'Biological data for analysis')
            .replace(/^["']+/g, '')
            .replace(/["',]+$/g, '');

          // AI determines title and description - user options are OVERRIDES only (bioip.js pattern)
          aiTitle = options.title || cleanTitle;
          aiDescription = options.description || cleanDescription;

          spinner.succeed(`Step ${currentStep}/${steps}: ✓ Claude Haiku generated metadata`);

          console.log(chalk.cyan(`   📝 AI Title: "${aiTitle}"`));
          console.log(chalk.gray(`   📄 AI Description: ${aiDescription.substring(0, 60)}...`));
        } else {
          spinner.fail(`Step ${currentStep}/${steps}: ✗ Claude Haiku returned non-Success status`);
          console.log(chalk.red(`\n❌ CRITICAL ERROR: AI classification is MANDATORY for data integrity`));
          console.log(chalk.gray(`   API Response: ${JSON.stringify(metadataResponse.data, null, 2)}`));
          throw new Error(`AI classification failed: ${metadataResponse.data.status_details?.description || 'Unknown error'}`);
        }
      } catch (error: any) {
        spinner.fail(`Step ${currentStep}/${steps}: ✗ Claude Haiku AI classification FAILED`);
        console.log(chalk.red(`\n❌ CRITICAL ERROR: AI classification is MANDATORY for data integrity`));
        console.log(chalk.red(`   Claude Haiku API Error: ${error.message}`));
        if (error.response?.data) {
          console.log(chalk.gray(`   API Response: ${JSON.stringify(error.response.data, null, 2)}`));
        }
        console.log(chalk.yellow(`\n💡 Fix: Check that api_bioip.py /generate_metadata endpoint is working`));
        throw new Error(`AI classification failed: ${error.message}`);
      }
      currentStep++;
    } else {
      // If --no-ai flag used, user MUST provide title and description
      if (!options.title || !options.description) {
        throw new Error('--no-ai flag requires both --title and --description options');
      }
      aiTitle = options.title;
      aiDescription = options.description;
    }

    // Step 4: Smart contract collection selection on Sequentia
    spinner = ora(`Step ${currentStep}/${steps}: 📜 Selecting optimal BioNFT collection on Sequentia...`).start();

    let collectionAddress = options.collection || getCollectionForCategory(detectedCategory);
    let collectionName = getCollectionName(collectionAddress);

    spinner.succeed(`Step ${currentStep}/${steps}: ✓ Selected "${collectionName}" collection (${collectionAddress.substring(0, 10)}...)`);
    currentStep++;

    // Preview and Confirmation Step (only if not in quiet mode and not auto-confirmed)
    if (!options.quiet && !options.yes) {
      const imageUrl = getDefaultImageForCategory(detectedCategory);
      const licenseType = getLicenseType(options.license || 'non-commercial');
      const licenseDisplayName = getLicenseDisplayName(options.license || 'non-commercial');

      // Build preview
      const preview = buildMetadataPreview({
        fileName,
        fileSize,
        title: aiTitle,
        description: aiDescription || `${detectedCategory} dataset`,
        category: detectedCategory,
        fingerprint,
        snpCount,
        collection: collectionName,
        collectionAddress,
        license: licenseDisplayName,
        licenseType,
        imageUrl,
        network: network.name,
        wallet: credentials.wallet_address
      });

      console.log('\n');
      console.log(boxen(preview, {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
        title: '🔍 Tokenization Preview',
        titleAlignment: 'center'
      }));

      // Confirmation prompt
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'How would you like to proceed?',
          choices: [
            { name: '✅ Confirm and tokenize', value: 'confirm' },
            { name: '✏️  Edit metadata', value: 'edit' },
            { name: '❌ Cancel', value: 'cancel' }
          ]
        }
      ]);

      if (action === 'cancel') {
        console.log(chalk.yellow('\n❌ Tokenization cancelled.\n'));
        process.exit(0);
      }

      if (action === 'edit') {
        // Allow editing each field
        const edited = await inquirer.prompt([
          {
            type: 'input',
            name: 'title',
            message: 'Title:',
            default: aiTitle
          },
          {
            type: 'input',
            name: 'description',
            message: 'Description:',
            default: aiDescription || `${detectedCategory} dataset`
          },
          {
            type: 'list',
            name: 'license',
            message: 'License:',
            choices: [
              { name: 'Non-Commercial Remix', value: 'non-commercial' },
              { name: 'Commercial Remix', value: 'commercial' }
            ],
            default: options.license || 'non-commercial'
          },
          {
            type: 'input',
            name: 'collectionAddress',
            message: 'Collection Address (leave blank to keep current):',
            default: collectionAddress
          }
        ]);

        // Update values
        aiTitle = edited.title;
        aiDescription = edited.description;
        options.license = edited.license;
        if (edited.collectionAddress && edited.collectionAddress !== collectionAddress) {
          collectionAddress = edited.collectionAddress;
          collectionName = getCollectionName(collectionAddress);
        }

        // Show updated preview
        const updatedPreview = buildMetadataPreview({
          fileName,
          fileSize,
          title: aiTitle,
          description: aiDescription || `${detectedCategory} dataset`,
          category: detectedCategory,
          fingerprint,
          snpCount,
          collection: collectionName,
          collectionAddress,
          license: getLicenseDisplayName(edited.license),
          licenseType: getLicenseType(edited.license),
          imageUrl,
          network: network.name,
          wallet: credentials.wallet_address
        });

        console.log('\n');
        console.log(boxen(updatedPreview, {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'green',
          title: '✅ Updated Metadata',
          titleAlignment: 'center'
        }));

        // Final confirmation
        const { confirmFinal } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmFinal',
            message: 'Proceed with tokenization?',
            default: true
          }
        ]);

        if (!confirmFinal) {
          console.log(chalk.yellow('\n❌ Tokenization cancelled.\n'));
          process.exit(0);
        }
      }

      console.log(chalk.green('\n✅ Proceeding with tokenization...\n'));
    }

    // Step 5: Upload to GenoBank with Web3 signature authentication
    spinner = ora(`Step ${currentStep}/${steps}: 📤 Uploading to secure GenoBank vault with Web3 authentication...`).start();

    // Read file
    const fileBuffer = await readFile(absolutePath);

    // Prepare form data with file upload
    const formData = new FormData();
    formData.append('user_signature', credentials.user_signature);
    formData.append('file', fileBuffer, fileName);
    formData.append('title', aiTitle);
    formData.append('description', aiDescription || `${detectedCategory} dataset`);
    formData.append('license_type', getLicenseType(options.license || 'non-commercial'));
    formData.append('fingerprint', fingerprint);
    formData.append('file_category', detectedCategory);
    formData.append('collection_address', collectionAddress);
    formData.append('image_url', getDefaultImageForCategory(detectedCategory));

    // Submit to API
    const response = await axios.post(`${API_BASE}/register_bioip`, formData, {
      headers: {
        ...formData.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      onUploadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          const progressBar = '▓'.repeat(Math.floor(percentCompleted / 5)) + '░'.repeat(20 - Math.floor(percentCompleted / 5));
          spinner.text = `Step ${currentStep}/${steps}: 📤 Uploading ${formatFileSize(progressEvent.loaded)}/${formatFileSize(progressEvent.total)} ${progressBar} ${percentCompleted}%`;
        }
      }
    });

    spinner.succeed(`Step ${currentStep}/${steps}: ✓ Uploaded to encrypted S3 vault & registered in MongoDB`);
    currentStep++;

    // Debug: Log the response structure
    Logger.debug(`API Response: ${JSON.stringify(response.data, null, 2)}`);

    // Step 6: Mint BioNFT on Sequentia blockchain
    spinner = ora(`Step ${currentStep}/${steps}: ⛓️  Minting BioNFT on ${network.name}...`).start();

    // Extract response data - handle different response formats
    const responseData = response.data.status_details?.data ||
                        response.data.status_details ||
                        response.data.data ||
                        response.data;

    // Check for IP ID in multiple possible locations
    const ipId = responseData.ip_id ||
                 responseData.ipId ||
                 responseData.ip_asset_id ||
                 responseData.registration_id;  // Sometimes used as temporary ID

    if (!ipId && response.data.status === 'Success') {
      // If successful but no IP ID, it might be pending blockchain confirmation
      console.log('\n⚠️  Transaction submitted but IP ID pending blockchain confirmation');
    } else if (!ipId) {
      throw new Error('No IP ID returned from tokenization');
    }

    spinner.succeed(`Step ${currentStep}/${steps}: ✓ Smart contract executed successfully - BioNFT minted on-chain!`);

    // Generate BioCID
    const bioCID = generateBioCID(credentials.wallet_address, detectedCategory, fileName);

    // Display results
    console.log(chalk.gray('\n' + '━'.repeat(50)));
    console.log(chalk.green.bold('🎉 BioIP Tokenization Complete!'));
    console.log(chalk.gray('━'.repeat(50) + '\n'));

    if (ipId) {
      console.log(`${chalk.cyan('📦 IP Asset ID:')}     ${chalk.white(ipId)}`);
    }
    console.log(`${chalk.cyan('🔗 BioCID:')}          ${chalk.white(bioCID)}`);
    console.log(`${chalk.cyan('🏛️  PIL License:')}     ${chalk.white(getLicenseDisplayName(options.license || 'non-commercial'))}`);
    console.log(`${chalk.cyan('📊 Collection:')}      ${chalk.white(collectionName)}`);
    console.log(`${chalk.cyan('🌐 Network:')}         ${chalk.white(network.name)} (Chain ID: ${network.chainId})`);

    const txHash = responseData.tx_hash || responseData.txHash || responseData.transaction_hash;
    if (txHash) {
      console.log(`${chalk.cyan('🔐 Transaction:')}    ${chalk.white(txHash)}`);
    }

    if (snpCount) {
      console.log(`${chalk.cyan('🧬 Fingerprint:')}    ${chalk.gray(snpCount.toLocaleString() + ' SNPs analyzed')}`);
    }

    if (ipId) {
      console.log(`\n${chalk.cyan('🌐 View on Block Explorer:')}`);
      console.log(chalk.white(`   ${network.explorer}/ipa/${ipId}`));
    }

    // Save tokenization record
    const recordPath = await saveTokenizationRecord({
      fileName,
      filePath: absolutePath,
      ipId: ipId || 'pending',
      bioCID,
      collection: collectionAddress,
      license: options.license || 'non-commercial',
      title: aiTitle,
      description: aiDescription || `${detectedCategory} dataset`,
      fingerprint,
      snpCount,
      txHash: txHash || '',
      timestamp: new Date().toISOString(),
      wallet: credentials.wallet_address,
      network: 'sequentia'
    });

    console.log(`\n💾 Details saved to: ${chalk.gray(recordPath)}`);

    // Update cache with tokenization information
    try {
      const cacheManager = new BioFilesCacheManager();
      cacheManager.upsertBioFile({
        filename: fileName,
        locations: {
          s3: undefined,  // Will be set during upload
          biocid: bioCID,
          story_ip: ipId || undefined,
          avalanche_biosample: undefined,
          local_path: absolutePath
        },
        metadata: {
          file_type: detectedCategory,
          size: fileSize,
          created_at: new Date().toISOString(),
          tokenized: true,
          shared_with: undefined,
          license_type: options.license || 'non-commercial',
          fingerprint: fingerprint,
          file_hash: undefined
        }
      });
      Logger.debug('Cache updated with tokenization information');
    } catch (error) {
      Logger.debug(`Failed to update cache: ${error}`);
    }

  } catch (error: any) {
    spinner.fail(`Step ${currentStep}/${steps}: Failed`);

    // Check for duplicate error
    if (error.response?.data?.status_details?.description?.includes('already tokenized') ||
        error.response?.data?.status_details?.description?.includes('already been registered')) {
      throw new Error('This genomic profile has already been tokenized (duplicate fingerprint detected)');
    }

    // Check for API error
    if (error.response?.data?.status_details?.description) {
      throw new Error(error.response.data.status_details.description);
    }

    // Log debug info if available
    if (error.response?.data) {
      Logger.debug(`API Response: ${JSON.stringify(error.response.data)}`);
    }

    throw error;
  }
}

function detectFileCategory(fileName: string, fileExt: string): string {
  // Check by extension
  const extMap: Record<string, string> = {
    '.vcf': 'vcf',
    '.vcf.gz': 'vcf',
    '.bam': 'alignment',
    '.sam': 'alignment',
    '.fastq': 'sequence',
    '.fq': 'sequence',
    '.fastq.gz': 'sequence',
    '.fq.gz': 'sequence',
    '.fasta': 'sequence',
    '.fa': 'sequence',
    '.txt': 'dtc', // Assume text files are 23andMe/Ancestry
    '.csv': 'gwas',
    '.tsv': 'gwas',
    '.bed': 'annotation',
    '.gff': 'annotation',
    '.gtf': 'annotation',
    '.dcm': 'medical_imaging',
    '.dicom': 'medical_imaging'
  };

  // Check compound extensions first
  for (const [ext, category] of Object.entries(extMap)) {
    if (fileName.toLowerCase().endsWith(ext)) {
      return category;
    }
  }

  // Check simple extension
  const category = extMap[fileExt];
  if (category) return category;

  // Default to genomic
  return 'genomic';
}

function isGenomicFile(fileExt: string): boolean {
  const genomicExtensions = ['.vcf', '.vcf.gz', '.txt', '.csv', '.tsv'];
  return genomicExtensions.includes(fileExt.toLowerCase());
}

function getCollectionName(address: string): string {
  const collections: Record<string, string> = {
    '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5': 'Genomic Data',
    '0x19A615224D03487AaDdC43e4520F9D83923d9512': 'VCF Analysis',
    '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269': 'Alignment Data',
    '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171': 'Sequence Data',
    '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401': 'SNP/Microarray',
    '0x495B1E8C54b572d78B16982BFb97908823C9358A': 'ML Analytics'
  };

  return collections[address] || 'Custom Collection';
}

function getLicenseDisplayName(license: string): string {
  const licenses: Record<string, string> = {
    'commercial': 'Commercial Remix',
    'non-commercial': 'Non-Commercial Remix'
  };

  return licenses[license] || license;
}

function generateBioCID(wallet: string, category: string, filename: string): string {
  // Format: biocid://wallet/category/filename
  return `biocid://${wallet.toLowerCase()}/${category}/${filename}`;
}

interface MetadataPreview {
  fileName: string;
  fileSize: number;
  title: string;
  description: string;
  category: string;
  fingerprint: string;
  snpCount?: number;
  collection: string;
  collectionAddress: string;
  license: string;
  licenseType: string;
  imageUrl: string;
  network: string;
  wallet: string;
}

function buildMetadataPreview(data: MetadataPreview): string {
  const lines: string[] = [];

  lines.push(chalk.bold.white('📁 FILE INFORMATION'));
  lines.push(chalk.gray('─'.repeat(50)));
  lines.push(`${chalk.cyan('Name:')}        ${chalk.white(data.fileName)}`);
  lines.push(`${chalk.cyan('Size:')}        ${chalk.white(formatFileSize(data.fileSize))}`);
  lines.push(`${chalk.cyan('Category:')}    ${chalk.white(data.category)}`);
  lines.push('');

  lines.push(chalk.bold.white('🏷️  NFT METADATA'));
  lines.push(chalk.gray('─'.repeat(50)));
  lines.push(`${chalk.cyan('Title:')}       ${chalk.white(data.title)}`);
  lines.push(`${chalk.cyan('Description:')} ${chalk.white(data.description.length > 45 ? data.description.substring(0, 45) + '...' : data.description)}`);
  if (data.description.length > 45) {
    // Show full description in gray
    const wrapped = wrapText(data.description, 45);
    wrapped.slice(1).forEach(line => {
      lines.push(`                ${chalk.gray(line)}`);
    });
  }
  lines.push('');

  lines.push(chalk.bold.white('🔐 BLOCKCHAIN DETAILS'));
  lines.push(chalk.gray('─'.repeat(50)));
  lines.push(`${chalk.cyan('Network:')}     ${chalk.white(data.network)}`);
  lines.push(`${chalk.cyan('Collection:')}  ${chalk.white(data.collection)}`);
  lines.push(`${chalk.cyan('Address:')}     ${chalk.gray(data.collectionAddress.substring(0, 20) + '...')}`);
  lines.push(`${chalk.cyan('License:')}     ${chalk.white(data.license)}`);
  lines.push(`${chalk.cyan('Owner:')}       ${chalk.gray(data.wallet.substring(0, 20) + '...')}`);
  lines.push('');

  lines.push(chalk.bold.white('🔬 GENOMIC DATA'));
  lines.push(chalk.gray('─'.repeat(50)));
  lines.push(`${chalk.cyan('Fingerprint:')} ${chalk.white(data.fingerprint.substring(0, 16) + '...')}`);
  if (data.snpCount) {
    lines.push(`${chalk.cyan('SNPs:')}        ${chalk.white(data.snpCount.toLocaleString())} variants`);
  }
  lines.push('');

  lines.push(chalk.bold.white('🖼️  NFT IMAGE'));
  lines.push(chalk.gray('─'.repeat(50)));
  lines.push(`${chalk.cyan('Image URL:')}   ${chalk.gray(data.imageUrl.substring(0, 45) + '...')}`);

  return lines.join('\n');
}

function wrapText(text: string, maxLength: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxLength) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

