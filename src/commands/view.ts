import chalk from 'chalk';
import ora from 'ora';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import { BioCIDParser } from '../lib/biofiles/biocid';
import { isHeavyGenomicName } from '../lib/biofiles/filetype';
import { fetchDerivedBytes } from './register-derived';

export interface ViewOptions {
  lines?: number;      // Number of lines to display (default: all)
  format?: string;     // Output format: raw, pretty, json
  verbose?: boolean;
  debug?: boolean;
}

export async function viewCommand(
  biocidOrFilename: string,
  options: ViewOptions
): Promise<void> {
  const spinner = ora('Fetching file content...').start();

  try {
    const api = GenoBankAPIClient.getInstance();
    
    const parsed = BioCIDParser.parse(biocidOrFilename);
    const isBioCID = !!parsed || biocidOrFilename.startsWith('biocid://');
    const nameHint = parsed?.identifier || biocidOrFilename;
    if (isHeavyGenomicName(nameHint) || ['bam', 'cram', 'fastq', 'vcf', 'gvcf', 'sqlite'].includes(parsed?.type || '')) {
      spinner.fail('This biodata is not a text view');
      console.log(chalk.yellow('Use `biofs stream` for BAM/CRAM/FASTQ/VCF or `biofs query` for sqlite. Bytes stay server-side.'));
      process.exit(2);
    }

    if (isBioCID) {
      spinner.text = 'Resolving BioCID...';
    } else {
      spinner.text = `Fetching ${biocidOrFilename}...`;
    }

    // Get file content
    let result: any;
    let legacyError = '';
    try {
      result = await api.viewFile({
        biocid_or_filename: biocidOrFilename,
        max_lines: options.lines || 0  // 0 = all lines
      });
      if (result.status === 'Failure') legacyError = String(result.status_details?.message || 'not found');
    } catch (e: any) {
      legacyError = e?.message || String(e);
    }

    if (legacyError) {
      // A job output registered by biofs-node (a report, a stats table) is not in the legacy file index: read it through the node instead (owner or operator, consent,
      // 5 MB cap, SHA-256 checked by the node and again here). Primary biodata never comes this way.
      if (!isBioCID) {
        spinner.fail(chalk.red(`Error: ${legacyError}`));
        process.exit(1);
      }
      spinner.text = 'Not in the legacy file index; reading through biofs-node...';
      let node: { body: Buffer; sha256: string };
      try {
        node = await fetchDerivedBytes(biocidOrFilename);
      } catch (e: any) {
        spinner.fail(chalk.red(`Error: legacy index: ${legacyError}; biofs-node: ${e?.message || e}`));
        process.exit(1);
      }
      const text = node.body.toString('utf8');
      const all = text.split('\n');
      const shown = options.lines ? all.slice(0, Number(options.lines)).join('\n') : text;
      spinner.succeed(chalk.green('✅ File Content Retrieved (biofs-node)'));
      console.log('');
      console.log(chalk.bold('📄 File Information:'));
      console.log(chalk.gray(`   BioCID: ${biocidOrFilename}`));
      console.log(chalk.gray(`   Size: ${formatFileSize(node.body.length)}`));
      console.log(chalk.gray(`   SHA-256: ${node.sha256} (checked by biofs-node and by this verb)`));
      console.log('');
      console.log(chalk.bold('📋 Content:'));
      console.log(chalk.dim('─'.repeat(80)));
      if (options.format === 'pretty') displayPrettyContent(shown, ''); else console.log(shown);
      console.log(chalk.dim('─'.repeat(80)));
      console.log('');
      console.log(chalk.gray(`   Total lines: ${all.length}`));
      if (options.lines && all.length > Number(options.lines)) console.log(chalk.yellow(`   Showing first ${options.lines} lines (use --lines to show more)`));
      console.log('');
      return;
    }

    const data = result.status_details;
    spinner.succeed(chalk.green('✅ File Content Retrieved'));

    // Display file metadata
    console.log('');
    console.log(chalk.bold('📄 File Information:'));
    console.log(chalk.gray(`   Filename: ${data.filename}`));
    console.log(chalk.gray(`   Size: ${formatFileSize(data.size_bytes)}`));
    console.log(chalk.gray(`   Type: ${data.file_type}`));
    if (data.biocid) {
      console.log(chalk.gray(`   BioCID: ${data.biocid}`));
    }
    console.log('');

    // Display content
    console.log(chalk.bold('📋 Content:'));
    console.log(chalk.dim('─'.repeat(80)));
    
    if (options.format === 'json') {
      // JSON format
      console.log(JSON.stringify(data, null, 2));
    } else if (options.format === 'pretty') {
      // Pretty format with syntax highlighting
      displayPrettyContent(data.content, data.file_type);
    } else {
      // Raw format (default)
      console.log(data.content);
    }
    
    console.log(chalk.dim('─'.repeat(80)));

    // Show line count
    const lineCount = data.content.split('\n').length;
    console.log('');
    console.log(chalk.gray(`   Total lines: ${lineCount}`));
    
    if (options.lines && lineCount > options.lines) {
      console.log(chalk.yellow(`   Showing first ${options.lines} lines (use --lines to show more)`));
    }

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red(`Error: ${error.message}`));
    if (options.debug) {
      console.error(error);
    }
    process.exit(1);
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function displayPrettyContent(content: string, fileType: string): void {
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    const lineNumber = chalk.dim(`${(index + 1).toString().padStart(4)} │ `);
    
    // Syntax highlighting based on file type
    if (fileType === 'VCF' || line.startsWith('#')) {
      // VCF headers in blue
      console.log(lineNumber + chalk.blue(line));
    } else if (fileType === '23ANDME' && line.startsWith('#')) {
      // 23andMe comments in gray
      console.log(lineNumber + chalk.gray(line));
    } else if (line.includes('\t')) {
      // Tab-delimited data - highlight rsIDs
      const fields = line.split('\t');
      if (fields[0].startsWith('rs')) {
        // Highlight rsID in cyan
        const highlighted = chalk.cyan(fields[0]) + '\t' + fields.slice(1).join('\t');
        console.log(lineNumber + highlighted);
      } else {
        console.log(lineNumber + line);
      }
    } else {
      console.log(lineNumber + line);
    }
  });
}


