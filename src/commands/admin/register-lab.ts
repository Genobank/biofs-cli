/**
 * Admin Register Lab Command - Sequentia Network (v2.0)
 *
 * Onboards new research labs by calling GenoBank's unified /register_lab API:
 * 1. Extracts lab info from website
 * 2. Generates custodial wallet (or accepts user wallet)
 * 3. Stores in MongoDB 'labs' collection
 * 4. Mints LabNFT on Sequentia blockchain
 *
 * This command now delegates to the GenoBank API for consistency
 * across all registration channels (CLI, web interface, admin dashboard).
 *
 * @author GenoBank.io - BioFS CLI Team
 * @version 2.0 - Unified API Integration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import axios from 'axios';
import * as dotenv from 'dotenv';

// Load environment variables (try production API path, then local)
const envPath = process.env.BIOFS_ENV_PATH || '/home/ubuntu/Genobank_APIs/production_api/.env';
dotenv.config({ path: envPath });

// GenoBank API Configuration
const GENOBANK_API = process.env.GENOBANK_API_URL || 'https://genobank.app';

// Helper to get admin signature (checked inside command action, not at module load)
function getAdminSignature(): string {
  const sig = process.env.ADMIN_SIGNATURE;
  if (!sig) {
    console.error(chalk.red('\n❌ Error: ADMIN_SIGNATURE environment variable not set'));
    console.error(chalk.gray('   This command requires admin privileges'));
    console.error(chalk.gray('   Set ADMIN_SIGNATURE environment variable or BIOFS_ENV_PATH'));
    process.exit(1);
  }
  return sig;
}

// Sequentia Network Configuration (for display)
const SEQUENTIA_CONFIG = {
  chainId: parseInt(process.env.SEQUENTIA_CHAIN_ID || '15132025'),
  network: 'sequentia',
  labnftContract: '0x24f42752F491540e305384A5C947911649C910CF',
};

interface RegisterLabOptions {
  name?: string;
  email?: string;
  specialization?: string;
  location?: string;
  wallet?: string;
  labType?: string;
  autoApprove?: boolean;
  yes?: boolean;
}

/**
 * Extract lab information from website using GenoBank API
 */
async function extractWebsiteBranding(websiteUrl: string): Promise<any> {
  try {
    const response = await axios.post(
      `${GENOBANK_API}/api_lab_customization/extract_website_branding`,
      {
        website_url: websiteUrl,
        user_signature: getAdminSignature(),
        laboratory_id: 'CLI_REGISTRATION'
      }
    );

    if (response.data && response.data.status === 'Success') {
      return response.data.data || {};
    } else {
      console.warn(chalk.yellow('⚠️  Website extraction returned no data, will use manual inputs'));
      return {};
    }
  } catch (error: any) {
    console.warn(chalk.yellow(`⚠️  Website extraction failed: ${error.message}`));
    return {};
  }
}

/**
 * Register lab via unified GenoBank API
 */
async function registerLabViaAPI(labData: any): Promise<any> {
  try {
    const response = await axios.post(
      `${GENOBANK_API}/register_lab`,
      labData,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.status === 'Success') {
      return response.data.status_details?.data || {};
    } else {
      throw new Error(response.data?.status_details?.message || 'Registration failed');
    }
  } catch (error: any) {
    if (error.response?.data?.status_details?.message) {
      throw new Error(error.response.data.status_details.message);
    }
    throw new Error(`API request failed: ${error.message}`);
  }
}

/**
 * Main registration function
 */
