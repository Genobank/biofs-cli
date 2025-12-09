import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface JobCreateOptions {
  pipeline?: string;  // Use predefined pipeline (fastq_to_report, vcf_annotation, etc.)
  json?: boolean;     // JSON output format
}

export async function jobCreateCommand(
  prompt: string,
  fileRef: string,  // BioCID, filename, or IP asset ID
  options: JobCreateOptions = {}
): Promise<void> {
  const spinner = ora('Creating research job...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    // Resolve file reference to get file info
    spinner.text = 'Resolving file reference...';

    let inputFile: any;

    // Check if it's a BioCID
    if (fileRef.startsWith('biocid://')) {
      const registrationId = fileRef.split('/bioip/')[1]?.split('/')[0] || '';
      if (!registrationId) {
        throw new Error('Invalid BioCID format');
      }

      const bioips = await api.getMyBioIPs();
      const bioip = bioips.find((b: any) => b.registration_id === registrationId);
      if (!bioip) {
        throw new Error('BioIP asset not found');
      }

      inputFile = {
        name: bioip.title || 'Genomic File',
        path: bioip.s3_path || '',
        type: bioip.category || 'unknown',
        ip_id: bioip.ip_id
      };
    }
    // Check if it's an IP asset ID
    else if (fileRef.startsWith('0x')) {
      // Query Story Protocol for file info
      const bioips = await api.getMyBioIPs();
      const bioip = bioips.find((b: any) => b.ip_id === fileRef);

      if (!bioip) {
        throw new Error('IP asset not found or you are not the owner');
      }

      inputFile = {
        name: bioip.title || 'Genomic File',
        path: bioip.s3_path || '',
        type: bioip.category || 'unknown',
        ip_id: bioip.ip_id
      };
    }
    // Assume it's a filename
    else {
      const files = await api.getMyUploadedFilesUrls();
      const file = files.find((f: any) =>
        f.filename === fileRef || f.filename.endsWith(fileRef)
      );

      if (!file) {
        throw new Error(`File not found: ${fileRef}`);
      }

      // Get file extension
      const ext = file.filename.split('.').pop()?.toLowerCase();
      const typeMap: any = {
        'fastq': 'fastq',
        'fq': 'fastq',
        'vcf': 'vcf',
        'bam': 'bam',
        'sam': 'sam'
      };

      inputFile = {
        name: file.filename,
        path: file.s3_path || '',
        type: typeMap[ext || ''] || 'unknown'
      };
    }

    // Get pipeline if specified
    let pipeline: any = undefined;
    if (options.pipeline) {
      spinner.text = 'Loading pipeline template...';
      const pipelines = await api.getBioOSPipelineList();

      if (!pipelines[options.pipeline]) {
        throw new Error(`Pipeline not found: ${options.pipeline}. Available: ${Object.keys(pipelines).join(', ')}`);
      }

      pipeline = pipelines[options.pipeline];
    }

    // Create job
    spinner.text = 'Creating research job...';
    const result = await api.createBioOSJob(
      prompt,
      [inputFile],
      pipeline
    );

    spinner.succeed(chalk.green('✓ Research job created successfully'));

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold('Job Created:'));
    console.log(`  ${chalk.cyan('Job ID:')} ${result.job_id}`);
    console.log(`  ${chalk.cyan('Status:')} ${result.status}`);
    console.log(`  ${chalk.cyan('Prompt:')} ${prompt}`);
    console.log();
    console.log(chalk.gray('Monitor progress: ') + chalk.cyan(`biofs job status ${result.job_id}`));
    console.log(chalk.gray('View results: ') + chalk.cyan(`biofs job results ${result.job_id}`));
    console.log();

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to create job'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

