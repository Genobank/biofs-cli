#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { loginCommand, LoginOptions } from './commands/login';
import { logoutCommand } from './commands/logout';
import { whoamiCommand, WhoamiOptions } from './commands/whoami';
import { filesCommand, FilesOptions } from './commands/biofiles';
import { downloadCommand, DownloadOptions } from './commands/download';
import { downloadCommandWithConsent } from './commands/download-with-consent';
import { uploadCommand, UploadOptions } from './commands/upload';
import { mountCommand, MountOptions } from './commands/mount';
import { mountRemoteCommand, MountRemoteOptions } from './commands/mount-remote';
import { umountCommand, UmountOptions } from './commands/umount';
import { tokenizeCommand, TokenizeOptions } from './commands/tokenize';
import { tokenizeFastqsCommand, TokenizeFastqsOptions } from './commands/tokenize-fastqs';
import { tokenizeBiosampleCommand, TokenizeBiosampleOptions } from './commands/tokenize-biosample';
import { linkClaraCommand, LinkClaraOptions } from './commands/link-clara';
import { familyStatusCommand, FamilyStatusOptions } from './commands/family-status';
import { accessRequestCommand, AccessRequestOptions } from './commands/access/request';
import { accessGrantCommand, AccessGrantOptions } from './commands/access/grant';
import { accessRevokeCommand, AccessRevokeOptions } from './commands/access/revoke';
import { accessListCommand, AccessListOptions } from './commands/access/list';
import { accessCheckCommand } from './commands/access/check';
import { revokeConsentCommand, RevokeConsentOptions } from './commands/access/revoke-consent';
import { jobCreateCommand, JobCreateOptions } from './commands/job/create';
import { jobStatusCommand, JobStatusOptions } from './commands/job/status';
import { jobResultsCommand, JobResultsOptions } from './commands/job/results';
import { jobListCommand, JobListOptions } from './commands/job/list';
import { pipelinesCommand, PipelinesOptions } from './commands/job/pipelines';
import { submitClaraCommand, ClaraJobOptions } from './commands/job/submit-clara';
import { agentHealthCommand, AgentHealthOptions } from './commands/agent/health';
import { agentRegisterCommand, AgentRegisterOptions } from './commands/agent/register';
import { agentListCommand, AgentListOptions } from './commands/agent/list';
import { agentStatusCommand, AgentStatusOptions } from './commands/agent/status';
import { KiteNetwork } from './types/kite';
import { labNFTsCommand, LabNFTsOptions } from './commands/labs/list';
import { shareCommand, ShareOptions } from './commands/share';
import { sharesCommand, SharesOptions } from './commands/shares';
import { verifyCommand, VerifyOptions } from './commands/verify';
import { dissectCommand, DissectOptions } from './commands/dissect';
import { dissectCommandSequentia } from './commands/dissect-sequentia';
import { viewCommand, ViewOptions } from './commands/view';
import { reportCommand, ReportOptions } from './commands/report';
import { createAdminCommand } from './commands/admin';
import { fuseListCommand, fuseMountCommand, fuseStreamCommand, fuseSampleCommand, FuseOptions } from './commands/fuse';
import { annotateSubmitCommand, AnnotateSubmitOptions } from './commands/annotate/submit';
import { annotateStatusCommand, AnnotateStatusOptions } from './commands/annotate/status';
import { paymentBalanceCommand, PaymentBalanceOptions } from './commands/payment/balance';
import { paymentPricingCommand, PaymentPricingOptions } from './commands/payment/pricing';
import { paymentSetupCommand, PaymentSetupOptions } from './commands/payment/setup';
import { paymentFaucetCommand, PaymentFaucetOptions } from './commands/payment/faucet';
import { paymentHistoryCommand, PaymentHistoryOptions } from './commands/payment/history';
import { X402Network } from './types/x402';
import { Logger } from './lib/utils/logger';

const program = new Command();

// Set up the CLI
program
  .name('biofs')
  .description('BioFS by GenoBank.io - BioNFT-Gated S3 CLI for genomic data')
  .version('2.4.0')
  .option('--debug', 'Enable debug output')
  .hook('preAction', (thisCommand) => {
    // Set global debug flag if --debug is passed
    const opts = thisCommand.opts();
    if (opts.debug) {
      process.env.DEBUG = '1';
    }
  });

// Login command
program
  .command('login')
  .description('Authenticate with GenoBank.io using Web3 signature')
  .option('--port <number>', 'Callback server port', parseInt)
  .option('--no-browser', "Don't auto-open browser")
  .option('--timeout <seconds>', 'Auth timeout in seconds', parseInt)
  .option('--wallet <address>', 'Wallet address for direct authentication')
  .option('--signature <signature>', 'Signature for direct authentication')
  .action(async (options: LoginOptions) => {
    try {
      await loginCommand(options);
    } catch (error) {
      Logger.error(`Login failed: ${error}`);
      process.exit(1);
    }
  });