export async function registerLab(
  websiteUrl: string,
  options: RegisterLabOptions
): Promise<void> {
  const spinner = ora();

  try {
    console.log(chalk.cyan.bold('\n🧬 BioFS Lab Registration - Sequentia Network v2.0\n'));

    // Validate inputs
    if (!websiteUrl || !websiteUrl.startsWith('http')) {
      throw new Error('Invalid website URL. Must start with http:// or https://');
    }

    // Step 1: Extract lab info from website
    spinner.start('Extracting lab information from website...');
    const extracted = await extractWebsiteBranding(websiteUrl);
    spinner.succeed('Website analysis complete');

    const labInfo = {
      name: options.name || extracted.company_name || extracted.lab_name || 'Unknown Lab',
      email: options.email || extracted.email || extracted.contact_email || '',
      specialization: options.specialization || extracted.research_focus || extracted.specialization || 'Genomic Research',
      location: options.location || extracted.location || '',
      website: websiteUrl,
      lab_type: options.labType?.toUpperCase() || 'LAB', // LAB, RESEARCHER, or INSTITUTION
      wallet_address: options.wallet || undefined, // If provided, uses user's wallet; otherwise generates custodial
      mint_nft: true // Always mint LabNFT
    };

    // Display extracted info
    console.log('\n' + chalk.cyan('📋 Lab Information:'));
    console.log(chalk.gray('  Name:'), chalk.white(labInfo.name));
    console.log(chalk.gray('  Type:'), chalk.white(labInfo.lab_type));
    console.log(chalk.gray('  Website:'), chalk.white(websiteUrl));
    console.log(chalk.gray('  Email:'), chalk.white(labInfo.email || 'Not found'));
    console.log(chalk.gray('  Specialization:'), chalk.white(labInfo.specialization));
    console.log(chalk.gray('  Location:'), chalk.white(labInfo.location || 'Not specified'));
    if (labInfo.wallet_address) {
      console.log(chalk.gray('  Wallet:'), chalk.white(labInfo.wallet_address));
      console.log(chalk.yellow('  Note: Using provided wallet (not custodial)'));
    } else {
      console.log(chalk.green('  Wallet: Custodial wallet will be generated'));
    }

    // Confirm with user unless --yes flag
    if (!options.yes) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Do you want to proceed with registration?',
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('Registration cancelled'));
        process.exit(0);
      }
    }

    // Step 2: Register via unified API
    spinner.start('Registering lab via GenoBank API...');
    const result = await registerLabViaAPI(labInfo);
    spinner.succeed('Lab registration complete');

    // Display results
    console.log(chalk.green.bold('\n✅ Lab registered successfully on Sequentia Network!\n'));
    console.log(chalk.cyan('Lab Details:'));
    console.log(chalk.gray('  🏥 Lab:'), chalk.white(result.name || labInfo.name));
    console.log(chalk.gray('  🏢 Type:'), chalk.white(labInfo.lab_type));
    console.log(chalk.gray('  🔗 Website:'), chalk.white(websiteUrl));
    console.log(chalk.gray('  👛 Wallet:'), chalk.white(result.wallet_address));
    console.log(chalk.gray('  🔐 Wallet Type:'), chalk.white(result.wallet_type || 'N/A'));

    // Display wallet credentials for custodial wallets
    if (result.wallet_type === 'custodial_generated') {
      console.log(chalk.yellow('\n🔑 Custodial Wallet Credentials:'));
      console.log(chalk.gray('  Private Key:'), chalk.white(result.private_key || '(stored in MongoDB)'));
      console.log(chalk.gray('  Mnemonic:'), chalk.white(result.mnemonic || '(stored in MongoDB)'));
      console.log(chalk.yellow('  ⚠️  Keep these credentials secure!'));
      console.log(chalk.gray('  Lab can claim this wallet via email verification'));
    }

    // Display LabNFT info
    if (result.labnft) {
      console.log(chalk.cyan('\n🎫 LabNFT Details:'));
      console.log(chalk.gray('  Serial:'), chalk.white(`#${result.labnft.serial}`));
      console.log(chalk.gray('  Contract:'), chalk.white(result.labnft.contract || SEQUENTIA_CONFIG.labnftContract));
      console.log(chalk.gray('  TX Hash:'), chalk.white(result.labnft.tx_hash));
      console.log(chalk.gray('  Block:'), chalk.white(result.labnft.block_number));
    }

    // Display additional info
    console.log(chalk.cyan('\n📋 Additional Info:'));
    console.log(chalk.gray('  📧 Email:'), chalk.white(labInfo.email || 'N/A'));
    console.log(chalk.gray('  🧬 Specialization:'), chalk.white(labInfo.specialization));
    console.log(chalk.gray('  📍 Location:'), chalk.white(labInfo.location || 'N/A'));
    console.log(chalk.gray('  🌐 Network:'), chalk.white(`Sequentia (Chain ID: ${SEQUENTIA_CONFIG.chainId})`));
    console.log(chalk.gray('  📋 Status:'), options.autoApprove ? chalk.green('Verified ✅') : chalk.yellow('Pending verification ⏳'));
    console.log(chalk.gray('  🆔 Lab ID:'), chalk.white(result.lab_id || 'N/A'));

    // Next steps
    console.log(chalk.cyan('\n💡 Next Steps:'));
    console.log(chalk.gray('  Lab can now receive BioNFT-licensed data:'));
    console.log(chalk.white(`  $ biofs share <file> --lab ${result.wallet_address} --license non-commercial`));
    console.log(chalk.gray('  Verify LabNFT on-chain:'));
    console.log(chalk.white(`  $ biofs lab verify ${result.wallet_address}`));
    console.log(chalk.gray('  View in admin dashboard:'));
    console.log(chalk.white(`  https://admin.genobank.io`));

  } catch (error: any) {
    spinner.fail('Registration failed');
    console.error(chalk.red(`\n❌ Error: ${error.message}`));

    if (process.env.DEBUG) {
      console.error(chalk.gray('\nStack trace:'));
      console.error(error.stack);
    }

    process.exit(1);
  }
}

/**
 * Create the register-lab command
 */
export function createRegisterLabCommand(): Command {
  return new Command('register-lab')
    .description('Register a new research lab with LabNFT minting on Sequentia Network')
    .argument('<website_url>', 'Lab website URL (e.g., https://novogene.com)')
    .option('--name <string>', 'Override lab name')
    .option('--email <string>', 'Contact email')
    .option('--specialization <string>', 'Research specialization')
    .option('--location <string>', 'Lab location')
    .option('--wallet <string>', 'Use existing wallet (otherwise generates custodial)')
    .option('--lab-type <string>', 'Lab type: LAB, RESEARCHER, or INSTITUTION (default: LAB)')
    .option('--auto-approve', 'Skip verification step')
    .option('--yes', 'Auto-confirm prompts')
    .action(async (websiteUrl: string, options: RegisterLabOptions) => {
      await registerLab(websiteUrl, options);
    });
}

