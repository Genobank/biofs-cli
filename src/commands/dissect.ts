import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';

export interface DissectOptions {
  share?: string;        // Wallet address to share with
  license?: string;      // License type
  minSnps?: number;      // Minimum SNPs to discover
  output?: string;       // Optional output path
  verbose?: boolean;
  debug?: boolean;
}

export async function dissectCommand(
  phenotypeQuery: string,
  sourceFile: string,
  options: DissectOptions
): Promise<void> {
  const spinner = ora('Initializing dissect command...').start();

  try {
    // Initialize API client
    const api = GenoBankAPIClient.getInstance();

    // Call dissect_and_share endpoint
    spinner.text = `Querying genomics databases with Claude Sonnet 4.5...`;

    const result = await api.dissectAndShare({
      phenotype_query: phenotypeQuery,
      source_file: sourceFile,
      share_with: options.share,
      license_type: options.license || 'non_commercial_social_remixing',
      min_snps: options.minSnps || 10
    });

    if (result.status === 'Failure') {
      spinner.fail(chalk.red(`Error: ${result.status_details.message}`));
      process.exit(1);
    }

    const data = result.status_details;

    // Success output
    spinner.succeed(chalk.green('✅ SNP Subset Successfully Created!'));

    console.log('');
    console.log(chalk.bold('📊 Discovered SNPs:'));
    console.log(chalk.gray(`   Found ${data.snps_found} clinically validated SNPs`));
    console.log(chalk.gray(`   Extracted ${data.snps_extracted} SNPs from source file`));

    console.log('');
    console.log(chalk.bold('📄 SNP Details:'));
    const snpsToShow = data.snp_list ? data.snp_list.slice(0, 5) : [];
    snpsToShow.forEach((snp: any, i: number) => {
      console.log(chalk.cyan(`   ${i + 1}. ${snp.rsid}`) +
        chalk.gray(` (${snp.chromosome}) - ${snp.gene} - ${snp.phenotype}`));
    });
    if (data.snps_found > 5) {
      console.log(chalk.gray(`   ... and ${data.snps_found - 5} more`));
    }

    console.log('');
    console.log(chalk.bold('🎨 Tokenization:'));
    console.log(chalk.gray(`   BioCID: ${data.derivative_biocid}`));
    console.log(chalk.gray(`   IP Asset: ${data.derivative_ip_id}`));
    console.log(chalk.gray(`   Parent IP: ${data.parent_ip_id || 'None'}`));

    if (options.share && data.shared_with) {
      console.log('');
      console.log(chalk.bold('🤝 Sharing:'));
      console.log(chalk.gray(`   Shared with: ${data.shared_with}`));
      console.log(chalk.gray(`   License: ${data.license_type}`));
    }

    console.log('');
    console.log(chalk.bold('📋 GDPR Compliance:'));
    console.log(chalk.gray(`   Purpose: Data Minimization ✅`));
    console.log(chalk.gray(`   Only ${data.snps_extracted} phenotype-specific SNPs shared`));

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red(`Error: ${error.message}`));
    if (options.debug) {
      console.error(error);
    }
    process.exit(1);
  }
}