// Logout command
program
  .command('logout')
  .description('Clear stored credentials')
  .action(async () => {
    try {
      await logoutCommand();
    } catch (error) {
      Logger.error(`Logout failed: ${error}`);
      process.exit(1);
    }
  });

// Whoami command
program
  .command('whoami')
  .description('Show current authenticated wallet')
  .option('--json', 'Output as JSON')
  .option('--verify', 'Verify signature validity')
  .option('--check <wallet>', 'Check against specific wallet address (e.g., Dra. Claudia: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d)')
  .action(async (options: WhoamiOptions) => {
    try {
      await whoamiCommand(options);
    } catch (error) {
      Logger.error(`Error: ${error}`);
      process.exit(1);
    }
  });

// Report command - Health check and diagnostics
program
  .command('report')
  .description('Generate diagnostic health check report for troubleshooting')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show verbose debug information')
  .action(async (options: ReportOptions) => {
    try {
      await reportCommand(options);
    } catch (error) {
      Logger.error(`Report generation failed: ${error}`);
      process.exit(1);
    }
  });

// Admin command group - Admin operations on Sequentia Network
program.addCommand(createAdminCommand());

// BioFiles command - Comprehensive discovery across all GenoBank data sources
program
  .command('biofiles')
  .alias('files')  // Keep 'files' as alias for backward compatibility
  .alias('ls')
  .description('Discover all your BioFiles from GenoBank ecosystem (Story Protocol, Avalanche, S3, BioIP)')
  .option('--filter <type>', 'Filter by file type (vcf, fastq, bam, pdf, etc.)')
  .option('--source <source>', 'Filter by source (story, avalanche, s3, biofs)')
  .option('--json', 'Output as JSON')
  .option('--update', 'Force refresh from blockchain and S3')
  .option('--verbose', 'Show debug information')
  .option('--debug', 'Show detailed debug logs')
  .action(async (options: FilesOptions) => {
    try {
      await filesCommand(options);
    } catch (error) {
      Logger.error(`Error discovering BioFiles: ${error}`);
      process.exit(1);
    }
  });

// Download command (with GDPR consent for genomic data)
program
  .command('download <biocid_or_filename> [destination]')
  .alias('get')
  .description('Download a file (with GDPR consent for genomic data)')
  .option('--output <path>', 'Output file path')
  .option('--stream', 'Stream large files (>100MB)')
  .option('--quiet', 'No progress bar')
  .option('--skip-consent', 'Skip GDPR consent (for automation)')
  .action(async (biocidOrFilename: string, destination: string | undefined, options: DownloadOptions) => {
    try {
      await downloadCommandWithConsent(biocidOrFilename, destination, options);
    } catch (error) {
      Logger.error(`Download failed: ${error}`);
      process.exit(1);
    }
  });

// Upload command
program
  .command('upload <file>')
  .alias('put')
  .description('Upload a file to GenoBank')
  .option('--type <type>', 'File type (vcf, fastq, bam, pdf)')
  .option('--tokenize', 'Mint as NFT after upload')
  .option('--share-with <lab>', 'Share with lab after upload')
  .option('--public', 'Make publicly discoverable')
  .option('--quiet', 'No progress output')
  .action(async (filePath: string, options: UploadOptions) => {
    try {
      await uploadCommand(filePath, options);
    } catch (error) {
      Logger.error(`Upload failed: ${error}`);
      process.exit(1);
    }
  });

// Mount command (mount all granted BioFiles with GDPR consent)
program
  .command('mount <mount_point>')
  .description('Mount BioFiles as filesystem (NFS or copy method)')
  .option('--method <type>', 'Mount method: nfs (true filesystem) or copy (download files)', 'copy')
  .option('--biocid <biocid>', 'Mount specific BioCID (biocid://OWNER/bioip/IP_ID)')
  .option('--port <number>', 'NFS server port (default: 2049)', parseInt)
  .option('--read-only', 'Mount as read-only')
  .option('--quiet', 'Suppress output')
  .option('--skip-consent', 'Skip GDPR consent (for automation)')
  .action(async (mountPoint: string, options: MountOptions) => {
    try {
      await mountCommand(mountPoint, options);
    } catch (error) {
      Logger.error(`Mount failed: ${error}`);
      process.exit(1);
    }
  });

// Mount-remote command (mount biosample on GPU processing agent)
program
  .command('mount-remote <biosample_id>')
  .alias('mount-agent')
  .description('Mount biosample files on remote GPU processing agent')
  .option('--mount-point <path>', 'Remote mount point (default: /biofs)')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed debug information')
  .action(async (biosampleId: string, options: MountRemoteOptions) => {
    try {
      await mountRemoteCommand(biosampleId, options);
    } catch (error) {
      Logger.error(`Remote mount failed: ${error}`);
      process.exit(1);
    }
  });

// FUSE command group - Remote BioNFT-gated file access
const fuseCmd = program
  .command('fuse')
  .description('Remote BioNFT-gated file access via BioFS-Node server');

