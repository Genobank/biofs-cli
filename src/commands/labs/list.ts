import chalk from 'chalk';
import boxen from 'boxen';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface LabNFTsOptions {
  filter?: string;
  location?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface Lab {
  name: string;
  wallet_address: string;
  specialization?: string;
  location?: string;
  verified: boolean;
  story_protocol_verified: boolean;
  contact_email?: string;
  website?: string;
  description?: string;
}

export async function labNFTsCommand(options: LabNFTsOptions): Promise<void> {
  const api = GenoBankAPIClient.getInstance();

  if (options.verbose) {
    console.log('🔍 Fetching approved research labs...');
  }

  try {
    // Fetch approved labs from both sources
    const labs = await api.getApprovedLabs();

    if (!labs || labs.length === 0) {
      console.log(chalk.yellow('⚠️  No approved labs found in the registry'));
      return;
    }

    // Apply filters
    let filteredLabs = labs;

    if (options.filter) {
      const filterLower = options.filter.toLowerCase();
      filteredLabs = filteredLabs.filter(lab =>
        lab.specialization?.toLowerCase().includes(filterLower) ||
        lab.name.toLowerCase().includes(filterLower)
      );
    }

    if (options.location) {
      const locationLower = options.location.toLowerCase();
      filteredLabs = filteredLabs.filter(lab =>
        lab.location?.toLowerCase().includes(locationLower)
      );
    }

    if (filteredLabs.length === 0) {
      console.log(chalk.yellow(`⚠️  No labs found matching your criteria`));
      return;
    }

    // Output results
    if (options.json) {
      console.log(JSON.stringify(filteredLabs, null, 2));
    } else {
      displayLabsTable(filteredLabs, options.filter, options.location);
    }

  } catch (error) {
    Logger.error(`Failed to fetch approved labs: ${error}`);
    throw error;
  }
}

function displayLabsTable(labs: Lab[], filter?: string, location?: string): void {
  const filterText = filter ? ` matching "${filter}"` : '';
  const locationText = location ? ` in ${location}` : '';

  console.log(chalk.cyan(`\n🏥 Approved Research Labs${filterText}${locationText} (${labs.length})\n`));

  console.log(chalk.gray('These labs are verified to receive BioNFT-licensed genomic data\n'));

  for (const lab of labs) {
    const verificationBadge = lab.story_protocol_verified
      ? chalk.green('✅ Sequentia Verified')
      : chalk.yellow('⚠️  Pending Verification');

    const content = [
      chalk.bold.white(`🏥 ${lab.name}`),
      '',
      `${chalk.gray('Wallet:')} ${chalk.cyan(formatWallet(lab.wallet_address))}`,
      lab.specialization ? `${chalk.gray('Focus:')} ${lab.specialization}` : '',
      lab.location ? `${chalk.gray('Location:')} ${lab.location}` : '',
      '',
      verificationBadge,
    ]
      .filter(Boolean)
      .join('\n');

    const box = boxen(content, {
      padding: 1,
      borderStyle: 'round',
      borderColor: lab.story_protocol_verified ? 'green' : 'yellow',
      margin: { top: 0, right: 0, bottom: 1, left: 0 }
    });

    console.log(box);

    // Show additional info if available
    if (lab.website || lab.contact_email) {
      const contactInfo = [];
      if (lab.website) contactInfo.push(`🌐 ${chalk.blue(lab.website)}`);
      if (lab.contact_email) contactInfo.push(`📧 ${lab.contact_email}`);

      console.log(chalk.gray(`   ${contactInfo.join('  |  ')}\n`));
    }
  }

  // Show usage hint
  console.log(chalk.gray('\n💡 To share a biofile with a lab:'));
  console.log(chalk.gray('   biofs share <filename> --lab <wallet_address> --license non-commercial\n'));
}

function formatWallet(wallet: string): string {
  if (wallet.length === 42) {
    return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  }
  return wallet;
}


