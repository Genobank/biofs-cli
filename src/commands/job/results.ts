import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface JobResultsOptions {
  json?: boolean;   // JSON output format
  step?: number;    // Download specific step only
}

export async function jobResultsCommand(
  jobId: string,
  options: JobResultsOptions = {}
): Promise<void> {
  const spinner = ora('Fetching job results...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    const results = await api.getBioOSJobResults(jobId);

    spinner.stop();

    if (results.status !== 'completed') {
      Logger.error(`Job is not completed yet (status: ${results.status})`);
      console.log(chalk.gray('Check status: ') + chalk.cyan(`biofs job status ${jobId}`));
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log(chalk.bold(`\n📥 Job Results: ${jobId}\n`));

    // Story Protocol lineage
    if (results.ip_lineage && results.ip_lineage.length > 0) {
      console.log(chalk.bold('Story Protocol Lineage:'));
      results.ip_lineage.forEach((ipId: string, index: number) => {
        const isLast = index === results.ip_lineage.length - 1;
        const prefix = isLast ? '└─' : '├─';
        console.log(`${prefix} ${chalk.gray(ipId)}`);
      });
      console.log();
    }

    // Results table
    if (results.results && results.results.length > 0) {
      // Filter by step if specified
      let filteredResults = results.results;
      if (options.step !== undefined) {
        filteredResults = results.results.filter((r: any) => r.step === options.step);
        if (filteredResults.length === 0) {
          Logger.error(`No results found for step ${options.step}`);
          process.exit(1);
        }
      }

      console.log(chalk.bold(`Output Files (${filteredResults.length}):`) + '\n');

      const table = new Table({
        head: [
          chalk.cyan('Step'),
          chalk.cyan('File Type'),
          chalk.cyan('IP Asset ID'),
          chalk.cyan('Download')
        ],
        colWidths: [8, 15, 45, 12]
      });

      filteredResults.forEach((result: any, index: number) => {
        table.push([
          result.step,
          result.file_type || 'N/A',
          result.ip_id || 'N/A',
          chalk.cyan(`[${index + 1}]`)
        ]);
      });

      console.log(table.toString());
      console.log();

      // Download instructions
      console.log(chalk.bold('Download Instructions:'));
      console.log();

      filteredResults.forEach((result: any, index: number) => {
        const num = index + 1;
        console.log(chalk.gray(`  [${num}] Step ${result.step} - ${result.file_type}:`));
        console.log(`      ${chalk.cyan(`curl -o output_step${result.step}.${result.file_type} "${result.download_url}"`)}`);
        console.log();
      });

      // File hashes
      console.log(chalk.bold('File Verification (SHA256):'));
      console.log();

      filteredResults.forEach((result: any, index: number) => {
        if (result.file_hash) {
          console.log(chalk.gray(`  Step ${result.step}:`) + ` ${result.file_hash}`);
        }
      });
      console.log();

      // Additional info
      console.log(chalk.gray('💡 Tip: URLs expire in 1 hour. Use them promptly or re-run this command.'));
      console.log();

    } else {
      console.log(chalk.yellow('No output files found for this job.'));
    }

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to fetch job results'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