// fuse mount - Verify consent
fuseCmd
  .command('mount <biosample_id>')
  .description('Verify BioNFT consent for a biosample')
  .option('--server <url>', 'BioFS-Node server URL', 'http://localhost:8081')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed output')
  .action(async (biosampleId: string, options: FuseOptions) => {
    try {
      await fuseMountCommand(biosampleId, options);
    } catch (error) {
      Logger.error(`Consent verification failed: ${error}`);
      process.exit(1);
    }
  });

// fuse list - List files
fuseCmd
  .command('list <biosample_id>')
  .alias('ls')
  .description('List files available in a biosample')
  .option('--server <url>', 'BioFS-Node server URL', 'http://localhost:8081')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed output')
  .action(async (biosampleId: string, options: FuseOptions) => {
    try {
      await fuseListCommand(biosampleId, options);
    } catch (error) {
      Logger.error(`File listing failed: ${error}`);
      process.exit(1);
    }
  });

// fuse stream - Download full file
fuseCmd
  .command('stream <biosample_id> <filename>')
  .alias('download')
  .description('Stream/download a file from a biosample')
  .option('--server <url>', 'BioFS-Node server URL', 'http://localhost:8081')
  .option('--output <path>', 'Output file path')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed output')
  .action(async (biosampleId: string, filename: string, options: FuseOptions) => {
    try {
      await fuseStreamCommand(biosampleId, filename, options);
    } catch (error) {
      Logger.error(`File streaming failed: ${error}`);
      process.exit(1);
    }
  });

// fuse sample - Download sample for FastQC
fuseCmd
  .command('sample <biosample_id> <filename>')
  .description('Download a sample of a file (for FastQC preview)')
  .option('--server <url>', 'BioFS-Node server URL', 'http://localhost:8081')
  .option('--size <size>', 'Sample size (e.g., 100MB, 1GB)', '100MB')
  .option('--output <path>', 'Output file path')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed output')
  .action(async (biosampleId: string, filename: string, options: FuseOptions & { size?: string }) => {
    try {
      await fuseSampleCommand(biosampleId, filename, options);
    } catch (error) {
      Logger.error(`Sample download failed: ${error}`);
      process.exit(1);
    }
  });

// Umount command (unmount BioFiles filesystem)
program
  .command('umount <mount_point>')
  .alias('unmount')
  .description('Unmount BioFiles filesystem')
  .option('--force', 'Force unmount even if busy')
  .option('--quiet', 'Suppress output')
  .action(async (mountPoint: string, options: UmountOptions) => {
    try {
      await umountCommand(mountPoint, options);
    } catch (error) {
      Logger.error(`Umount failed: ${error}`);
      process.exit(1);
    }
  });

// Tokenize command group - BioNFT minting on Sequentia
const tokenizeCmd = program
  .command('tokenize')
  .description('Tokenize genomic data as BioNFT on Sequentia Network');

// tokenize file - Tokenize local genomic file
tokenizeCmd
  .command('file <file>')
  .description('Tokenize a local genomic file as BioIP NFT')
  .option('--title <string>', 'Custom title for the NFT')
  .option('--description <string>', 'Custom description (uses AI if not provided)')
  .option('--license <type>', 'License type: commercial, non-commercial', 'non-commercial')
  .option('--collection <address>', 'Manual collection address override')
  .option('--no-ai', 'Skip AI classification')
  .option('--quiet', 'No interactive prompts')
  .option('--yes', 'Auto-confirm all prompts')
  .action(async (file: string, options: TokenizeOptions) => {
    try {
      await tokenizeCommand(file, options);
    } catch (error) {
      Logger.error(`Tokenization failed: ${error}`);
      process.exit(1);
    }
  });

// tokenize fastqs - Tokenize biosample FASTQ files from S3
tokenizeCmd
  .command('fastqs <biosample_serial>')
  .description('Mint BioNFT consent for biosample FASTQ files in S3')
  .option('--recipient <wallet>', 'Grant access to wallet address (e.g., approved lab)')
  .option('--license <type>', 'License type (default: non-commercial)', 'non-commercial')
  .option('--quiet', 'Suppress progress output')
  .option('--yes', 'Auto-confirm all prompts')
  .action(async (biosampleSerial: string, options: TokenizeFastqsOptions) => {
    try {
      await tokenizeFastqsCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`FASTQ tokenization failed: ${error}`);
      process.exit(1);
    }
  });

// tokenize biosample - Mint BioNFT from deployed contract on Sequentia
tokenizeCmd
  .command('biosample <biosample_serial>')
  .description('Mint BioNFT from deployed contract on Sequentia')
  .option('--owner-name <name>', 'Name of biosample owner')
  .option('--role <role>', 'Role (patient, mother, father, child, proband, sibling)', 'patient')
  .option('--sample-type <type>', 'Sample type (exome, genome, panel, array)', 'exome')
  .option('--capture-kit <kit>', 'Capture kit used', 'agilent_v8')
  .option('--quiet', 'Suppress progress output')
  .option('--yes', 'Auto-confirm all prompts')
  .action(async (biosampleSerial: string, options: TokenizeBiosampleOptions) => {
    try {
      await tokenizeBiosampleCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`Biosample tokenization failed: ${error}`);
      process.exit(1);
    }
  });

