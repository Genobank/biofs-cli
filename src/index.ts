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
import { credIssueCommand, CredIssueOptions } from './commands/cred/issue';
import { bionftViewCommand, BionftViewOptions } from './commands/bionft/view';
import { bionftRevokeCommand, BionftRevokeOptions } from './commands/bionft/revoke';
import { bionftStatusCommand } from './commands/bionft/status';
import { vaultSetupCommand, VaultSetupOptions } from './commands/vault/setup';
import { vaultMountCommand, VaultMountOptions } from './commands/vault/mount';
import { vaultStatusCommand } from './commands/vault/status';
import { vaultUnmountCommand } from './commands/vault/unmount';
import { credStatusCommand, CredStatusOptions } from './commands/cred/status';
import { credListCommand, CredListOptions } from './commands/cred/list';
import { credRevokeCommand, CredRevokeOptions } from './commands/cred/revoke';
import { uploadFastqCommand, UploadFastqOptions } from './commands/upload-fastq';
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
// v2.7.0: htsget + smart streaming + aliases
import { streamCommand, StreamOptions } from './commands/stream';
import { pipeCommand, PipeOptions } from './commands/pipe';
import { aliasCommand, AliasOptions } from './commands/alias';
import { htsgetServiceInfoCommand, htsgetTicketCommand } from './commands/htsget';
import { submitClaraCommand, ClaraJobOptions } from './commands/job/submit-clara';
import { recallCommand, RecallOptions } from './commands/job/recall';
import { contextCreateCommand, ContextCreateOptions } from './commands/context/create';
import { contextPublishCommand, ContextPublishOptions } from './commands/context/publish';
import { contextVerifyCommand } from './commands/context/verify';
import { contextRevokeCommand, ContextRevokeOptions } from './commands/context/revoke';
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
import { pipelineRunWesCommand, PipelineRunWesOptions } from './commands/pipeline/runWes';
import { routeCheckCommand, routeHealCommand } from './commands/route';
import { annotateStatusCommand, AnnotateStatusOptions } from './commands/annotate/status';
import { paymentBalanceCommand, PaymentBalanceOptions } from './commands/payment/balance';
import { paymentPricingCommand, PaymentPricingOptions } from './commands/payment/pricing';
import { paymentSetupCommand, PaymentSetupOptions } from './commands/payment/setup';
import { paymentFaucetCommand, PaymentFaucetOptions } from './commands/payment/faucet';
import { paymentHistoryCommand, PaymentHistoryOptions } from './commands/payment/history';
import { X402Network } from './types/x402';
import { resolveCommand, ResolveOptions } from './commands/resolve';
import { variantsCommand, VariantsOptions } from './commands/variants';
import { fourierScoreCommand, FourierScoreOptions } from './commands/fourier-score';
import { matchCommand, MatchOptions } from './commands/match';
import { ticketCommand, TicketOptions } from './commands/ticket';
import { scanCommand, ScanOptions } from './commands/scan';
import { inventoryCommand, InventoryOptions } from './commands/inventory';
import { dedupCommand, DedupOptions } from './commands/dedup';
import { fingerprintCommand, FingerprintOptions } from './commands/fingerprint';
import { researcherRegisterCommand, ResearcherRegisterOptions } from './commands/researcher/register';
import { researcherStatusCommand, ResearcherStatusOptions } from './commands/researcher/status';
import { Logger } from './lib/utils/logger';
import { ErrorReporter } from './utils/errorReporter';
import { CredentialsManager } from './lib/auth/credentials';

const program = new Command();

// Global catch-all so uncaught errors in ANY command still reach telemetry.
// Individual commands continue to call ErrorReporter.report directly (e.g.
// mount/umount) for richer context — this is the safety net for the rest.
async function reportAndExit(command: string, err: any, code: number): Promise<never> {
  try {
    const creds = await CredentialsManager.getInstance().loadCredentials().catch(() => null);
    const error = err instanceof Error ? err : new Error(String(err));
    await ErrorReporter.report(command, error, creds?.wallet_address, { argv: process.argv.slice(2) });
  } catch { /* telemetry failure must never block exit */ }
  process.exit(code);
}

process.on('uncaughtException', (err) => {
  Logger.error(`Uncaught: ${err?.message || err}`);
  reportAndExit(process.argv.slice(2).join(' ') || 'unknown', err, 1);
});

