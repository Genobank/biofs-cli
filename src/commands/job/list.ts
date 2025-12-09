import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface JobListOptions {
  json?: boolean;      // JSON output format
  status?: string;     // Filter by status (pending, running, completed, failed)
  limit?: number;      // Limit number of results
}

export async function jobListCommand(
  options: JobListOptions = {}
): Promise<void> {
  const spinner = ora('Fetching your research jobs...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    let jobs = await api.getBioOSUserJobs();

    spinner.stop();

    // Filter by status if specified
    if (options.status) {
      jobs = jobs.filter((job: any) =>
        job.status?.toLowerCase() === options.status?.toLowerCase()
      );
    }

    // Limit results if specified
    if (options.limit && options.limit > 0) {
      jobs = jobs.slice(0, options.limit);
    }

    if (jobs.length === 0) {
      console.log(chalk.yellow('No research jobs found.'));
      console.log(chalk.gray('Create a job: ') + chalk.cyan('biofs job create "<prompt>" <file>'));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }

    console.log(chalk.bold(`\n🔬 Your Research Jobs (${jobs.length}):\n`));

    const table = new Table({
      head: [
        chalk.cyan('Job ID'),
        chalk.cyan('Prompt'),
        chalk.cyan('Status'),
        chalk.cyan('Progress'),
        chalk.cyan('Created')
      ],
      colWidths: [20, 40, 12, 12, 20]
    });

    for (const job of jobs) {
      // Status color
      let statusColor: (str: string) => string;
      let statusIcon = '';

      switch (job.status) {
        case 'pending':
          statusColor = chalk.yellow;
          statusIcon = '⏳ ';
          break;
        case 'running':
          statusColor = chalk.cyan;
          statusIcon = '▶️  ';
          break;
        case 'completed':
          statusColor = chalk.green;
          statusIcon = '✅ ';
          break;
        case 'failed':
          statusColor = chalk.red;
          statusIcon = '❌ ';
          break;
        default:
          statusColor = chalk.gray;
          statusIcon = '❓ ';
      }

      // Truncate prompt if too long
      const prompt = job.prompt && job.prompt.length > 37
        ? job.prompt.substring(0, 37) + '...'
        : job.prompt || 'N/A';

      // Progress
      const progress = job.total_steps > 0
        ? `${job.current_step}/${job.total_steps}`
        : 'N/A';

      // Format date
      const createdDate = job.created_at
        ? new Date(job.created_at).toLocaleDateString()
        : 'N/A';

      table.push([
        job.job_id.substring(0, 18) + '...',
        prompt,
        statusIcon + statusColor(job.status),
        progress,
        createdDate
      ]);
    }

    console.log(table.toString());
    console.log();

    // Summary stats
    const pending = jobs.filter((j: any) => j.status === 'pending').length;
    const running = jobs.filter((j: any) => j.status === 'running').length;
    const completed = jobs.filter((j: any) => j.status === 'completed').length;
    const failed = jobs.filter((j: any) => j.status === 'failed').length;

    console.log(chalk.bold('Summary:'));
    if (pending > 0) console.log(`  ${chalk.yellow('⏳ Pending:')} ${pending}`);
    if (running > 0) console.log(`  ${chalk.cyan('▶️  Running:')} ${running}`);
    if (completed > 0) console.log(`  ${chalk.green('✅ Completed:')} ${completed}`);
    if (failed > 0) console.log(`  ${chalk.red('❌ Failed:')} ${failed}`);
    console.log();

    // Show commands for active jobs
    const activeJobs = jobs.filter((j: any) =>
      j.status === 'pending' || j.status === 'running'
    );

    if (activeJobs.length > 0) {
      console.log(chalk.bold('Active Jobs:'));
      activeJobs.slice(0, 3).forEach((job: any) => {
        console.log(chalk.gray(`  • ${job.job_id.substring(0, 12)}... - `) +
          chalk.cyan(`biofs job status ${job.job_id}`));
      });
      console.log();
    }

    // Show commands for completed jobs
    const completedJobs = jobs.filter((j: any) => j.status === 'completed');

    if (completedJobs.length > 0) {
      console.log(chalk.bold('Download Results:'));
      completedJobs.slice(0, 3).forEach((job: any) => {
        console.log(chalk.gray(`  • ${job.job_id.substring(0, 12)}... - `) +
          chalk.cyan(`biofs job results ${job.job_id}`));
      });
      console.log();
    }

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to fetch jobs'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