// Link command group - Link derivative NFTs to BioNFTs
const linkCmd = program
  .command('link')
  .description('Link derivative NFTs to parent BioNFT');

// link clara - Link ClaraJobNFT for VCF output
linkCmd
  .command('clara <biosample_serial>')
  .description('Mint ClaraJobNFT and link as derivative to BioNFT')
  .option('--vcf-path <path>', 'Manual VCF path override')
  .option('--quiet', 'Suppress progress output')
  .option('--yes', 'Auto-confirm all prompts')
  .action(async (biosampleSerial: string, options: LinkClaraOptions) => {
    try {
      await linkClaraCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`Clara linking failed: ${error}`);
      process.exit(1);
    }
  });

// Family status command - Show family pipeline status
program
  .command('family-status')
  .alias('family')
  .description('Show family genomic pipeline status (BioNFT → ClaraJobNFT → etc.)')
  .argument('<biosample_serials...>', 'Biosample serial numbers')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed information')
  .action(async (biosampleSerials: string[], options: FamilyStatusOptions) => {
    try {
      await familyStatusCommand(biosampleSerials, options);
    } catch (error) {
      Logger.error(`Family status check failed: ${error}`);
      process.exit(1);
    }
  });

// Annotate command group - OpenCRAVAT VCF annotation
const annotateCmd = program
  .command('annotate')
  .description('Annotate VCF files with OpenCRAVAT (146 annotators)');

// annotate submit - Submit VCF for annotation
annotateCmd
  .command('submit <biosample_serial>')
  .description('Submit VCF to OpenCRAVAT for annotation with all 146 annotators')
  .option('--vcf-path <path>', 'Manual VCF path override')
  .option('--annotators <list>', 'Custom annotators (comma-separated), defaults to all 146')
  .option('--package <package>', 'Analysis package (rare_coding, hereditary_cancer, splicing, drug_interaction, pathogenic)', 'rare_coding')
  .option('--phenotype <text>', 'Clinical phenotype description for AI analysis')
  .option('--assembly <genome>', 'Reference genome (hg38, hg19)', 'hg38')
  .option('--wait', 'Wait for job to complete')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (biosampleSerial: string, options: AnnotateSubmitOptions) => {
    try {
      await annotateSubmitCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`Annotation submission failed: ${error}`);
      process.exit(1);
    }
  });

// annotate status - Check annotation job status
annotateCmd
  .command('status <job_id>')
  .description('Check OpenCRAVAT annotation job status')
  .option('--watch', 'Watch mode (refresh every 5 seconds)')
  .option('--json', 'Output as JSON')
  .action(async (jobId: string, options: AnnotateStatusOptions) => {
    try {
      await annotateStatusCommand(jobId, options);
    } catch (error) {
      Logger.error(`Status check failed: ${error}`);
      process.exit(1);
    }
  });

// Payment commands (x402 Protocol - Avalanche C-Chain)
const paymentCmd = program
  .command('payment')
  .alias('pay')
  .description('Manage x402 payments on Avalanche C-Chain (USDC)');

// payment balance - Check USDC balance
paymentCmd
  .command('balance')
  .description('Check USDC balance on Avalanche for x402 payments')
  .option('--network <network>', 'Network: avalanche-fuji or avalanche', 'avalanche-fuji')
  .option('--json', 'Output as JSON')
  .action(async (options: PaymentBalanceOptions) => {
    try {
      await paymentBalanceCommand(options);
    } catch (error) {
      Logger.error(`Balance check failed: ${error}`);
      process.exit(1);
    }
  });

// payment pricing - Show service pricing
paymentCmd
  .command('pricing')
  .alias('prices')
  .description('Show x402 pricing for BioFS services')
  .option('--network <network>', 'Network: avalanche-fuji or avalanche', 'avalanche-fuji')
  .option('--json', 'Output as JSON')
  .action(async (options: PaymentPricingOptions) => {
    try {
      await paymentPricingCommand(options);
    } catch (error) {
      Logger.error(`Pricing lookup failed: ${error}`);
      process.exit(1);
    }
  });

// payment setup - Configure payment wallet
paymentCmd
  .command('setup')
  .description('Configure wallet for x402 payments on Avalanche')
  .option('--network <network>', 'Network: avalanche-fuji or avalanche', 'avalanche-fuji')
  .option('--max-auto-approve <amount>', 'Maximum auto-approve amount (e.g., $10.00)', '$10.00')
  .option('--json', 'Output as JSON')
  .action(async (options: PaymentSetupOptions) => {
    try {
      await paymentSetupCommand(options);
    } catch (error) {
      Logger.error(`Setup failed: ${error}`);
      process.exit(1);
    }
  });

// payment faucet - Get testnet tokens
paymentCmd
  .command('faucet')
  .description('Get testnet USDC and AVAX on Avalanche Fuji')
  .option('--no-browser', "Don't auto-open browser")
  .option('--json', 'Output as JSON')
  .action(async (options: PaymentFaucetOptions) => {
    try {
      await paymentFaucetCommand(options);
    } catch (error) {
      Logger.error(`Faucet command failed: ${error}`);
      process.exit(1);
    }
  });