process.on('unhandledRejection', (reason) => {
  Logger.error(`UnhandledRejection: ${(reason as any)?.message || reason}`);
  reportAndExit(process.argv.slice(2).join(' ') || 'unknown', reason, 1);
});

// Set up the CLI
program
  .name('biofs')
  .description('BioFS by GenoBank.io - BioNFT-Gated S3 CLI for genomic data')
  .version('3.2.0')
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
  .option('--check <wallet>', 'Check against specific wallet address (e.g., 0x0000000000000000000000000000000000000000)')
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
  .option('--gs-uri <uri>', 'Bypass BioFiles discovery and fetch directly from gs:// URI (for owner-only file inspection)')
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

// ========================================================================
// v2.7.0 — htsget + smart streaming + aliases (Sprint 6)
// ========================================================================
// Mac researchers stream BioNFT-gated VCFs/BAMs through the tools they
// already use (bcftools, samtools, pysam, IGV) with zero FUSE, zero kext.
// `stream` / `view` are the day-to-day commands; `htsget` is for debugging.

// stream - htsget stream to stdout (pipes into any bioinformatics tool)
program
  .command('stream <id>')
  .description('Stream a BioNFT-gated VCF/BAM to stdout via htsget (pipe into bcftools/samtools/pysam)')
  .option('--kind <variants|reads>', 'force datatype (default: auto-detect from filename)')
  .option('--htsget-url <url>', 'override htsget endpoint (default: https://htsget.genobank.app)')
  .option('--annotated', 'stream the OpenCRAVAT-annotated VCF sibling (Phase D) instead of raw')
  .option('-q, --quiet', 'suppress info messages')
  .action(async (id: string, options: StreamOptions) => {
    try {
      await streamCommand(id, options);
    } catch (error: any) {
      Logger.error(`stream failed: ${error?.message || error}`);
      process.exit(6);
    }
  });

// pipe - auto-pipe htsget stream into bcftools/samtools view
// (distinct from the existing `view` command, which prints file content)
program
  .command('pipe <id>')
  .description('Pipe a BioIP stream into bcftools view (VCF) or samtools view (BAM) automatically')
  .option('--tool <bcftools|samtools>', 'force tool (default: auto-detect from filename)')
  .option('--htsget-url <url>', 'override htsget endpoint')
  .option('-q, --quiet', 'suppress info messages')
  .allowUnknownOption(true)
  .action(async (id: string, options: PipeOptions, cmd: any) => {
    try {
      // Everything after `--` is passed through to bcftools/samtools view
      const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
      await pipeCommand(id, { ...options, extra });
    } catch (error: any) {
      Logger.error(`pipe failed: ${error?.message || error}`);
      process.exit(6);
    }
  });

