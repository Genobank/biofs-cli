import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import axios from 'axios';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface JobStatusOptions {
  json?: boolean;    // JSON output format
  watch?: boolean;   // Watch mode (refresh every 5 seconds)
  labNode?: string;  // Query a specific lab node URL for Clara jobs
}

export async function jobStatusCommand(
  jobId: string,
  options: JobStatusOptions = {}
): Promise<void> {
  const spinner = ora('Fetching job status...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    const checkStatus = async () => {
      const status = await api.getBioOSJobStatus(jobId);

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return status.status;
      }

      console.clear();
      console.log(chalk.bold(`\n📊 Job Status: ${jobId}\n`));

      // Status indicator
      let statusIcon = '';
      let statusColor: (str: string) => string;

      switch (status.status) {
        case 'pending':
          statusIcon = '⏳';
          statusColor = chalk.yellow;
          break;
        case 'running':
          statusIcon = '▶️ ';
          statusColor = chalk.cyan;
          break;
        case 'completed':
          statusIcon = '✅';
          statusColor = chalk.green;
          break;
        case 'failed':
          statusIcon = '❌';
          statusColor = chalk.red;
          break;
        default:
          statusIcon = '❓';
          statusColor = chalk.gray;
      }

      console.log(`  ${chalk.bold('Status:')} ${statusIcon} ${statusColor(status.status.toUpperCase())}`);
      console.log(`  ${chalk.bold('Progress:')} Step ${status.current_step + 1}/${status.total_steps}`);

      if (status.error_message) {
        console.log(`  ${chalk.bold('Error:')} ${chalk.red(status.error_message)}`);
      }

      // Pipeline progress bar
      console.log();
      const progress = status.total_steps > 0
        ? Math.round((status.current_step / status.total_steps) * 100)
        : 0;

      const barLength = 30;
      const filled = Math.round((progress / 100) * barLength);
      const empty = barLength - filled;
      const bar = '█'.repeat(filled) + '░'.repeat(empty);

      console.log(`  Pipeline: [${chalk.cyan(bar)}] ${progress}%`);

      // IP Lineage
      if (status.ip_lineage && status.ip_lineage.length > 0) {
        console.log();
        console.log(chalk.bold('  Story Protocol Lineage:'));
        status.ip_lineage.forEach((ipId: string, index: number) => {
          const isLast = index === status.ip_lineage.length - 1;
          const prefix = isLast ? '  └─' : '  ├─';
          console.log(`${prefix} ${chalk.gray(ipId)}`);
        });
      }

      // Output files
      if (status.output_files && status.output_files.length > 0) {
        console.log();
        console.log(chalk.bold('  Output Files:'));

        const table = new Table({
          head: [chalk.cyan('Step'), chalk.cyan('Service'), chalk.cyan('File Type'), chalk.cyan('IP Asset')],
          colWidths: [8, 20, 15, 45]
        });

        for (const file of status.output_files) {
          table.push([
            file.step,
            file.service || 'N/A',
            file.file_type || 'N/A',
            file.ip_id ? file.ip_id.substring(0, 42) + '...' : 'N/A'
          ]);
        }

        console.log(table.toString());
      }

      // Timestamps
      console.log();
      console.log(`  ${chalk.gray('Created:')} ${Logger.formatDate(new Date(status.created_at))}`);
      console.log(`  ${chalk.gray('Updated:')} ${Logger.formatDate(new Date(status.updated_at))}`);

      // Next steps
      console.log();
      if (status.status === 'completed') {
        console.log(chalk.green('  ✓ Job completed successfully!'));
        console.log(chalk.gray('  Download results: ') + chalk.cyan(`biofs job results ${jobId}`));
      } else if (status.status === 'running') {
        console.log(chalk.cyan('  ⏳ Job is still running...'));
        if (!options.watch) {
          console.log(chalk.gray('  Watch mode: ') + chalk.cyan(`biofs job status ${jobId} --watch`));
        }
      } else if (status.status === 'failed') {
        console.log(chalk.red('  ✗ Job failed'));
      }
      console.log();

      return status.status;
    };

    // Initial check
    const currentStatus = await checkStatus();

    // Watch mode
    if (options.watch && (currentStatus === 'pending' || currentStatus === 'running')) {
      console.log(chalk.gray('  Watching... (press Ctrl+C to exit)'));

      const interval = setInterval(async () => {
        try {
          const latestStatus = await checkStatus();

          if (latestStatus === 'completed' || latestStatus === 'failed') {
            clearInterval(interval);
          }
        } catch (error) {
          clearInterval(interval);
          throw error;
        }
      }, 5000); // Refresh every 5 seconds
    }

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to fetch job status'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