// payment history - View transaction history
paymentCmd
  .command('history')
  .alias('transactions')
  .description('View payment transaction history')
  .option('--network <network>', 'Network: avalanche-fuji or avalanche', 'avalanche-fuji')
  .option('--limit <number>', 'Number of transactions to show', parseInt)
  .option('--json', 'Output as JSON')
  .action(async (options: PaymentHistoryOptions) => {
    try {
      await paymentHistoryCommand(options);
    } catch (error) {
      Logger.error(`History lookup failed: ${error}`);
      process.exit(1);
    }
  });

// Agent commands (Kite AI Network)
const agentCmd = program
  .command('agent')
  .description('Manage BioFS agents on Kite AI Network');

// agent register - Register agents on Kite
agentCmd
  .command('register')
  .description('Register BioFS agents on Kite network')
  .option('--name <name>', 'Agent name (e.g., augenomics-clara)')
  .option('--type <type>', 'Service type: orchestrator, gpu-compute, vcf-annotator, ai-analysis, storage, tokenization')
  .option('--endpoint <url>', 'Agent API endpoint URL')
  .option('--price <price>', 'Base price per request (e.g., $0.25)')
  .option('--network <network>', 'Kite network: kite-testnet or kite-mainnet', 'kite-testnet')
  .option('--namespace <namespace>', 'Agent namespace (e.g., genobank.eth)', 'genobank.eth')
  .option('--all', 'Register all pre-defined BioFS agents')
  .option('--json', 'Output as JSON')
  .action(async (options: AgentRegisterOptions) => {
    try {
      await agentRegisterCommand(options);
    } catch (error) {
      Logger.error(`Agent registration failed: ${error}`);
      process.exit(1);
    }
  });

// agent list - List registered agents
agentCmd
  .command('list')
  .alias('ls')
  .description('List registered BioFS agents')
  .option('--network <network>', 'Kite network: kite-testnet or kite-mainnet', 'kite-testnet')
  .option('--namespace <namespace>', 'Agent namespace', 'genobank.eth')
  .option('--type <type>', 'Filter by service type')
  .option('--json', 'Output as JSON')
  .action(async (options: AgentListOptions) => {
    try {
      await agentListCommand(options);
    } catch (error) {
      Logger.error(`Agent list failed: ${error}`);
      process.exit(1);
    }
  });

// agent status - Check agent health and SLA compliance
agentCmd
  .command('status')
  .description('Check agent status, health, and SLA compliance')
  .option('--did <did>', 'Specific agent DID or name')
  .option('--network <network>', 'Kite network: kite-testnet or kite-mainnet', 'kite-testnet')
  .option('--namespace <namespace>', 'Agent namespace', 'genobank.eth')
  .option('--json', 'Output as JSON')
  .action(async (options: AgentStatusOptions) => {
    try {
      await agentStatusCommand(options);
    } catch (error) {
      Logger.error(`Agent status check failed: ${error}`);
      process.exit(1);
    }
  });

// Access control commands (v1.2.0)
const accessCmd = program
  .command('access')
  .description('Manage BioNFT access control and permissions');

// access request
accessCmd
  .command('request <biocid_or_ip_id>')
  .description('Request access to a BioNFT asset')
  .option('--message <string>', 'Optional message to asset owner')
  .action(async (biocidOrIpId: string, options: AccessRequestOptions) => {
    try {
      await accessRequestCommand(biocidOrIpId, options);
    } catch (error) {
      Logger.error(`Access request failed: ${error}`);
      process.exit(1);
    }
  });

// access grant
accessCmd
  .command('grant <biocid_or_ip_id> <wallet_address>')
  .description('Grant access to a wallet address (owner only)')
  .option('--expires-in <duration>', 'Access expiry duration (e.g., 30d, 90d)')
  .action(async (biocidOrIpId: string, walletAddress: string, options: AccessGrantOptions) => {
    try {
      await accessGrantCommand(biocidOrIpId, walletAddress, options);
    } catch (error) {
      Logger.error(`Access grant failed: ${error}`);
      process.exit(1);
    }
  });

// access revoke
accessCmd
  .command('revoke <biocid_or_ip_id> <wallet_address>')
  .description('Revoke access from a wallet address (owner only)')
  .option('--yes', 'Skip confirmation prompt')
  .action(async (biocidOrIpId: string, walletAddress: string, options: AccessRevokeOptions) => {
    try {
      await accessRevokeCommand(biocidOrIpId, walletAddress, options);
    } catch (error) {
      Logger.error(`Access revocation failed: ${error}`);
      process.exit(1);
    }
  });

// access list
accessCmd
  .command('list [biocid_or_ip_id]')
  .description('List permittees for an asset, or assets you can access')
  .option('--mine', 'List assets you have permission to access')
  .option('--status <status>', 'Filter by status: active, pending, revoked')
  .option('--json', 'Output as JSON')
  .action(async (biocidOrIpId: string | undefined, options: AccessListOptions) => {
    try {
      await accessListCommand(biocidOrIpId, options);
    } catch (error) {
      Logger.error(`List failed: ${error}`);
      process.exit(1);
    }
  });