// alias - manage local shortcuts for ip_ids / BioCIDs
program
  .command('alias [name] [target]')
  .description('Manage local aliases for ip_ids (e.g. `biofs alias my-wes 0xCCe14315…`)')
  .option('--list', 'list all aliases (default when no args)')
  .option('--remove <name>', 'remove alias by name')
  .option('--json', 'emit JSON')
  .action(async (name: string | undefined, target: string | undefined, options: AliasOptions) => {
    try {
      await aliasCommand({ ...options, name, target });
    } catch (error: any) {
      Logger.error(`alias failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// htsget - low-level GA4GH htsget operations (service-info, ticket)
const htsgetCmd = program
  .command('htsget')
  .description('Low-level GA4GH htsget operations (see `biofs stream`/`view` for day-to-day use)');

htsgetCmd
  .command('service-info')
  .description('Show htsget endpoint metadata (GA4GH service-info)')
  .option('--json', 'emit JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      await htsgetServiceInfoCommand(options);
    } catch (error: any) {
      Logger.error(`service-info failed: ${error?.message || error}`);
      process.exit(6);
    }
  });

htsgetCmd
  .command('ticket <kind> <id>')
  .description('Fetch a raw htsget ticket for debugging (kind = variants | reads)')
  .action(async (kind: string, id: string) => {
    try {
      if (kind !== 'variants' && kind !== 'reads') {
        Logger.error(`kind must be 'variants' or 'reads' (got '${kind}')`);
        process.exit(2);
      }
      await htsgetTicketCommand(kind as 'variants' | 'reads', id);
    } catch (error: any) {
      Logger.error(`ticket failed: ${error?.message || error}`);
      process.exit(6);
    }
  });

// ========================================================================
// (end v2.7.0 block)
// ========================================================================

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
  .description('Show family genomic pipeline status (BioNFT → ClaraJobNFT → bioroutes.inventory)')
  .argument('<biosample_serials...>', 'Biosample serial numbers')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show detailed information')
  .option('--no-inventory', 'Skip the bioroutes.inventory enrichment (chain-only mode)')
  .option('--bionft-address <addr>', 'Override BioNFT contract (for legacy deployments)')
  .option('--clara-address <addr>', 'Override ClaraJobNFT contract')
  .action(async (biosampleSerials: string[], options: FamilyStatusOptions) => {
    try {
      await familyStatusCommand(biosampleSerials, options);
    } catch (error) {
      Logger.error(`Family status check failed: ${error}`);
      process.exit(1);
    }
  });

// Inventory command - Fast read-only summary of bioroutes.inventory (no GCS walk)
program
  .command('inventory')
  .alias('inv')
  .description('Show what is currently registered in bioroutes.inventory (admin/lab-custodian)')
  .option('--json', 'Output as JSON')
  .option('--buckets', 'List all buckets, not just top 15')
  .option('--verbose', 'Show debug information')
  .action(async (options: InventoryOptions) => {
    try {
      await inventoryCommand(options);
    } catch (error) {
      Logger.error(`Inventory failed: ${error}`);
      process.exit(1);
    }
  });

// Fingerprint command - Submit async fingerprint jobs (background worker uses gcsfuse)
program
  .command('fingerprint')
  .description('Compute real contentHashes for inventory rows via background worker (admin/lab-custodian)')
  .option('--biocid <id>', 'Single biocid to fingerprint')
  .option('--serial <id>', 'Single sample serial')
  .option('--serials <csv>', 'Comma-separated sample serials')
  .option('--filetypes <csv>', 'Filter to filetype list (e.g. vcf,gvcf)')
  .option('--include-superseded', 'Also fingerprint SUPERSEDED rows')
  .option('--limit <n>', 'Max rows to process per job', '50')
  .option('--dry-run', 'Show eligible rows without submitting')
  .option('--json', 'Output as JSON')
  .action(async (options: FingerprintOptions) => {
    try {
      await fingerprintCommand(options);
    } catch (error) {
      Logger.error(`Fingerprint failed: ${error}`);
      process.exit(1);
    }
  });

// Dedup command - Pick canonical biocid per (sample, filetype, basename)
program
  .command('dedup')
  .description('Collapse duplicate biocid registrations to one canonical row (admin/lab-custodian)')
  .option('--serial <id>', 'Single sample serial')
  .option('--serials <csv>', 'Comma-separated sample serials')
  .option('--lab <name>', 'Limit to one originlab')
  .option('--bucket <name>', 'Limit to one bucket')
  .option('--apply', 'Actually mark superseded (default is dry-run)')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show debug information')
  .action(async (options: DedupOptions) => {
    try {
      await dedupCommand(options);
    } catch (error) {
      Logger.error(`Dedup failed: ${error}`);
      process.exit(1);
    }
  });

// Scan command - Walk GCS bucket(s) and register objects in bioroutes.inventory
// Default scope: full canonical bucket fleet. Lab origin inferred per-file.
program
  .command('scan')
  .description('Scan GCS into bioroutes.inventory (per-file lab inference; admin/lab-custodian only)')
  .option('--bucket <name>', 'Single bucket (e.g. genobank-parabricks-output)')
  .option('--buckets <csv>', 'Comma-separated bucket list')
  .option('--prefix <path>', 'Object prefix (requires single --bucket)')
  .option('--filter-lab <name>', 'Register only files whose inferred lab matches')
  .option('--dry-run', 'Preview without writing to MongoDB')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show debug information')
  .action(async (options: ScanOptions) => {
    try {
      await scanCommand(options);
    } catch (error) {
      Logger.error(`Scan failed: ${error}`);
      process.exit(1);
    }
  });

// Annotate command group - OpenCRAVAT VCF annotation
const annotateCmd = program
  .command('annotate')
  .description('Annotate VCF files with OpenCRAVAT (curated panels or all 146 annotators)');

// annotate submit - Submit VCF for annotation
annotateCmd
  .command('submit <biosample_serial>')
  .description('Submit VCF to OpenCRAVAT for annotation with all 146 annotators')
  .option('--vcf-path <path>', 'Manual VCF path override')
  .option('--vcf-uri <uri>', 'GCS or S3 URI for a freshly-minted VCF (skips discovery; used by biofs pipeline)')
  .option('--annotators <list>', 'Custom annotators (comma-separated), defaults to all 146')
  .option('--package <package>', 'Analysis package (rare_coding, hereditary_cancer, splicing, drug_interaction, pathogenic, wes_default, wgs_default)', 'rare_coding')
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

// ~/genobank/vault commands (v2.9.0 · biovault Phase B)
// Portable vault: scaffolds ~/genobank/vault/ with a per-BioNFT subdirectory
// per owned token, then `biofs vault mount` downloads the annotated VCFs via
// htsget. Works on macOS + Linux without macFUSE kernel signing.
const vaultCmd = program
  .command('vault')
  .description('Local ~/genobank/vault — your owned BioNFTs as a real directory tree');

vaultCmd
  .command('setup')
  .description('Scan Sequentia for BioNFTs owned by your wallet and scaffold ~/genobank/vault/')
  .option('--path <dir>', 'override vault path (default: ~/genobank/vault)')
  .option('--force', 're-scaffold even if directory already exists')
  .action(async (options: VaultSetupOptions) => {
    try { await vaultSetupCommand(options); }
    catch (error) { Logger.error(`vault setup failed: ${error}`); process.exit(1); }
  });

vaultCmd
  .command('mount')
  .description('Download BioNFT-gated data (raw + annotated VCFs) into the vault')
  .option('--path <dir>', 'override vault path (default: ~/genobank/vault)')
  .option('--refresh', 'force re-download of existing files')
  .option('--skip-annotated', 'download only raw VCFs, skip OpenCRAVAT annotations')
  .option('--categories <csv>', 'comma-separated BioNFT categories to mount', 'DATA_FILE_CHILD')
  .action(async (options: VaultMountOptions) => {
    try { await vaultMountCommand(options); }
    catch (error) { Logger.error(`vault mount failed: ${error}`); process.exit(1); }
  });

vaultCmd
  .command('status')
  .description('Show vault state: wallet, BioNFT inventory, per-token file sizes')
  .option('--path <dir>', 'override vault path')
  .action(async (options: { path?: string }) => {
    try { await vaultStatusCommand(options); }
    catch (error) { Logger.error(`vault status failed: ${error}`); process.exit(1); }
  });

vaultCmd
  .command('unmount')
  .description('Remove local cache. Manifest preserved unless --purge.')
  .option('--path <dir>', 'override vault path')
  .option('--purge', 'delete the whole vault dir (manifest + all files)')
  .option('--force', 'skip confirmation prompt')
  .action(async (options: { path?: string; purge?: boolean; force?: boolean }) => {
    try { await vaultUnmountCommand(options); }
    catch (error) { Logger.error(`vault unmount failed: ${error}`); process.exit(1); }
  });

// BioNFT on-chain commands (v2.9.0 · biovault Phase F)
// Read/revoke any BioNFT (BIOSAMPLE_PARENT, DATA_FILE_CHILD, RENT_AGREEMENT,
// INGEST_TICKET) directly from Sequentia. No REST hop — ethers talks to the
// deployed contracts. This replaces `biofs cred revoke` for on-chain credentials
// and fixes the CherryPy DELETE-body bug we hit in Phase A.7.
const bionftCmd = program
  .command('bionft')
  .description('View and revoke BioNFTs directly on Sequentia (biovault Phase F)');

bionftCmd
  .command('view <tokenId>')
  .description('Show on-chain state + metadata for any BioNFT tokenId')
  .option('--json', 'Output as JSON')
  .action(async (tokenId: string, options: BionftViewOptions) => {
    try {
      await bionftViewCommand(tokenId, options);
    } catch (error) {
      Logger.error(`bionft view failed: ${error}`);
      process.exit(1);
    }
  });

bionftCmd
  .command('status <tokenId>')
  .description('One-line on-chain status of a BioNFT')
  .action(async (tokenId: string) => {
    try {
      await bionftStatusCommand(tokenId);
    } catch (error) {
      Logger.error(`bionft status failed: ${error}`);
      process.exit(1);
    }
  });

bionftCmd
  .command('revoke <tokenId>')
  .description('Patient-signed on-chain revoke. RENT_AGREEMENT or INGEST_TICKET only. Requires GENOBANK_OWNER_PRIVATE_KEY.')
  .option('--reason <text>', 'Why you are revoking', 'user_cli')
  .option('--force', 'Skip confirmation prompt')
  .action(async (tokenId: string, options: BionftRevokeOptions) => {
    try {
      await bionftRevokeCommand(tokenId, options);
    } catch (error) {
      Logger.error(`bionft revoke failed: ${error}`);
      process.exit(1);
    }
  });

// Scoped write-only credential commands (v2.8.0 · biovault Phase A)
const credCmd = program
  .command('cred')
  .description('Scoped write-only FASTQ/BAM/VCF upload credentials (biovault)');

credCmd
  .command('issue')
  .description('Issue a single-use write credential for a biosample (requires BIOFS_LAB_PRIVATE_KEY)')
  .requiredOption('--biosample <serial>', 'Biosample serial (e.g. 55052008714049)')
  .requiredOption('--kind <kind>', 'FASTQ | FASTQ_R1 | FASTQ_R2 | BAM | VCF | GVCF', 'FASTQ_R1')
  .option('--lab-id <id>', 'Laboratory ID (or $GENOBANK_LABORATORY_ID)', (v) => parseInt(v, 10))
  .option('--source-file <path>', 'Compute size + sha256 from this file (required unless --size/--sha256 given)')
  .option('--size <bytes>', 'Estimated upload size in bytes', (v) => parseInt(v, 10))
  .option('--sha256 <hex>', 'Claimed SHA256 hash (64 hex chars)')
  .option('--filename <name>', 'Logical filename to record server-side')
  .option('--json', 'Output as JSON')
  .action(async (options: CredIssueOptions) => {
    try {
      await credIssueCommand(options);
    } catch (error) {
      Logger.error(`cred issue failed: ${error}`);
      process.exit(1);
    }
  });

credCmd
  .command('status <cred_id>')
  .description('Show the current state of a credential')
  .option('--json', 'Output as JSON')
  .action(async (credId: string, options: CredStatusOptions) => {
    try {
      await credStatusCommand(credId, options);
    } catch (error) {
      Logger.error(`cred status failed: ${error}`);
      process.exit(1);
    }
  });

credCmd
  .command('list')
  .description('List credentials for a biosample')
  .option('--biosample <serial>', 'Biosample serial')
  .option('--status <status>', 'Filter by status (issued|consumed|quarantined|burned)')
  .option('--json', 'Output as JSON')
  .action(async (options: CredListOptions) => {
    try {
      await credListCommand(options);
    } catch (error) {
      Logger.error(`cred list failed: ${error}`);
      process.exit(1);
    }
  });

credCmd
  .command('revoke <cred_id>')
  .description('Owner-signed burn of an unused credential (requires GENOBANK_OWNER_PRIVATE_KEY)')
  .option('--reason <text>', 'Why you are burning this credential', 'user_cli')
  .option('--force', 'Skip confirmation prompt')
  .action(async (credId: string, options: CredRevokeOptions) => {
    try {
      await credRevokeCommand(credId, options);
    } catch (error) {
      Logger.error(`cred revoke failed: ${error}`);
      process.exit(1);
    }
  });

// upload-fastq: thin wrapper around the Python genobank-upload CLI (resumable + resume buffer)
program
  .command('upload-fastq <file>')
  .description('Upload a FASTQ/BAM/VCF via scoped credential + GCS resumable (wraps genobank-upload)')
  .requiredOption('--biosample <serial>', 'Biosample serial')
  .option('--kind <kind>', 'FASTQ | FASTQ_R1 | FASTQ_R2 | BAM | VCF | GVCF', 'FASTQ_R1')
  .option('--lab-id <id>', 'Laboratory ID (or $GENOBANK_LABORATORY_ID)', (v) => parseInt(v, 10))
  .option('--api-base <url>', 'Override API base URL')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON on completion')
  .action(async (file: string, options: UploadFastqOptions) => {
    try {
      await uploadFastqCommand(file, options);
    } catch (error) {
      Logger.error(`upload-fastq failed: ${error}`);
      process.exit(1);
    }
  });

// BioContext manifest commands (v2.6.0)
const contextCmd = program
  .command('context')
  .description('Create, publish, verify, revoke .bionft BioContext manifests (EIP-712 signed)');

contextCmd
  .command('create <caseId>')
  .description('Build + EIP-712 sign a .bionft manifest for a caseId (e.g. TN25-336147)')
  .option('--kind <string>', 'Manifest kind', 'CancerDigitalTwin')
  .option('--pil <n>', 'BioPIL license id (1-9)', '5')
  .option('--commercial', 'Commercial use permitted')
  .option('--deny-purpose <csv>', 'Denied purposes, comma-separated')
  .option('--allow-skill <csv>', 'Allowed skills, comma-separated')
  .option('--deny-skill <csv>', 'Denied skills, comma-separated')
  .option('--deadline <dur>', 'Manifest TTL (e.g. 30d)', '30d')
  .option('--expires <dur>', 'Consent TTL (e.g. 365d)', '365d')
  .option('--narrative <path>', 'Path to .bio.md file')
  .option('--output <path>', 'Output .bionft path')
  .option('--include-files <csv>', 'BioCIDs to include non-interactively')
  .option('--private-key <key>', 'Signing key (or BIOFS_SIGNING_KEY env)')
  .option('--yes', 'No prompts; include all files')
  .action(async (caseId: string, options: ContextCreateOptions) => {
    try {
      await contextCreateCommand(caseId, options);
    } catch (error) {
      Logger.error(`context create failed: ${error}`);
      process.exit(1);
    }
  });

contextCmd
  .command('publish <bionft_file>')
  .description('Upload a signed .bionft to biorouter.genobank.app')
  .option('--force', 'Publish even if local verification fails')
  .action(async (file: string, options: ContextPublishOptions) => {
    try {
      await contextPublishCommand(file, options);
    } catch (error) {
      Logger.error(`context publish failed: ${error}`);
      process.exit(1);
    }
  });

contextCmd
  .command('verify <bionft_file>')
  .description('Local verification: EIP-712 sig, hashes, Merkle proofs, deadline')
  .action(async (file: string) => {
    try {
      await contextVerifyCommand(file);
    } catch (error) {
      Logger.error(`context verify failed: ${error}`);
      process.exit(1);
    }
  });

contextCmd
  .command('revoke <caseId_or_file>')
  .description('Revoke every BioCID in the manifest (GDPR Article 17)')
  .option('--yes', 'Skip confirmation')
  .option('--reason <string>', 'Revocation reason')
  .action(async (key: string, options: ContextRevokeOptions) => {
    try {
      await contextRevokeCommand(key, options);
    } catch (error) {
      Logger.error(`context revoke failed: ${error}`);
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

// job recall - Naive DeepVariant from pre-aligned BAM (no kit restriction)
jobCmd
  .command('recall <sample_id>')
  .description('Run naive (no-kit) DeepVariant from a BAM already on the GPU VM')
  .requiredOption('--bam <vm_path>', 'BAM path on GPU VM (host path, e.g. /home/ubuntu/data/output/A014/A014.bam)')
  .option('--json', 'Output as JSON')
  .action(async (sampleId: string, options: RecallOptions) => {
    try {
      await recallCommand(sampleId, options);
    } catch (error) {
      Logger.error(`Recall failed: ${error}`);
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

// Researcher registration and identity (multi-provider social + MetaMask)
const researcherCmd = program
  .command('researcher')
  .description('Researcher identity — register via ORCID, Google, LinkedIn, Twitter, Apple, or MetaMask');

researcherCmd
  .command('register')
  .description('Register as a researcher (opens browser for social or MetaMask sign-in)')
  .option('--port <number>', 'Callback server port', parseInt)
  .option('--no-browser', "Don't auto-open browser (headless mode)")
  .option('--timeout <seconds>', 'Auth timeout in seconds', parseInt)
  .option('--provider <provider>', 'Force a specific provider (orcid, google, linkedin, twitter, apple, metamask)')
  .action(async (options: ResearcherRegisterOptions) => {
    try {
      await researcherRegisterCommand(options);
    } catch (error) {
      Logger.error(`Researcher registration failed: ${error}`);
      process.exit(1);
    }
  });

researcherCmd
  .command('status')
  .description('Show your researcher profile and credentials')
  .option('--json', 'Output as JSON')
  .option('--refresh', 'Refresh profile from server')
  .action(async (options: ResearcherStatusOptions) => {
    try {
      await researcherStatusCommand(options);
    } catch (error) {
      Logger.error(`Researcher status failed: ${error}`);
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

// Fourier-score — Cosic RRM EIIP+DFT biophysical scoring of missense variants
program
  .command('fourier-score <variants>')
  .description('Cosic-RRM EIIP+DFT biophysical scoring of missense variants (returns Σ|ΔF|, max|ΔF| as biophysical complement to REVEL/AlphaMissense)')
  .option('--window <N>', 'Window size for non-TM residues (default: 31, must be odd)')
  .option('--window-tm <N>', 'Window size for TM-residue variants (default: 51, must be odd)')
  .option('--uniprot <accession>', 'Override UniProt accession (for single variant or unknown gene)')
  .option('--format <type>', 'Output format: table | tsv | json (default: table)', 'table')
  .option('--output <path>', 'Write output to file instead of stdout')
  .option('--plot <path>', 'Render |ΔF| spectrum to PNG (one panel per variant)')
  .option('--quiet', 'Suppress progress output')
  .action(async (variants: string, options: FourierScoreOptions) => {
    try {
      await fourierScoreCommand(variants, options);
    } catch (error) {
      Logger.error(`Fourier scoring failed: ${error}`);
      process.exit(1);
    }
  });

// Variants — query annotated variants from the latest OpenCRAVAT sqlite
program
  .command('variants <biosample_serial>')
  .description('Query annotated variants from the latest OpenCRAVAT sqlite for a biosample (gene/region/SO/AF/ClinVar filters)')
  .option('--gene <symbols>', 'Comma-separated HUGO gene symbols (e.g. ITGA2B,ITGB3)')
  .option('--region <chr:start-end>', 'Genomic region (e.g. chr17:44372210-44511666)')
  .option('--so <terms>', 'Sequence-ontology terms or "all" (default: missense+LoF+canonical splice)')
  .option('--max-af <number>', 'Population AF cap across gnomAD3/4 + AllOfUs (default: 0.01)')
  .option('--clinvar <class>', 'ClinVar significance filter: patho|likely|vus|benign|all (default: all)')
  .option('--columns <names>', 'Comma-separated annotator columns to display (default panel)')
  .option('--format <type>', 'Output format: table | tsv | json (default: table)', 'table')
  .option('--output <path>', 'Write output to file instead of stdout')
  .option('--refresh', 'Re-download sqlite even if cached')
  .option('--sqlite-uri <gsuri>', 'Override biorouter resolution with an explicit gs://....sqlite URI')
  .option('--job-id <timestamp>', 'Require a specific OC job timestamp (e.g. 260411-053533)')
  .option('--quiet', 'Suppress progress output')
  .option('--debug', 'Show route-resolver stdout for debugging')
  .action(async (biosampleSerial: string, options: VariantsOptions) => {
    try {
      await variantsCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`Variant query failed: ${error}`);
      process.exit(1);
    }
  });

// Resolve - BioRoutes on-chain route resolution (Phase G.2)
program
  .command('resolve <biocid_or_fingerprint>')
  .description('Resolve a biocid or fingerprint to its storage route via BioRoutes on-chain (Sequentia)')
  .option('--by-fingerprint', 'Treat the argument as a contentHash fingerprint instead of a biocid')
  .option('--verify', 'Verify that the resolved URI is accessible and fingerprint matches')
  .option('--dispute', 'If --verify detects mismatch, submit RouteDisputed tx on-chain')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show debug information')
  .action(async (identifier: string, options: ResolveOptions) => {
    try {
      await resolveCommand(identifier, options);
    } catch (error) {
      Logger.error(`Resolve failed: ${error}`);
      process.exit(1);
    }
  });

// Match - 3-stage privacy-preserving SNP match (ICISSP 2024 Figure 1)
program
  .command('match')
  .description('Match SNPs against an owner corpus via Bloom/accumulator (Matcher → Ticket → Resolver)')
  .requiredOption('--owner <wallet>', 'Owner wallet address to match against')
  .option('--snps <list>', 'Comma-separated SNPs in rsid:chrom:pos:genotype format')
  .option('--snp-file <path>', 'File with one SNP per line (rsid:chrom:pos:genotype)')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show debug information')
  .action(async (options: MatchOptions) => {
    try {
      await matchCommand(options);
    } catch (error) {
      Logger.error(`Match failed: ${error}`);
      process.exit(1);
    }
  });

// Ticket - Privacy ticket management (ICISSP 2024 §6)
program
  .command('ticket')
  .description('List or revoke privacy tickets (BioNFTCredentials-bound access tokens)')
  .option('--list', 'List active tickets (default)')
  .option('--revoke <ticketId>', 'Revoke a ticket by ID (burns BioNFTCredentials token)')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show debug information')
  .action(async (options: TicketOptions) => {
    try {
      await ticketCommand(options);
    } catch (error) {
      Logger.error(`Ticket command failed: ${error}`);
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

// Pipeline command group — end-to-end FASTQ → Digital Twin orchestration
const pipelineCmd = program
  .command('pipeline')
  .description('End-to-end agentic pipeline (FASTQ → Clara → CRAVAT → Vault → Digital Twin)');

pipelineCmd
  .command('run-wes <biosample_serial>')
  .description('Run the full WES/WGS pipeline on a biosample, producing a Digital Twin URL')
  .option('--mode <WES|WGS>', 'Override auto-detection (WES or WGS)')
  .option('--bed <path>', 'Override interval BED path (forces WES)')
  .option('--phase <range>', 'Run a subset of phases (e.g. "1-4", "5-10", or "all")')
  .option('--run-id <id>', 'Resume an existing pipeline run by id')
  .option('--watch', 'Stream Parabricks pipeline log live')
  .option('--dry-run', 'Print what would happen but don\'t execute side-effecting phases')
  .option('--skip-twin', 'Skip phase 9 (Digital Twin HTML render)')
  .option('--remote', 'Force SSH-to-prod execution even if local orchestrator exists')
  .option('--mongo-uri <uri>', 'MongoDB connection string (default: localhost:27017 on the executor)')
  .option('--json', 'Emit raw JSON-line events instead of pretty output')
  .action(async (biosampleSerial: string, options: PipelineRunWesOptions) => {
    try {
      const rc = await pipelineRunWesCommand(biosampleSerial, options);
      process.exit(rc);
    } catch (error) {
      Logger.error(`pipeline run-wes failed: ${error}`);
      process.exit(1);
    }
  });

// BioRouter route resolver — diagnose and heal gcsfuse mounts on compute nodes
const routeCmd = program
  .command('route')
  .description('BioRouter route resolver — lint & heal gcsfuse mounts for biosamples');

routeCmd
  .command('check <biosample_serial...>')
  .description('Resolve every route for the given biosample(s) and report mount status')
  .option('--json', 'Emit raw JSON output instead of pretty table')
  .action(async (serials: string[], options) => {
    await routeCheckCommand(serials, options);
  });

routeCmd
  .command('heal <biosample_serial...>')
  .description('Mount every bucket required by the biosamples on a compute node')
  .option('--node <user@host>', 'Target node (default: parabricks-gpu-spot@10.128.0.7)')
  .option('--json', 'Emit raw JSON output')
  .action(async (serials: string[], options) => {
    await routeHealCommand(serials, options);
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
  console.log(chalk.cyan('║  BioFS CLI v3.2.0                           ║'));
  console.log(chalk.cyan('║  BioNFT-Gated Genomics + Researcher ID      ║'));
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
  console.log(`  ${chalk.green('researcher')}  - Register & manage researcher identity`);
  console.log(`  ${chalk.green('labnfts')}     - List approved research labs`);
  console.log(`  ${chalk.green('share')}       - Share with lab (dual NFT)`);
  console.log(`  ${chalk.green('shares')}      - View permission graph`);
  console.log(`  ${chalk.green('verify')}      - Verify file integrity (Bloom filter)`);
  console.log(`  ${chalk.green('resolve')}     - Resolve biocid via BioRoutes (on-chain)`);
  console.log(`  ${chalk.green('match')}       - Privacy-preserving SNP match (3-stage)`);
  console.log(`  ${chalk.green('ticket')}      - Manage privacy tickets`);
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

  console.log('Researcher subcommands:');
  console.log(`  ${chalk.cyan('researcher register')}           - Register via ORCID, Google, LinkedIn, MetaMask, etc.`);
  console.log(`  ${chalk.cyan('researcher status')}             - View your researcher profile\n`);

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

