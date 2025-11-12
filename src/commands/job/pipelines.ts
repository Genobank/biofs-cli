import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface PipelinesOptions {
  json?: boolean;   // JSON output format
}

export async function pipelinesCommand(
  options: PipelinesOptions = {}
): Promise<void> {
  const spinner = ora('Fetching pipeline templates...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    const pipelines = await api.getBioOSPipelineList();

    spinner.stop();

    if (Object.keys(pipelines).length === 0) {
      console.log(chalk.yellow('No pipeline templates available.'));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(pipelines, null, 2));
      return;
    }

    console.log(chalk.bold(`\n🔧 Available Pipeline Templates:\n`));

    const table = new Table({
      head: [
        chalk.cyan('Template ID'),
        chalk.cyan('Name'),
        chalk.cyan('Description'),
        chalk.cyan('Steps')
      ],
      colWidths: [20, 30, 50, 8]
    });

    for (const [id, pipeline] of Object.entries(pipelines) as [string, any][]) {
      table.push([
        id,
        pipeline.name || 'N/A',
        pipeline.description || 'N/A',
        pipeline.steps?.length || 0
      ]);
    }

    console.log(table.toString());
    console.log();

    // Show detailed pipeline steps
    console.log(chalk.bold('Pipeline Details:\n'));

    for (const [id, pipeline] of Object.entries(pipelines) as [string, any][]) {
      console.log(chalk.cyan(`${id}`) + chalk.gray(' - ') + chalk.bold(pipeline.name));
      console.log(`  ${chalk.gray(pipeline.description)}`);

      if (pipeline.steps && pipeline.steps.length > 0) {
        console.log(chalk.gray('  Steps:'));
        pipeline.steps.forEach((step: any, index: number) => {
          const arrow = index < pipeline.steps.length - 1 ? '→' : ' ';
          console.log(`    ${index + 1}. ${step.service} (${step.action}) ${chalk.gray(arrow)}`);
        });
      }

      console.log();
    }

    // Usage examples
    console.log(chalk.bold('Usage Examples:\n'));

    for (const [id, pipeline] of Object.entries(pipelines) as [string, any][]) {
      console.log(chalk.gray(`  # ${pipeline.name}`));
      console.log(chalk.cyan(`  biofs job create "${pipeline.description}" <file> --pipeline ${id}`));
      console.log();
    }

    console.log(chalk.gray('💡 Tip: Use --pipeline <template_id> to use a predefined pipeline'));
    console.log(chalk.gray('   Or provide a natural language prompt for custom workflows'));
    console.log();

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to fetch pipelines'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