// access check
accessCmd
  .command('check <biocid_or_ip_id>')
  .description('Check your access level to a BioNFT asset')
  .action(async (biocidOrIpId: string) => {
    try {
      await accessCheckCommand(biocidOrIpId);
    } catch (error) {
      Logger.error(`Access check failed: ${error}`);
      process.exit(1);
    }
  });

// access revoke-consent (user withdraws their own consent - GDPR)
accessCmd
  .command('revoke-consent [ip_id]')
  .description('Revoke your consent for genomic data access (GDPR right to withdraw)')
  .option('--all', 'Revoke all consents')
  .option('--force', 'Skip confirmation')
  .action(async (ipId: string | undefined, options: RevokeConsentOptions) => {
    try {
      await revokeConsentCommand(ipId, options);
    } catch (error) {
      Logger.error(`Consent revocation failed: ${error}`);
      process.exit(1);
    }
  });

// Job management commands (BioOS)
const jobCmd = program
  .command('job')
  .description('Manage research jobs (BioOS)');

// job create
jobCmd
  .command('create <prompt> <file>')
  .description('Create a research job from natural language prompt')
  .option('--pipeline <template>', 'Use predefined pipeline template')
  .option('--json', 'Output as JSON')
  .action(async (prompt: string, fileRef: string, options: JobCreateOptions) => {
    try {
      await jobCreateCommand(prompt, fileRef, options);
    } catch (error) {
      Logger.error(`Job creation failed: ${error}`);
      process.exit(1);
    }
  });

// job status
jobCmd
  .command('status <job_id>')
  .description('Check job execution status')
  .option('--json', 'Output as JSON')
  .option('--watch', 'Watch mode (refresh every 5 seconds)')
  .action(async (jobId: string, options: JobStatusOptions) => {
    try {
      await jobStatusCommand(jobId, options);
    } catch (error) {
      Logger.error(`Status check failed: ${error}`);
      process.exit(1);
    }
  });

// job results
jobCmd
  .command('results <job_id>')
  .description('Get job results with download URLs')
  .option('--json', 'Output as JSON')
  .option('--step <number>', 'Download specific step only', parseInt)
  .action(async (jobId: string, options: JobResultsOptions) => {
    try {
      await jobResultsCommand(jobId, options);
    } catch (error) {
      Logger.error(`Failed to get results: ${error}`);
      process.exit(1);
    }
  });

// job list
jobCmd
  .command('list')
  .description('List all your research jobs')
  .option('--json', 'Output as JSON')
  .option('--status <status>', 'Filter by status (pending, running, completed, failed)')
  .option('--limit <number>', 'Limit number of results', parseInt)
  .action(async (options: JobListOptions) => {
    try {
      await jobListCommand(options);
    } catch (error) {
      Logger.error(`Failed to list jobs: ${error}`);
      process.exit(1);
    }
  });

// job pipelines
jobCmd
  .command('pipelines')
  .alias('templates')
  .description('List available pipeline templates')
  .option('--json', 'Output as JSON')
  .action(async (options: PipelinesOptions) => {
    try {
      await pipelinesCommand(options);
    } catch (error) {
      Logger.error(`Failed to list pipelines: ${error}`);
      process.exit(1);
    }
  });

// job submit-clara - Submit Clara Parabricks FASTQ→VCF job
jobCmd
  .command('submit-clara <biosample_id> [fastq_r1] [fastq_r2]')
  .description('Submit Clara Parabricks GPU variant calling job (FASTQ → VCF)\nAuto-discovers FASTQ files from consent if not specified')
  .option('--job-id <id>', 'Custom job ID (default: auto-generated UUID)')
  .option('--reference <genome>', 'Reference genome (default: hg38)')
  .option('--capture-kit <kit>', 'Capture kit name (default: agilent_v8)')
  .option('--sequencing-type <type>', 'Sequencing type: WES or WGS (default: WES)')
  .option('--interval-file <path>', 'BED file path for targeted sequencing')
  .option('--json', 'Output as JSON')
  .action(async (biosampleId: string, fastqR1: string | undefined, fastqR2: string | undefined, options: ClaraJobOptions) => {
    try {
      await submitClaraCommand(biosampleId, fastqR1, fastqR2, options);
    } catch (error) {
      Logger.error(`Clara job submission failed: ${error}`);
      process.exit(1);
    }
  });

// Agent Health - Check processing agent readiness
program
  .command('agent-health')
  .alias('health')
  .description('Check if GPU processing agent is ready to receive jobs')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed server information')
  .action(async (options: AgentHealthOptions) => {
    try {
      await agentHealthCommand(options);
    } catch (error) {
      Logger.error(`Health check failed: ${error}`);
      process.exit(1);
    }
  });

// Lab Registry - List approved research labs
program
  .command('labnfts')
  .alias('labs')
  .description('List approved research labs authorized to receive BioNFT-licensed data')
  .option('--filter <specialization>', 'Filter by lab specialization (e.g., cancer, rare-disease)')
  .option('--location <location>', 'Filter by location')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed lab information')
  .action(async (options: LabNFTsOptions) => {
    try {
      await labNFTsCommand(options);
    } catch (error) {
      Logger.error(`Failed to fetch labs: ${error}`);
      process.exit(1);
    }
  });

// Share - GDPR-compliant sharing with dual NFT minting
program
  .command('share <biocid_or_filename>')
  .description('Share biofile with approved lab (auto-detects existing tokenization)')
  .requiredOption('--lab <wallet_address>', 'Lab wallet address (use "biofs labnfts" to list approved labs)')
  .option('--license <type>', 'License type: non-commercial (default), commercial, commercial-remix', 'non-commercial')
  .option('--verbose', 'Show detailed progress')
  .option('--debug', 'Show debug information')
  .action(async (biocidOrFilename: string, options: ShareOptions) => {
    try {
      await shareCommand(biocidOrFilename, options);
    } catch (error) {
      Logger.error(`Share failed: ${error}`);
      process.exit(1);
    }
  });

// Shares - View permission graph (who has access to what)
program
  .command('shares')
  .description('View BioNFT permission graph (files shared with you and by you)')
  .option('--json', 'Output as JSON')
  .option('--graphql', 'Show GraphQL schema and sample queries')
  .option('--verbose', 'Show detailed information')
  .action(async (options: SharesOptions) => {
    try {
      await sharesCommand(options);
    } catch (error) {
      Logger.error(`Failed to build permission graph: ${error}`);
      process.exit(1);
    }
  });

// Verify - DNA fingerprint verification
program
  .command('verify <biocid_or_filename> <local_file>')
  .description('Verify file integrity using DNA fingerprint (Bloom filter)')
  .option('--verbose', 'Show detailed information')
  .option('--json', 'Output as JSON')
  .action(async (biocidOrFilename: string, localFile: string, options: VerifyOptions) => {
    try {
      await verifyCommand(biocidOrFilename, localFile, options);
    } catch (error) {
      Logger.error(`Verification failed: ${error}`);
      process.exit(1);
    }
  });

// Dissect - GDPR Data Minimization: Extract phenotype-specific SNPs
// NOW USES SEQUENTIA PROTOCOL BY DEFAULT (solves 0xd4d910b4 Story Protocol error!)
program
  .command('dissect <phenotype_query> <source_file>')
  .description('Extract phenotype-specific SNP subset with AI-powered discovery')
  .option('--share <wallet>', 'Share derivative subset with wallet address')
  .option('--license <type>', 'License type (non-commercial|commercial|commercial-remix)', 'non-commercial')
  .option('--min-snps <number>', 'Minimum SNPs to discover', '10')
  .option('--output <path>', 'Save derivative file locally')
  .option('--use-story-protocol', 'Use Story Protocol instead of Sequentia (legacy)')
  .option('--verbose', 'Show detailed progress')
  .option('--debug', 'Show debug information')
  .action(async (phenotypeQuery: string, sourceFile: string, options: DissectOptions & { useStoryProtocol?: boolean }) => {
    try {
      // Default to Sequentia Protocol (97% cost savings, 0% error rate!)
      // Use --use-story-protocol flag for legacy behavior
      if (options.useStoryProtocol) {
        Logger.warn('⚠️  Using legacy Story Protocol (may encounter 0xd4d910b4 errors)');
        await dissectCommand(phenotypeQuery, sourceFile, options);
      } else {
        // NEW: Sequentia Protocol - Simple, cheap, GDPR-compliant!
        await dissectCommandSequentia(phenotypeQuery, sourceFile, options);
      }
    } catch (error) {
      Logger.error(`Dissect failed: ${error}`);
      process.exit(1);
    }
  });

// View - GDPR Right to Access: View file content
program
  .command('view <biocid_or_filename>')
  .description('View file content by BioCID or filename (GDPR Right to Access)')
  .option('--lines <number>', 'Number of lines to display (default: all)')
  .option('--format <type>', 'Output format: raw, pretty, json', 'raw')
  .option('--verbose', 'Show detailed progress')
  .option('--debug', 'Show debug information')
  .action(async (biocidOrFilename: string, options: ViewOptions) => {
    try {
      await viewCommand(biocidOrFilename, options);
    } catch (error) {
      Logger.error(`View failed: ${error}`);
      process.exit(1);
    }
  });

// Help command
program
  .command('help [command]')
  .description('Display help for a command')
  .action((cmd?: string) => {
    if (cmd) {
      const command = program.commands.find(c => c.name() === cmd);
      if (command) {
        command.outputHelp();
      } else {
        Logger.error(`Unknown command: ${cmd}`);
      }
    } else {
      program.outputHelp();
    }
  });

// Show welcome message if no command
if (process.argv.length === 2) {
  console.log(chalk.cyan('\n╔═════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║  BioFS CLI v2.4.0                           ║'));
  console.log(chalk.cyan('║  BioNFT-Gated S3 + x402 Pay + Kite AI       ║'));
  console.log(chalk.cyan('╚═════════════════════════════════════════════╝\n'));

  console.log('Available commands:');
  console.log(`  ${chalk.green('login')}       - Authenticate with Web3 wallet`);
  console.log(`  ${chalk.green('logout')}      - Clear credentials`);
  console.log(`  ${chalk.green('whoami')}      - Show current wallet`);
  console.log(`  ${chalk.green('report')}      - Health check & diagnostics`);
  console.log(`  ${chalk.green('admin')}       - Admin operations (Sequentia)`);
  console.log(`  ${chalk.green('biofiles')}    - List your BioFiles (all sources)`);
  console.log(`  ${chalk.green('download')}    - Download files (GDPR consent)`);
  console.log(`  ${chalk.green('mount')}       - Mount all files (GDPR consent)`);
  console.log(`  ${chalk.green('mount-remote')} - Mount biosample on agent`);
  console.log(`  ${chalk.green('upload')}      - Upload files`);
  console.log(`  ${chalk.green('tokenize')}    - Tokenize genomic data as BioNFT`);
  console.log(`  ${chalk.green('labnfts')}     - List approved research labs`);
  console.log(`  ${chalk.green('share')}       - Share with lab (dual NFT)`);
  console.log(`  ${chalk.green('shares')}      - View permission graph`);
  console.log(`  ${chalk.green('verify')}      - Verify file integrity (Bloom filter)`);
  console.log(`  ${chalk.green('dissect')}     - Extract phenotype SNPs (GDPR)`);
  console.log(`  ${chalk.green('access')}      - Manage BioNFT access control`);
  console.log(`  ${chalk.green('job')}         - Manage research jobs (BioOS)`);
  console.log(`  ${chalk.green('payment')}     - x402 payments (Avalanche USDC)`);
  console.log(`  ${chalk.green('agent')}       - Kite AI agent management`);
  console.log(`  ${chalk.green('help')}        - Show help\n`);

  console.log('Tokenization subcommands:');
  console.log(`  ${chalk.cyan('tokenize file')} <file>                - Tokenize local genomic file`);
  console.log(`  ${chalk.cyan('tokenize fastqs')} <biosample_serial>  - Mint BioNFT consent for biosample FASTQs`);
  console.log(`  ${chalk.cyan('tokenize biosample')} <serial>         - Mint BioNFT from deployed contract\n`);

  console.log('Derivative linking subcommands:');
  console.log(`  ${chalk.cyan('link clara')} <biosample_serial>       - Mint ClaraJobNFT and link to BioNFT`);
  console.log(`  ${chalk.cyan('family-status')} <serials...>          - Show family pipeline status\n`);

  console.log('x402 Payment subcommands (Avalanche C-Chain):');
  console.log(`  ${chalk.cyan('payment balance')}   - Check USDC balance`);
  console.log(`  ${chalk.cyan('payment pricing')}   - View service pricing`);
  console.log(`  ${chalk.cyan('payment setup')}     - Configure payment wallet`);
  console.log(`  ${chalk.cyan('payment faucet')}    - Get testnet tokens`);
  console.log(`  ${chalk.cyan('payment history')}   - View transaction history\n`);

  console.log('Kite AI Agent subcommands:');
  console.log(`  ${chalk.cyan('agent register')} --all     - Register BioFS agents on Kite`);
  console.log(`  ${chalk.cyan('agent list')}               - List registered agents`);
  console.log(`  ${chalk.cyan('agent status')}             - Check agent health & SLA\n`);

  console.log('Access control subcommands:');
  console.log(`  ${chalk.cyan('access request')} <biocid>            - Request access to asset`);
  console.log(`  ${chalk.cyan('access grant')} <biocid> <wallet>    - Grant access (owner)`);
  console.log(`  ${chalk.cyan('access revoke')} <biocid> <wallet>   - Revoke access (owner)`);
  console.log(`  ${chalk.cyan('access list')} [biocid]             - List permittees or permissions`);
  console.log(`  ${chalk.cyan('access check')} <biocid>            - Check your access level`);
  console.log(`  ${chalk.cyan('access revoke-consent')} [ip_id]    - Revoke YOUR consent (GDPR)\n`);

  console.log('Research job subcommands (BioOS):');
  console.log(`  ${chalk.cyan('job create')} "<prompt>" <file>  - Create research job`);
  console.log(`  ${chalk.cyan('job status')} <job_id>           - Check job status`);
  console.log(`  ${chalk.cyan('job results')} <job_id>          - Get job results`);
  console.log(`  ${chalk.cyan('job list')}                     - List all jobs`);
  console.log(`  ${chalk.cyan('job pipelines')}                - List pipeline templates\n`);

  console.log(`Run ${chalk.cyan('biofs help <command>')} for detailed usage.\n`);
} else {
  // Parse command line arguments
  program.parse(process.argv);
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  Logger.error(`Unexpected error: ${error}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\nInterrupted. Goodbye!');
  process.exit(0);
});

