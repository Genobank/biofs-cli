#!/usr/bin/env node

import { Command } from 'commander';
// FLUENCY_LINEAGE_VERBS_20260730
import { fluencyBuildCommand, fluencyStateCommand } from './commands/fluency';
// CONSENT_VERBS_20260730
import { consentPayloadCommand, consentSubmitCommand } from './commands/consent';
import { lineageCommand } from './commands/lineage';
// BIODATA_ROOM_20260801: dual profiles + researcher biodata room
import {
  profileListCommand, profileUseCommand, profileStatusCommand, ProfileOptions,
} from './commands/profile';
import {
  roomCreateCommand, roomRequestCommand, roomStatusCommand, roomAdmitCommand,
  roomRevokeCommand, roomListCommand, roomEnterCommand, roomLeaveCommand,
  roomFilesCommand, roomSigningUrlCommand, RoomOptions,
} from './commands/room';
import { BIOFS_VERSION } from './version';
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
// v3.18.0: TeleBioinformatics (`biofs tele`) + region stream
import { streamCommand, StreamOptions } from './commands/stream';
import { pipeCommand, PipeOptions } from './commands/pipe';
import { aliasCommand, AliasOptions } from './commands/alias';
import { htsgetServiceInfoCommand, htsgetTicketCommand } from './commands/htsget';
import {
  teleToolsCommand,
  teleStatsCommand,
  teleHeaderCommand,
  teleFlagstatCommand,
  teleCountCommand,
  teleRegionCommand,
  teleQueryCommand,
  teleFilterCommand,
  teleViewCommand,
  teleSeqkitCommand,
  teleSeqtkCommand,
  teleBedtoolsCommand,
  teleVtCommand,
  teleMosdepthCommand,
  teleIgvCommand,
  teleJupyterCommand,
  telePysamCommand,
  teleStreamCommand,
  teleTicketCommand,
  TeleCommonCli,
} from './commands/tele';
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
import { imagingPullCommand, ImagingPullOptions } from './commands/imaging/submit';
import { imagingTwinCommand, ImagingTwinOptions } from './commands/imaging/twin';
import { imagingAttributeCommand, ImagingAttributeOptions } from './commands/imaging/attribute';
import { imagingTrajectoryCommand, ImagingTrajectoryOptions } from './commands/imaging/trajectory';
import { imagingLesionsCommand, ImagingLesionsOptions } from './commands/imaging/lesions';
import { imagingFindingsCommand, ImagingFindingsOptions } from './commands/imaging/findings';
import { imagingCharacterizeCommand, ImagingCharacterizeOptions } from './commands/imaging/characterize';
import { imagingEnrichCommand, ImagingEnrichOptions } from './commands/imaging/enrich';
import { imagingCompareCommand, ImagingCompareOptions } from './commands/imaging/compare';
import { methylSubmitCommand, MethylSubmitOptions } from './commands/methyl/submit';
import { methylExecCommand, MethylExecOptions } from './commands/methyl/exec';
import { alignShardSubmitCommand, AlignShardSubmitOptions } from './commands/align-shard/submit';
import { alignShardExecCommand, AlignShardExecOptions } from './commands/align-shard/exec';
import { comethylSubmitCommand, ComethylSubmitOptions } from './commands/comethyl/submit';
import { comethylExecCommand, ComethylExecOptions } from './commands/comethyl/exec';
import { svCallSubmitCommand, SvCallSubmitOptions } from './commands/sv-call/submit';
import { svCallExecCommand, SvCallExecOptions } from './commands/sv-call/exec';
import { qcSubmitCommand, QcSubmitOptions } from './commands/qc/submit';
import { qcExecCommand, QcExecOptions } from './commands/qc/exec';
import { verkkoSubmitCommand, VerkkoSubmitOptions } from './commands/verkko/submit';
import { verkkoExecCommand, VerkkoExecOptions } from './commands/verkko/exec';
import { ontVariantsSubmitCommand, OntVariantsSubmitOptions } from './commands/ont-variants/submit';
import { ontVariantsExecCommand, OntVariantsExecOptions } from './commands/ont-variants/exec';
import { hifiAlignSubmitCommand, HifiAlignSubmitOptions } from './commands/hifi-align/submit';
import { hifiAlignExecCommand, HifiAlignExecOptions } from './commands/hifi-align/exec';
import { pbsvSubmitCommand, PbsvSubmitOptions } from './commands/pbsv/submit';
import { pbsvExecCommand, PbsvExecOptions } from './commands/pbsv/exec';
import { repeatGenotypeSubmitCommand, RepeatGenotypeSubmitOptions } from './commands/repeat-genotype/submit';
import { repeatGenotypeExecCommand, RepeatGenotypeExecOptions } from './commands/repeat-genotype/exec';
import { phaseSubmitCommand, PhaseSubmitOptions } from './commands/phase/submit';
import { phaseExecCommand, PhaseExecOptions } from './commands/phase/exec';
import { hifiDeepvariantSubmitCommand, HifiDeepvariantSubmitOptions } from './commands/hifi-deepvariant/submit';
import { hifiDeepvariantExecCommand, HifiDeepvariantExecOptions } from './commands/hifi-deepvariant/exec';
import { somaticMutectSubmitCommand, SomaticMutectSubmitOptions } from './commands/somatic-mutect/submit';
import { somaticMutectExecCommand, SomaticMutectExecOptions } from './commands/somatic-mutect/exec';
import { somaticMutectFilterCommand, SomaticMutectFilterOptions } from './commands/somatic-mutect/filter';
import { liftoverSubmitCommand, LiftoverSubmitOptions } from './commands/liftover/submit';
import { liftoverExecCommand, LiftoverExecOptions } from './commands/liftover/exec';
import { dipcallSubmitCommand, DipcallSubmitOptions } from './commands/dipcall/submit';
import { dipcallExecCommand, DipcallExecOptions } from './commands/dipcall/exec';
import { hifiMethylSubmitCommand, HifiMethylSubmitOptions } from './commands/hifi-methyl/submit';
import { hifiMethylExecCommand, HifiMethylExecOptions } from './commands/hifi-methyl/exec';
import {
  workspaceOpenCommand, workspaceReadCommand, workspaceAppendCommand,
  workspaceCaseCommand, workspaceLeaseCommand, workspaceReplayCommand,
  workspaceAnchorCommand, workspaceClassifyCommand, workspaceConsensusCommand,
  workspaceExportCommand, workspaceVerifyCommand, WorkspaceOptions,
} from './commands/workspace';
import { duetCommand, DuetOptions } from './commands/duet';
import { benchmarkCommand, BenchmarkOptions, benchmarkPrepareCommand, PrepareOptions } from './commands/benchmark';
import { pipelineRunWesCommand, PipelineRunWesOptions } from './commands/pipeline/runWes';
import { routeCheckCommand, routeHealCommand } from './commands/route';
import { routeAnchorCommand, RouteAnchorOptions } from './commands/route/anchor';
import { annotateStatusCommand, AnnotateStatusOptions } from './commands/annotate/status';
import { createX402Command } from './commands/x402';
import { interpretSubmitCommand, InterpretSubmitOptions } from './commands/interpret/submit';
import { interpretStatusCommand, InterpretStatusOptions } from './commands/interpret/status';
import { ancestrySomosCommand, AncestrySomosOptions } from './commands/ancestry/somos';
import { ancestryStatusCommand, AncestryStatusOptions } from './commands/ancestry/status';
import { ancestryIngestCommand, AncestryIngestOptions } from './commands/ancestry/ingest';
import {
  ancestryShareCommand, AncestryShareOptions,
  ancestrySharesCommand, AncestrySharesOptions,
  ancestryRevokeCommand, AncestryRevokeOptions,
} from './commands/ancestry/share';
import { agentRegisterSequentiaCommand, AgentRegisterSequentiaOptions } from './commands/agent/register-sequentia';
import { agentListSequentiaCommand, AgentListSequentiaOptions } from './commands/agent/list-sequentia';
import { paymentBalanceCommand, PaymentBalanceOptions } from './commands/payment/balance';
import { paymentPricingCommand, PaymentPricingOptions } from './commands/payment/pricing';
import { paymentSetupCommand, PaymentSetupOptions } from './commands/payment/setup';
import { paymentFaucetCommand, PaymentFaucetOptions } from './commands/payment/faucet';
import { paymentHistoryCommand, PaymentHistoryOptions } from './commands/payment/history';
import { X402Network } from './types/x402';
import { resolveCommand, ResolveOptions } from './commands/resolve';
import { variantsCommand, VariantsOptions } from './commands/variants';
import { queryCommand, QueryOptions } from './commands/query';
import { eraseCommand, EraseOptions } from './commands/erase';
import { fourierScoreCommand, FourierScoreOptions } from './commands/fourier-score';
import { rrmConsensusCommand, RrmConsensusOptions } from './commands/rrm-consensus';
import { psmConsensusCommand, PsmConsensusOptions } from './commands/psm-consensus';
import { bodeCommand, BodeOptions } from './commands/bode';
import { waveletConsensusCommand, WaveletConsensusOptions } from './commands/wavelet-consensus';
import { tokenizeSpectrumCommand, TokenizeSpectrumOptions } from './commands/tokenize-spectrum';
import { inventoryRegisterSqliteCommand, InventoryRegisterSqliteOptions } from './commands/inventory-register-sqlite';
import { ingestRnaTpmCommand, IngestRnaTpmOptions } from './commands/ingest-rna-tpm';
import { scoreProteinCommand, ScoreProteinOptions } from './commands/score-protein';
import { rrmDistributionCommand, RrmDistributionOptions } from './commands/rrm-distribution';
import { rrmTrainCommand, RrmTrainOptions } from './commands/rrm-train';
import { cohortTrainCommand, CohortTrainOptions } from './commands/cohort-train';
import { myvariantCommand, MyVariantOptions } from './commands/myvariant';
import { cohortAcmgCommand, CohortAcmgOptions } from './commands/cohort-acmg';
import { clinicalCommand, ClinicalOptions } from './commands/clinical';
import { cohortFourierScoreCommand, CohortFourierScoreOptions } from './commands/cohort-fourier-score';
import { biowalletCreateCommand, BiowalletCreateOptions } from './commands/biowallet/create';
import { biowalletListCommand, BiowalletListOptions } from './commands/biowallet/list';
import { biowalletBindCommand, BiowalletBindOptions } from './commands/biowallet/bind';
import { labRefreshCoverageCommand, labRefreshCoverageStatusCommand, LabRefreshCoverageOptions } from './commands/lab/refreshCoverage';
import { familyCreateCommand, familyDeriveCommand, familyListCommand, FamilyCreateOptions, FamilyDeriveOptions, FamilyListOptions } from './commands/biowallet/family';
import { matchCommand, MatchOptions } from './commands/match';
import { ticketCommand, TicketOptions } from './commands/ticket';
import { scanCommand, ScanOptions } from './commands/scan';
import { inventoryCommand, InventoryOptions } from './commands/inventory';
import { samplesListCommand, SamplesListOptions } from './commands/samples';
import { cassetteCommand, CassetteOptions } from './commands/cassette';
import { hlaTypeSubmitCommand, HlaTypeOptions } from './commands/hla-type/submit';
import { cancermapRegenCommand, CancermapRegenOptions } from './commands/cancermap/regen';
import { inventoryCohortCommand, InventoryCohortOptions } from './commands/inventory/cohort';
import { jobReconcileCommand, JobReconcileOptions } from './commands/job/reconcile';
import { cohortPipelineCommand, CohortPipelineOptions } from './commands/cohort-pipeline';
import { dedupCommand, DedupOptions } from './commands/dedup';
import { claimCommand, ClaimOptions } from './commands/claim';
import { fingerprintCommand, FingerprintOptions } from './commands/fingerprint';
import { researcherRegisterCommand, ResearcherRegisterOptions } from './commands/researcher/register';
import { researcherStatusCommand, ResearcherStatusOptions } from './commands/researcher/status';
import {
  researcherPassportPublishCommand,
  researcherPassportShowCommand,
  PassportOptions,
} from './commands/researcher/passport';
import { redactArgv } from './utils/errorReporter';
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
    await ErrorReporter.report(command, error, creds?.wallet_address, { argv: redactArgv(process.argv.slice(2)) });
  } catch { /* telemetry failure must never block exit */ }
  process.exit(code);
}

process.on('uncaughtException', (err) => {
  Logger.error(`Uncaught: ${err?.message || err}`);
  reportAndExit(redactArgv(process.argv.slice(2)).join(' ') || 'unknown', err, 1);
});

process.on('unhandledRejection', (reason) => {
  Logger.error(`UnhandledRejection: ${(reason as any)?.message || reason}`);
  reportAndExit(redactArgv(process.argv.slice(2)).join(' ') || 'unknown', reason, 1);
});

// Set up the CLI
program
  .name('biofs')
  .description('BioFS by GenoBank.io - BioNFT-Gated S3 CLI for genomic data')
  .version(BIOFS_VERSION)
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

// x402 command group - Sequentia micropayments + agentic Cancer Digital Twin pipeline
program.addCommand(createX402Command());

// BioFiles command - Comprehensive discovery across all GenoBank data sources
program
  .command('biofiles')
  .alias('files')  // Keep 'files' as alias for backward compatibility
  .alias('ls')
  .description('Discover all your BioFiles from GenoBank ecosystem (Story Protocol, Avalanche, S3, BioIP)')
  .option('--filter <type>', 'Filter by file type (bam, vcf, sqlite, fastq, ...). Aliases: sqlite=opencravat/.pas, vcf=gvcf, bam=cram')
  .option('--source <source>', 'Filter by source (story, avalanche, s3, biofs, biorouter)')
  .option('--wallet <address>', "Admin: list another wallet's files (e.g. a custodian's). Bypasses cache.")
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
  .command('mount <target> [mount_point]')
  .description('Mount a biosample as a consent-gated read-only filesystem')
  .addHelpText('after', `
Examples:
  biofs mount DNA_TN25-336147.vcf /mnt/study     mount one biosample (FUSE)
  biofs mount TN25-336147 /mnt/study             the bare serial also resolves
  biofs mount ./my-files                         legacy: copy granted files here

Every read is re-authorized server-side against the BioNFT consent grant on
Sequentia. If the owner revokes, reads on the already-mounted filesystem begin
failing with Permission denied, without unmounting.`)
  .option('--method <type>', 'fuse (consent-gated filesystem, default), copy, or nfs (legacy)', 'fuse')
  .option('--biocid <biocid>', 'Mount specific BioCID (copy method)')
  .option('--port <number>', 'NFS server port (legacy nfs method)', parseInt)
  .option('--api-url <url>', 'Gateway base URL (default: https://genobank.app)')
  .option('--consent-ttl <seconds>', 'Seconds before the driver re-verifies consent', parseInt)
  .option('--allow-other', 'Let other local users read the mount (needs user_allow_other)')
  .option('--foreground', 'Run in the foreground and stream driver logs')
  .option('--read-only', 'Mount as read-only')
  .option('--quiet', 'Suppress output')
  .option('--skip-consent', 'Skip GDPR consent (for automation)')
  .action(async (target: string, mountPoint: string | undefined, options: MountOptions) => {
    try {
      await mountCommand(target, mountPoint, options);
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
  .option('--server <url>', 'FUSE API URL (default https://genobank.app/api_biofs_fuse)')
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
  .option('--server <url>', 'FUSE API URL (default https://genobank.app/api_biofs_fuse)')
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
  .option('--server <url>', 'FUSE API URL (default https://genobank.app/api_biofs_fuse)')
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
  .option('--server <url>', 'FUSE API URL (default https://genobank.app/api_biofs_fuse)')
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
  .description('Stream a BioNFT-gated VCF/BAM/CRAM/FASTQ to stdout via htsget (pipe into bcftools/samtools/pysam/seqkit)')
  .option('--kind <variants|reads>', 'force datatype (default: auto-detect from filename)')
  .option('--htsget-url <url>', 'override htsget endpoint (default: https://htsget.genobank.app)')
  .option('--annotated', 'stream the OpenCRAVAT-annotated VCF sibling (Phase D) instead of raw')
  .option('--region <chr:start-end>', 'genomic region (forwarded to htsget; client tools may also filter)')
  .option('--referenceName <chr>', 'htsget referenceName (alias of region chrom)')
  .option('--start <n>', 'htsget start (0-based if set with --referenceName)')
  .option('--end <n>', 'htsget end')
  .option('--raw', 'treat as raw byte stream (still via htsget inventory)')
  .option('-q, --quiet', 'suppress info messages')
  .action(async (id: string, options: StreamOptions) => {
    try {
      await streamCommand(id, options);
    } catch (error: any) {
      Logger.error(`stream failed: ${error?.message || error}`);
      process.exit(6);
    }
  });

// pipe - auto-pipe htsget stream into bcftools/samtools/seqkit
// (distinct from the existing `view` command, which prints file content)
program
  .command('pipe <id>')
  .description('Pipe a BioIP stream into bcftools view (VCF), samtools view (BAM), or seqkit stats (FASTQ)')
  .option('--tool <bcftools|samtools|seqkit>', 'force tool (default: auto-detect from filename)')
  .option('--htsget-url <url>', 'override htsget endpoint')
  .option('--region <chr:start-end>', 'genomic region forwarded to htsget')
  .option('--annotated', 'prefer OpenCRAVAT-annotated VCF sibling')
  .option('-q, --quiet', 'suppress info messages')
  .allowUnknownOption(true)
  .action(async (id: string, options: PipeOptions, cmd: any) => {
    try {
      // Everything after `--` is passed through to the tool
      const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
      await pipeCommand(id, { ...options, extra });
    } catch (error: any) {
      Logger.error(`pipe failed: ${error?.message || error}`);
      process.exit(6);
    }
  });

// ========================================================================
// v3.18.0 — TeleBioinformatics (`biofs tele`)
// Consent-gated htsget → local tools (Tier A) + IGV/Jupyter (Tier B).
// Heavy calling/annotation remains Tier C (annotate / job / skills).
// ========================================================================
const teleCmd = program
  .command('tele')
  .description('TeleBioinformatics: consent-gated streams into local tools (stats, IGV, jupyter, …)');

function teleCommon(cmd: any) {
  return cmd
    .option('--kind <variants|reads>', 'force htsget datatype')
    .option('--htsget-url <url>', 'override htsget endpoint')
    .option('--region <chr:start-end>', 'genomic region')
    .option('--annotated', 'OpenCRAVAT-annotated VCF sibling when available')
    .option('-q, --quiet', 'suppress progress on stderr')
    .option('--json', 'JSON output where supported');
}

teleCommon(
  teleCmd
    .command('tools')
    .description('Catalog of TeleBioinformatics tools and tiers (A stream / B fuse / C server)'),
).action(async (options: TeleCommonCli) => {
  try {
    await teleToolsCommand(options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('stats <id>')
    .description('bcftools stats | samtools stats | seqkit stats (auto by filetype)'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleStatsCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('header <id>')
    .description('VCF/BAM header only (bcftools view -h | samtools view -H)'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleHeaderCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('flagstat <id>')
    .description('samtools flagstat on a streamed BAM/CRAM'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleFlagstatCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('count <id>')
    .description('Count variants (bcftools) or reads (samtools view -c)'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleCountCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('region <id> <region>')
    .description('Stream a genomic region (chr:start-end) via htsget + tool filter'),
).action(async (id: string, region: string, options: TeleCommonCli) => {
  try {
    await teleRegionCommand(id, region, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('query <id>')
    .description('bcftools query (pass -f after --)')
    .option('--format <fmt>', 'bcftools -f format string')
    .allowUnknownOption(true),
).action(async (id: string, options: TeleCommonCli, cmd: any) => {
  try {
    const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
    await teleQueryCommand(id, extra, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('filter <id>')
    .description('bcftools view with -i/-e filters')
    .option('--include <expr>', 'bcftools -i expression')
    .option('--exclude <expr>', 'bcftools -e expression')
    .allowUnknownOption(true),
).action(async (id: string, options: TeleCommonCli, cmd: any) => {
  try {
    const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
    await teleFilterCommand(id, extra, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('view <id>')
    .description('Generic bcftools/samtools view (args after --)')
    .allowUnknownOption(true),
).action(async (id: string, options: TeleCommonCli, cmd: any) => {
  try {
    const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
    await teleViewCommand(id, extra, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('seqkit <id>')
    .description('seqkit stats on streamed FASTQ/FASTA'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleSeqkitCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('seqtk <id>')
    .description('seqtk on streamed FASTQ (args after --)')
    .allowUnknownOption(true),
).action(async (id: string, options: TeleCommonCli, cmd: any) => {
  try {
    const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
    await teleSeqtkCommand(id, extra, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('bedtools <id>')
    .description('bedtools on stream (e.g. -- intersect -b genes.bed)')
    .allowUnknownOption(true),
).action(async (id: string, options: TeleCommonCli, cmd: any) => {
  try {
    const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
    await teleBedtoolsCommand(id, extra, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('vt <id>')
    .description('vt on VCF stream (e.g. -- normalize -r ref.fa)')
    .allowUnknownOption(true),
).action(async (id: string, options: TeleCommonCli, cmd: any) => {
  try {
    const extra = cmd.args.slice(cmd.args.indexOf(id) + 1);
    await teleVtCommand(id, extra, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('mosdepth <id>')
    .description('mosdepth coverage (materializes temp BAM; prefer fuse for large WGS)')
    .option('--out <prefix>', 'output prefix'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleMosdepthCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('igv <id>')
    .description('Write IGV desktop batch + IGV.js HTML session for the stream URL')
    .option('--web', 'also open IGV.js HTML')
    .option('--open', 'open the HTML session in the default browser')
    .option('--out <path>', 'output HTML path'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleIgvCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('jupyter <id>')
    .description('Emit a Jupyter/Python cell that streams via biofs into pysam or line parser')
    .option('--out <file>', 'write cell to file'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleJupyterCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('pysam <id>')
    .description('Alias of tele jupyter (pysam-oriented snippet)')
    .option('--out <file>', 'write snippet to file'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await telePysamCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('stream <id>')
    .description('Same as biofs stream (raw htsget bytes to stdout)'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleStreamCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
    process.exit(6);
  }
});

teleCommon(
  teleCmd
    .command('ticket <id>')
    .description('Show htsget ticket JSON for an id (TeleBioinformatics debug)'),
).action(async (id: string, options: TeleCommonCli) => {
  try {
    await teleTicketCommand(id, options);
  } catch (e: any) {
    Logger.error(e?.message || e);
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
  .option('--region <chr:start-end>', 'genomic region (htsget referenceName/start/end)')
  .option('--referenceName <chr>', 'htsget referenceName')
  .option('--start <n>', 'htsget start')
  .option('--end <n>', 'htsget end')
  .option('--annotated', 'request annotated VCF sibling')
  .option('--htsget-url <url>', 'override htsget endpoint')
  .action(async (kind: string, id: string, options: any) => {
    try {
      if (kind !== 'variants' && kind !== 'reads') {
        Logger.error(`kind must be 'variants' or 'reads' (got '${kind}')`);
        process.exit(2);
      }
      await htsgetTicketCommand(kind as 'variants' | 'reads', id, options);
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
const inventoryCmd = program
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

// inventory cohort sub-command: extract filtered cohort of biosample serials
inventoryCmd
  .command('cohort')
  .description('Extract a filtered cohort of biosample serials from bioroutes.inventory (the canonical "what should I process next?" query)')
  .requiredOption('--originlab <name>', 'Lab name (e.g. augenomics, neochromosome, somos, tecbase, genobank)')
  .option('--has <csv>', 'CSV of filetypes the serial MUST have (e.g. fastq)')
  .option('--missing <csv>', 'CSV of filetypes the serial MUST NOT have (e.g. vcf,gvcf)')
  .option('--paired', 'For FASTQ, require both R1 and R2 to exist')
  .option('--limit <N>', 'Cap on returned serials')
  .option('--output <file>', 'Write serials one-per-line to file (suitable for `biofs cohort-pipeline --serials`)')
  .option('--json', 'Output full JSON response')
  .action(async (options: InventoryCohortOptions) => {
    try {
      await inventoryCohortCommand(options);
    } catch (error) {
      Logger.error(`inventory cohort failed: ${error}`);
      process.exit(1);
    }
  });

const samplesCmd = program
  .command('samples')
  .description('List biosample serials from BioRouter inventory');
samplesCmd
  .command('list')
  .description('List distinct biosample serials (optional --lab / --has)')
  .option('--lab <name>', 'Filter by origin lab')
  .option('--has <type>', 'Require this filetype (aliases: sqlite, bam, vcf)')
  .option('--json', 'JSON output')
  .option('--csv', 'CSV output')
  .option('--short', 'Serials only')
  .option('--limit <n>', 'Max rows')
  .option('--out-file <path>', 'Write to file')
  .action(async (options: SamplesListOptions) => {
    try {
      await samplesListCommand(options);
    } catch (error) {
      Logger.error(`samples list failed: ${error}`);
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
  .option('--bucket <name>', 'Scope to a single GCS bucket')
  .option('--prefix <path>', 'Scope to an object-name prefix (use with --bucket)')
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

// Claim command - Reassign mis-owned inventory rows (lab/legacy custodian) to the patient owner
program
  .command('claim')
  .description('Reassign inventory rows under your biorouter path from a lab/legacy custodian to you (admin)')
  .option('--owner <wallet>', 'Patient EIP-55 wallet to claim files TO (default: your wallet)')
  .option('--from <csv>', 'Custodian/legacy wallets to claim FROM (default: known legacy+custodian)')
  .option('--exclude <csv>', 'object_name substrings to skip (e.g. /dtc-genotype/,41221040804049)')
  .option('--apply', 'Actually reassign ownership (default is dry-run)')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Show debug information')
  .action(async (options: ClaimOptions) => {
    try {
      await claimCommand(options);
    } catch (error) {
      Logger.error(`Claim failed: ${error}`);
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

// Imaging commands — pull UCSF eUnity DICOM studies into the patient vault via
// the biofs protocol (DICOM is biodata → biofs job dispatched through biofs-node).
const imagingCmd = program
  .command('imaging')
  .description('DICOM medical-imaging acquisition: pull hospital studies (UCSF eUnity) into the patient vault via biofs-node');

imagingCmd
  .command('pull', { isDefault: true })
  .description('Pull a UCSF eUnity DICOM study into the vault (resolve --eunity-url + --cookie + --study-uid with the web3-chrome MCP)')
  .requiredOption('--eunity-url <url>', 'eUnity downloadDicomStudy URL (resolved browser-side by the MCP)')
  .requiredOption('--cookie <header>', 'eUnity /e JSESSIONID Cookie header (resolved browser-side by the MCP)')
  .option('--study-uid <uid>', 'DICOM StudyInstanceUID (enables vault dedupe)')
  .option('--source <src>', 'Provenance label', 'eunity-mychart')
  .option('--force', 'Re-pull even if the study is already in the vault (idempotent overwrite)')
  .option('--wait', 'Wait for the server-side ingest to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingPullOptions) => {
    try {
      await imagingPullCommand(options);
    } catch (error) {
      Logger.error(`imaging pull failed: ${error}`);
      process.exit(1);
    }
  });

// imaging twin — the "3D Organ TimeMachine": longitudinal CT change map (register
// two timepoints, segment organs, per-organ/voxel deltas + Jacobian + meshes) as a
// biofs GPU job. Inputs are biocid-addressed (biofs-node resolves via biorouter).
imagingCmd
  .command('twin')
  .description('3D Organ TimeMachine: longitudinal CT change map across N timepoints of an anatomy (GPU job via biofs-node)')
  .option('--baseline <ref>', 'baseline biocid (biocid://…/dicom/<studyUID>) or studyUID (2-timepoint mode)')
  .option('--followup <ref>', 'follow-up biocid or studyUID (2-timepoint mode)')
  .option('--timepoints <spec>', 'N-timepoint mode: JSON [{label,study,series}] (ordered, first=reference) or "label:study:series,..." — supersedes --baseline/--followup')
  .option('--anatomy <name>', 'anatomy to register (abdomen | chest)', 'abdomen')
  .option('--registration <mode>', 'deformable (SyNRA + Jacobian, default) or rigid (strict 6-DOF, spot-faithful organ meshes)', 'deformable')
  .option('--baseline-series <uid>', 'override the baseline primary CT series UID')
  .option('--followup-series <uid>', 'override the follow-up primary CT series UID')
  .option('--wait', 'Wait for the GPU pipeline to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingTwinOptions) => {
    try {
      await imagingTwinCommand(options);
    } catch (error) {
      Logger.error(`imaging twin failed: ${error}`);
      process.exit(1);
    }
  });

// imaging attribute — organ-attribution cross-join: segment a compare job's reference
// CT and label each focal change by the organ it sits in (feeds the radiology MCP).
imagingCmd
  .command('attribute')
  .description('Label each focal change in a compare job with its anatomic organ (GPU segmentation via biofs-node)')
  .requiredOption('--compare <compare_job_id>', 'the compare_job_id from `biofs imaging compare`')
  .option('--wait', 'Wait for the GPU job to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingAttributeOptions) => {
    try {
      await imagingAttributeCommand(options);
    } catch (error) {
      Logger.error(`imaging attribute failed: ${error}`);
      process.exit(1);
    }
  });

// imaging trajectory — 3-timepoint per-voxel persistence classifier (persistent
// progression/regression vs transient motion). CPU via biofs-node; drop-in compare artifact.
imagingCmd
  .command('trajectory')
  .description('3-timepoint per-voxel trajectory classifier: persistent change vs transient motion (CPU via biofs-node)')
  .requiredOption('--timepoints <spec>', 'oldest→newest: JSON [{label,study,series}] or "label:study[:series],..." (>=3; series auto-resolved if omitted)')
  .option('--anatomy <name>', 'anatomy (chest | abdomen)', 'chest')
  .option('--thr-hu <hu>', 'override the per-interval significance threshold (default adaptive max(55, 3·det_sigma))')
  .option('--wait', 'Wait for the classifier to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingTrajectoryOptions) => {
    try {
      await imagingTrajectoryCommand(options);
    } catch (error) {
      Logger.error(`imaging trajectory failed: ${error}`);
      process.exit(1);
    }
  });

// imaging lesions — per-lesion volumetric tracking: independent VISTA-3D lesion seg per
// timepoint, cross-timepoint linking, RECIST 1.1 response (CR/PR/SD/PD, flagged candidate)
// + volume doubling time + iso-attenuating catch. GPU via biofs-node; drop-in artifact.
imagingCmd
  .command('lesions')
  .description('Per-lesion volumetric tracking: VISTA-3D per timepoint -> RECIST response + doubling time (GPU via biofs-node)')
  .requiredOption('--timepoints <spec>', 'oldest→newest: JSON [{label,study,series}] or "label:study[:series],..." (>=2; series auto-resolved if omitted)')
  .option('--anatomy <name>', 'anatomy (chest | abdomen)', 'chest')
  .option('--treatment <ctx>', 'treatment context (naive | post_chemo | post_radiation | post_immunotherapy | post_surgery | unknown); non-naive forces human review', 'unknown')
  .option('--wait', 'Wait for the GPU pipeline to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingLesionsOptions) => {
    try {
      await imagingLesionsCommand(options);
    } catch (error) {
      Logger.error(`imaging lesions failed: ${error}`);
      process.exit(1);
    }
  });

// imaging findings — longitudinal CT pathogenic-findings read (no volumes): pairwise
// baseline-forward rigid lock -> VISTA-3D auto-detect -> LesionLocator track -> RECIST
// 1.1 on long-axis diameters. GPU via biofs-node. Decision-support, not a diagnosis.
imagingCmd
  .command('findings')
  .description('Longitudinal pathogenic-findings read: rigid pairwise lock -> VISTA-3D detect -> LesionLocator track -> RECIST 1.1 (no volumes; GPU via biofs-node)')
  .requiredOption('--timepoints <spec>', 'oldest→newest: JSON [{label,study,series}] or "label:study[:series],..." (>=2; series auto-resolved if omitted)')
  .option('--treatment <ctx>', 'treatment context (naive | post_chemo | post_radiation | post_immunotherapy | post_surgery | unknown); lowers RECIST confidence if not naive', 'unknown')
  .option('--wait', 'Wait for the GPU pipeline to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingFindingsOptions) => {
    try {
      await imagingFindingsCommand(options);
    } catch (error) {
      Logger.error(`imaging findings failed: ${error}`);
      process.exit(1);
    }
  });

// imaging characterize — Tier 2: study each tracked candidate from a findings job with
// the Tier-2 method stack (PyRadiomics, CT-FM, Merlin, PASTA, MedGemma 1.5) -> per-candidate
// side-by-side + agreement. GPU via biofs-node. Decision-support, not a diagnosis.
imagingCmd
  .command('characterize')
  .description('Tier 2: study a findings job\'s candidates with the method stack -> per-candidate comparison (GPU via biofs-node)')
  .requiredOption('--job <findings_job_id>', 'the findings_job_id from `biofs imaging findings`')
  .option('--methods <csv>', 'methods to run (pyradiomics,ctfm,merlin,pasta,medgemma)', 'pyradiomics,ctfm,merlin,pasta,medgemma')
  .option('--alpha <n>', 'conformal risk level (when the trained second-reader is available)', '0.1')
  .option('--wait', 'Wait for the methods to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingCharacterizeOptions) => {
    try {
      await imagingCharacterizeCommand(options);
    } catch (error) {
      Logger.error(`imaging characterize failed: ${error}`);
      process.exit(1);
    }
  });

// imaging enrich — Phase 3 foundation-model enrichment of a finished twin:
// merlin (whole-scan change score) | vista3d (resection-bed seg) | medgemma
// (draft impression). Each runs its own GPU container and writes a sidecar.
imagingCmd
  .command('enrich')
  .description('Enrich a finished imaging-twin with a foundation model (merlin | vista3d | medgemma) via biofs-node GPU')
  .requiredOption('--job <twin_job_id>', 'the twin_job_id from `biofs imaging twin`')
  .requiredOption('--model <name>', 'merlin (change score) | vista3d (resection-bed seg) | medgemma (draft impression)')
  .option('--hf-token <token>', 'HuggingFace token for MedGemma (gated); transient, executor-only')
  .option('--wait', 'Wait for the GPU job to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingEnrichOptions) => {
    try {
      await imagingEnrichCommand(options);
    } catch (error) {
      Logger.error(`imaging enrich failed: ${error}`);
      process.exit(1);
    }
  });

// imaging compare — the "Image Time Machine": rigid slice-by-slice comparator of two
// CT timepoints (A=follow-up, B=baseline aligned into A, signed diff) for the 2D
// blink/crossfade/diff viewer. CPU job via biofs-node. --region (+ --zlo/--zhi)
// focuses the rigid alignment on one z-band (e.g. the pelvis), still spot-safe.
imagingCmd
  .command('compare')
  .description('Image Time Machine: rigid slice-by-slice comparator of two CT timepoints (CPU job via biofs-node)')
  .requiredOption('--baseline <studyUID>', 'baseline (earlier) study UID')
  .requiredOption('--baseline-series <uid>', 'baseline primary CT series UID')
  .requiredOption('--followup <studyUID>', 'follow-up (later) study UID = the reference grid')
  .requiredOption('--followup-series <uid>', 'follow-up primary CT series UID')
  .option('--baseline-label <label>', 'short label for the baseline (e.g. jan9)')
  .option('--followup-label <label>', 'short label for the follow-up (e.g. mar3)')
  .option('--anatomy <name>', 'anatomy (abdomen | chest)', 'abdomen')
  .option('--region <label>', 'focus the rigid alignment on a z-band (needs --zlo/--zhi), e.g. pelvis')
  .option('--zlo <frac>', 'region z-fraction lower bound [0..1]')
  .option('--zhi <frac>', 'region z-fraction upper bound [0..1]')
  .option('--wait', 'Wait for the comparator to finish')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Output as JSON')
  .action(async (options: ImagingCompareOptions) => {
    try {
      await imagingCompareCommand(options);
    } catch (error) {
      Logger.error(`imaging compare failed: ${error}`);
      process.exit(1);
    }
  });

// Workspace commands — the shared intra-LLM case workspace (append-only,
// hash-chained log that Claude Code + Grok Build co-edit via biofs-node).
const workspaceCmd = program
  .command('workspace')
  .alias('ws')
  .description('Shared intra-LLM case workspace: append-only, hash-chained, reproducible record');

workspaceCmd
  .command('open <case_id>')
  .description('Open or create a case workspace; print header + turns')
  .option('--title <title>', 'Case title (on create)')
  .option('--biocid <biocid...>', 'Biocid(s) under discussion (on create)')
  .option('--node <url>', 'biofs-node base override (BIOFS_NODE_URL)')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceOpenCommand(caseId, options); });

workspaceCmd
  .command('read <case_id>')
  .description('Read turns with seq > since_seq (how each agent sees new turns)')
  .option('--since-seq <n>', 'Only turns after this seq', '0')
  .option('--limit <n>', 'Max turns', '500')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceReadCommand(caseId, options); });

workspaceCmd
  .command('append <case_id>')
  .description('Append one turn (append-only). Default agent_id "operator"; use --as')
  .option('--as <agent_id>', 'Author id (e.g. operator, claude-code, grok-build)', 'operator')
  .option('--role <role>', 'Turn role', 'message')
  .option('--content <text>', 'Turn content')
  .option('--ref <biocid:hash:kind...>', 'Data refs, each biocid:content_hash:kind')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceAppendCommand(caseId, options); });

workspaceCmd
  .command('case <case_id>')
  .description('Update the shared case header with optimistic CAS (needs --expected-version)')
  .option('--title <title>', 'New title')
  .option('--status <status>', 'New status')
  .option('--active-editor <agent_id>', 'Advisory active editor')
  .option('--biocid <biocid...>', 'Replace biocids')
  .option('--expected-version <n>', 'Expected current _version', '0')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceCaseCommand(caseId, options); });

workspaceCmd
  .command('lease <resource>')
  .description('Advisory turn-taking lease (claim by default; --release to release)')
  .option('--holder <agent_id>', 'Lease holder', 'operator')
  .option('--ttl <seconds>', 'Lease TTL seconds', '60')
  .option('--release', 'Release instead of claim')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (resource: string, options: WorkspaceOptions) => { await workspaceLeaseCommand(resource, options); });

workspaceCmd
  .command('replay <case_id>')
  .description('Print the ordered log and verify the hash chain (the audit record)')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceReplayCommand(caseId, options); });

workspaceCmd
  .command('anchor <case_id>')
  .description('Record a turn-log segment digest for on-chain anchoring (stage B)')
  .option('--up-to-seq <n>', 'Anchor up to this seq (default: all)')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceAnchorCommand(caseId, options); });

workspaceCmd
  .command('classify <case_id>')
  .description('Record a structured ACMG-style classification claim (for consensus)')
  .requiredOption('--subject <s>', 'What is classified (HGVS, gene:variant, or biocid)')
  .requiredOption('--classification <c>', 'Verdict (Pathogenic|Likely pathogenic|VUS|Likely benign|Benign)')
  .option('--criteria <list>', 'ACMG criteria, comma-separated (e.g. PVS1,PM2)')
  .option('--strength <s>', 'Combined-strength note')
  .option('--confidence <n>', 'Confidence 0-1')
  .option('--rationale <text>', 'Justification (turn content)')
  .option('--as <agent_id>', 'Author id', 'operator')
  .option('--ref <biocid:hash:kind...>', 'Data refs')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceClassifyCommand(caseId, options); });

workspaceCmd
  .command('consensus <case_id>')
  .description('Compute cross-agent consensus from classification claims (agreement, disagreements)')
  .option('--node <url>', 'biofs-node base override')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceConsensusCommand(caseId, options); });

workspaceCmd
  .command('export <case_id>')
  .description('Export the chain-verified turn log as portable JSON (for the verifier / archival)')
  .option('--out <file>', 'Write to file (default: stdout)')
  .option('--node <url>', 'biofs-node base override')
  .option('--quiet', 'Suppress status line')
  .action(async (caseId: string, options: WorkspaceOptions) => { await workspaceExportCommand(caseId, options); });

workspaceCmd
  .command('verify <file>')
  .description('Independently verify an exported turn log offline (zero-trust reproducibility check)')
  .option('--offline', 'Verify the hash chain locally without contacting any server (default behavior)')
  .option('--json', 'Output as JSON')
  .action(async (file: string, options: WorkspaceOptions) => { await workspaceVerifyCommand(file, options); });

// Duet — conductor that drives Claude Code + Grok Build headless on subscriptions.
program
  .command('duet <case_id>')
  .description('Orchestrate Claude Code + Grok Build (subscription CLIs, headless) on one case')
  .option('--task <text>', 'The shared goal/question for the two models')
  .option('--biocid <biocid>', 'The biocid (annotated VCF / data) under discussion')
  .option('--rounds <n>', 'Number of rounds', '3')
  .option('--mode <mode>', 'alternate | parallel | consensus', 'alternate')
  .option('--models <csv>', 'Models in order (claude,grok,gemini)', 'claude,grok')
  .option('--node <url>', 'biofs-node base override (BIOFS_NODE_URL)')
  .option('--biorouter <url>', 'biorouter base for the biofs MCP')
  .option('--mcp-dist <path>', 'Path to mcp-bio-context dist/index.js')
  .option('--claude-bin <bin>', 'Claude Code binary', 'claude')
  .option('--grok-bin <bin>', 'Grok Build binary', 'grok')
  .option('--gemini-bin <bin>', 'Gemini CLI binary', 'gemini')
  .option('--gemini-model <model>', 'Gemini model id', 'gemini-3-flash-preview')
  .option('--mock', 'Do not spawn the CLIs; simulate each turn (test the loop)')
  .option('--referee <model>', 'After rounds, this model adjudicates disagreements into a final call')
  .option('--timeout <seconds>', 'Per-CLI-invocation timeout (grok startup is slow)', '300')
  .option('--dry-run', 'Preflight checks only, then exit')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: DuetOptions) => { await duetCommand(caseId, options); });

// Benchmark — the ACMG evaluation harness (single vs same-model vs cross-vendor).
program
  .command('benchmark <dataset>')
  .description('Run the ACMG benchmark: single-model vs same-model debate vs cross-vendor debate, scored vs truth')
  .option('--arms <csv>', 'Arms to run', 'single,same-model,cross-vendor')
  .option('--models <csv>', 'Model panel', 'claude,grok,gemini')
  .option('--rounds <n>', 'Debate rounds for debate arms', '2')
  .option('--same-model <model>', 'Model used for the same-model-debate arm')
  .option('--mock', 'Deterministic mock (validate the harness without spawning CLIs)')
  .option('--mock-error <pct>', 'Per-model error rate in mock mode', '22')
  .option('--limit <n>', 'Only the first N variants')
  .option('--out <dir>', 'Results output directory')
  .option('--node <url>', 'biofs-node base override (BIOFS_NODE_URL)')
  .option('--biorouter <url>', 'biorouter base for the biofs MCP')
  .option('--mcp-dist <path>', 'Path to mcp-bio-context dist/index.js')
  .option('--gemini-model <model>', 'Gemini model id', 'gemini-3-flash-preview')
  .option('--timeout <seconds>', 'Per-CLI-invocation timeout', '300')
  .option('--json', 'Output summary as JSON')
  .action(async (dataset: string, options: BenchmarkOptions) => { await benchmarkCommand(dataset, options); });

// benchmark-prepare — build the publication dataset from a ClinVar export.
program
  .command('benchmark-prepare <clinvar_variant_summary>')
  .description('Build a stratified benchmark dataset from a ClinVar variant_summary.txt[.gz] export')
  .option('--out <file>', 'Output JSONL path', 'bench/clinvar.jsonl')
  .option('--min-stars <n>', 'Minimum ClinVar review stars (2 = multiple submitters, no conflicts)', '2')
  .option('--per-tier <n>', 'Max variants sampled per ACMG tier', '100')
  .option('--max <n>', 'Hard cap on total variants')
  .option('--tiers <csv>', 'Restrict to tiers (e.g. P,LP,VUS,LB,B)')
  .option('--genes <csv>', 'Restrict to genes')
  .option('--assembly <asm>', 'Genome assembly to keep', 'GRCh38')
  .option('--json', 'Output summary as JSON')
  .action(async (file: string, options: PrepareOptions) => { await benchmarkPrepareCommand(file, options); });

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

// agent register-sequentia - Register ERC-8004 agents on Sequentia BioAgentRegistry
agentCmd
  .command('register-sequentia')
  .description('Register Cancer Digital Twin agents on the Sequentia BioAgentRegistry (ERC-8004)')
  .option('--all', 'Register all three canonical agents (clara, opencravat, genoclaw)')
  .option('--agent <name>', 'Register a single canonical agent: clara | opencravat | genoclaw')
  .option('--name <name>', 'Ad-hoc agent name (requires --uri)')
  .option('--uri <url>', 'Ad-hoc agent registration file (agentURI)')
  .option('--formats <list>', 'Ad-hoc supported formats (comma-separated)', 'vcf')
  .option('--private-key <key>', 'Ad-hoc agent private key (defaults to derived)')
  .option('--no-x402', 'Register with x402 disabled')
  .option('--dry-run', 'Plan the registration without broadcasting (no key/gas needed)')
  .option('--json', 'Emit JSON')
  .action(async (options: AgentRegisterSequentiaOptions) => {
    try {
      await agentRegisterSequentiaCommand(options);
    } catch (error) {
      Logger.error(`Sequentia agent registration failed: ${error}`);
      process.exit(1);
    }
  });

// agent list-sequentia - Query on-chain ERC-8004 agent status
agentCmd
  .command('list-sequentia')
  .description('Query on-chain ERC-8004 status of the Cancer Twin agents (or any wallet/agentId)')
  .option('--wallet <address>', 'Look up an arbitrary agent wallet')
  .option('--agent-id <id>', 'Look up an arbitrary agentId')
  .option('--json', 'Emit JSON')
  .action(async (options: AgentListSequentiaOptions) => {
    try {
      await agentListSequentiaCommand(options);
    } catch (error) {
      Logger.error(`Sequentia agent list failed: ${error}`);
      process.exit(1);
    }
  });

// Interpret command group - Agent 3: GenoClaw clinical interpreter (SQLite + context → report)
const interpretCmd = program
  .command('interpret')
  .description('GenoClaw clinical interpreter — Cancer Digital Twin report from annotated context');

interpretCmd
  .command('submit <biosample_serial>')
  .description('Submit annotated context to the GenoClaw interpreter agent (produces a Cancer Digital Twin report)')
  .option('--package <pkg>', 'Interpretation package: cancer_twin | rare_disease | pharmgx', 'cancer_twin')
  .option('--sqlite-biocid <biocid>', 'Explicit annotated-sqlite BioCID override')
  .option('--context-biocids <list>', 'Extra context BioCIDs (comma-separated)')
  .option('--wait', 'Wait for the interpretation to complete')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Emit JSON')
  .action(async (biosampleSerial: string, options: InterpretSubmitOptions) => {
    try {
      await interpretSubmitCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`Interpretation submission failed: ${error}`);
      process.exit(1);
    }
  });

interpretCmd
  .command('status <interpret_job_id>')
  .description('Check GenoClaw interpretation job status')
  .option('--watch', 'Watch mode (poll until done)')
  .option('--wait', 'Block until the job completes')
  .option('--max-wait-min <minutes>', 'Max minutes to wait', '30')
  .option('--json', 'Emit JSON')
  .action(async (jobId: string, options: InterpretStatusOptions) => {
    try {
      await interpretStatusCommand(jobId, options);
    } catch (error) {
      Logger.error(`Interpretation status check failed: ${error}`);
      process.exit(1);
    }
  });

const cassetteCmd = program
  .command('cassette')
  .description('Audit a Cancer Digital Twin and simulate the one-neoantigen RNA cassette (CD8)');

cassetteCmd
  .command('audit [biosample_serial]')
  .description('List missing or contradictory twin layers needed for a CD8 cassette')
  .option('--wallet <addr>', 'Owner wallet')
  .option('--remote', 'Dispatch to biofs-node /agent/cassette')
  .option('--json', 'Emit JSON')
  .action(async (serial: string | undefined, options: CassetteOptions) => {
    try {
      if (!serial) throw new Error('Pass a biosample serial');
      await cassetteCommand('audit', serial, options);
    } catch (error) {
      Logger.error(`cassette audit failed: ${error}`);
      process.exit(1);
    }
  });

cassetteCmd
  .command('simulate [biosample_serial]')
  .description('Select 4-8 RNAs and estimate de novo blood CD8 probability')
  .option('--wallet <addr>', 'Owner wallet')
  .option('--remote', 'Dispatch to biofs-node /agent/cassette')
  .option('--json', 'Emit JSON')
  .option('--html <path>', 'Write the simulation HTML report')
  .option('--min <n>', 'Minimum RNAs', '4')
  .option('--max <n>', 'Maximum RNAs', '8')
  .action(async (serial: string | undefined, options: CassetteOptions) => {
    try {
      if (!serial) throw new Error('Pass a biosample serial');
      await cassetteCommand('simulate', serial, options);
    } catch (error) {
      Logger.error(`cassette simulate failed: ${error}`);
      process.exit(1);
    }
  });

const hlaTypeCmd = program
  .command('hla-type')
  .description('RNA HLA typing (arcasHLA) dispatched through biofs-node; BAM stays on the server');

hlaTypeCmd
  .command('submit <biosample_serial>')
  .description('Submit arcasHLA on the case RNA BAM biocid')
  .option('--rna-biocid <biocid>', 'Override RNA BAM biocid')
  .option('--json', 'Emit JSON')
  .action(async (serial: string, options: HlaTypeOptions) => {
    try {
      await hlaTypeSubmitCommand(serial, options);
    } catch (error) {
      Logger.error(`hla-type submit failed: ${error}`);
      process.exit(1);
    }
  });

const cancermapCmd = program
  .command('cancermap')
  .description('Grounded cancer-map regeneration (biofs-node /agent/cancermap)');

cancermapCmd
  .command('regen [wallet]')
  .description('Regenerate twin.json + grounded map for a wallet (does not pull genomic bytes)')
  .option('--serial <serial>', 'Biosample serial')
  .option('--case-id <id>', 'Case id')
  .option('--json', 'Emit JSON')
  .action(async (wallet: string | undefined, options: CancermapRegenOptions) => {
    try {
      await cancermapRegenCommand(wallet, options);
    } catch (error) {
      Logger.error(`cancermap regen failed: ${error}`);
      process.exit(1);
    }
  });

// Ancestry command group - SOMOS 24-population admixture (privacy-preserving)
const ancestryCmd = program
  .command('ancestry')
  .description('SOMOS 24-population ancestry — supervised-ADMIXTURE projection, optionally encrypted (genome never decrypted)');

ancestryCmd
  .command('ingest <file>')
  .description('Ingest a DTC genotype into the SOMOS vault and register it, yielding a biosample serial')
  .option('--biowallet <address>', 'Data owner (custodial biowallet). Defaults to your own wallet.')
  .option('--wait', 'Wait for registration to complete and print the serial')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Emit JSON')
  .action(async (file: string, options: AncestryIngestOptions) => {
    try {
      await ancestryIngestCommand(file, options);
    } catch (error) {
      Logger.error(`Ancestry ingest failed: ${error}`);
      process.exit(1);
    }
  });

ancestryCmd
  .command('somos <biosample_serial>')
  .description('Compute SOMOS admixture for a genotype in the vault (default: exact projection; --encrypted: blind CKKS)')
  .option('--encrypted', 'Tier-1 BlindDot: CKKS-encrypt the genome; server projects blind (raw genome never decrypted)')
  .option('--fully-blind', 'Tier-2 (optional): also hide the 24-pop result from the server (bootstrapping backend)')
  .option('--biowallet <address>', 'Data owner: file the result under this wallet, not the operator\'s')
  .option('--wait', 'Wait for the computation to complete')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Emit JSON')
  .action(async (biosampleSerial: string, options: AncestrySomosOptions) => {
    try {
      await ancestrySomosCommand(biosampleSerial, options);
    } catch (error) {
      Logger.error(`Ancestry submission failed: ${error}`);
      process.exit(1);
    }
  });

ancestryCmd
  .command('share <biosample_serial>')
  .description('Mint a BioCID-gated, revocable, expiring report link (no storage URL is ever created)')
  .option('--days <n>', 'Days until the link expires (max 30)', '7')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'Emit JSON')
  .action(async (serial: string, options: AncestryShareOptions) => {
    try {
      await ancestryShareCommand(serial, options);
    } catch (error) {
      Logger.error(`Ancestry share failed: ${error}`);
      process.exit(1);
    }
  });

ancestryCmd
  .command('shares')
  .description('List BioCID-gated report shares you created or own')
  .option('--serial <biosample_serial>', 'Filter by biosample serial')
  .option('--json', 'Emit JSON')
  .action(async (options: AncestrySharesOptions) => {
    try {
      await ancestrySharesCommand(options);
    } catch (error) {
      Logger.error(`Ancestry shares failed: ${error}`);
      process.exit(1);
    }
  });

ancestryCmd
  .command('revoke <share_id>')
  .description('Revoke a report share immediately (the link dies on the next view)')
  .option('--json', 'Emit JSON')
  .action(async (shareId: string, options: AncestryRevokeOptions) => {
    try {
      await ancestryRevokeCommand(shareId, options);
    } catch (error) {
      Logger.error(`Ancestry revoke failed: ${error}`);
      process.exit(1);
    }
  });

ancestryCmd
  .command('status <ancestry_job_id>')
  .description('Check a SOMOS ancestry job status / fetch the 24-population result')
  .option('--watch', 'Watch mode (poll until done)')
  .option('--wait', 'Block until the job completes')
  .option('--max-wait-min <minutes>', 'Max minutes to wait', '40')
  .option('--json', 'Emit JSON')
  .action(async (jobId: string, options: AncestryStatusOptions) => {
    try {
      await ancestryStatusCommand(jobId, options);
    } catch (error) {
      Logger.error(`Ancestry status check failed: ${error}`);
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
// Methyl command group — Oxford Nanopore 5mCG/5hmCG methylation pipeline
const methylCmd = program
  .command('methyl')
  .description('Oxford Nanopore 5mCG/5hmCG methylation: submit (client) + exec (VM runner)');

// methyl submit (DEFAULT) — `biofs methyl <serial>` and `biofs methyl submit <serial>`
methylCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit an ONT methylation job to biofs-node (modkit 5mCG/5hmCG bedMethyl)')
  .requiredOption('--bams <csv>', 'CSV of gs:// ONT Dorado BAM URIs (carry MM/ML tags)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--parent-ip-id <id>', 'Parent BioIP / IP asset id')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: MethylSubmitOptions) => {
    try {
      await methylSubmitCommand(serial, options);
    } catch (error) {
      Logger.error(`Methyl submit failed: ${error}`);
      process.exit(1);
    }
  });

// methyl exec — the VM-side executor (biofs-node spawns: biofs methyl exec --flags)
methylCmd
  .command('exec')
  .description('VM-side executor: minimap2 align + samtools merge + modkit pileup, stream bedMethyl to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bams <csv>', 'CSV of gs:// ONT BAM URIs')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id (for OUT/LOG GCS pathing)')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for LOG_GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: MethylExecOptions) => {
    try {
      await methylExecCommand(options);
    } catch (error) {
      Logger.error(`Methyl exec failed: ${error}`);
      process.exit(1);
    }
  });

// Align-shard command group — sharded ONT long-read alignment (dorado, MM/ML-native)
const alignShardCmd = program
  .command('align-shard')
  .description('Sharded ONT long-read alignment (dorado aligner, MM/ML preserved): submit (client) + exec (VM runner)');

// align-shard submit (DEFAULT) — `biofs align-shard <serial>` and `biofs align-shard submit <serial>`
alignShardCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a sharded ONT alignment job to biofs-node (dorado aligner, persists merged aligned modBAM)')
  .requiredOption('--bams <csv>', 'CSV of gs:// ONT Dorado modBAM URIs (carry MM/ML tags)')
  .option('--shards <n>', 'Concurrent aligner workers (default: auto from nproc)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--modkit', 'Also produce the 5mCG/5hmCG bedMethyl pileup (with QC gates)')
  .option('--parent-ip-id <id>', 'Parent BioIP / IP asset id')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: AlignShardSubmitOptions) => {
    try {
      await alignShardSubmitCommand(serial, options);
    } catch (error) {
      Logger.error(`Align-shard submit failed: ${error}`);
      process.exit(1);
    }
  });

// align-shard exec — the VM-side executor (biofs-node spawns: biofs align-shard exec --flags)
alignShardCmd
  .command('exec')
  .description('VM-side executor: W concurrent dorado aligner workers + merge, persist aligned modBAM to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bams <csv>', 'CSV of gs:// ONT modBAM URIs')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--workers <n>', 'Concurrent aligner workers (default: auto from nproc)')
  .option('--modkit', 'Also run modkit pileup (5mCG/5hmCG bedMethyl) with QC gates')
  .option('--job-id <id>', 'Job id (for OUT/LOG GCS pathing)')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for LOG_GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: AlignShardExecOptions) => {
    try {
      await alignShardExecCommand(options);
    } catch (error) {
      Logger.error(`Align-shard exec failed: ${error}`);
      process.exit(1);
    }
  });

// Comethyl command group — single-molecule co-methylation analysis (gated, pre-registered)
const comethylCmd = program
  .command('comethyl')
  .description('Single-molecule co-methylation analysis (imprinting floor, lambda, nulls): submit (client) + exec (VM runner)');

comethylCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a comethyl analysis job to biofs-node (gate=floor: imprinting/ASM allele-split)')
  .requiredOption('--modbam <gs>', 'gs:// merged aligned ONT modBAM (MM/ML), the comethyl input')
  .requiredOption('--hifi-vcf <gs>', 'gs:// HiFi het-SNP VCF (phased on the VM if unphased)')
  .requiredOption('--hifi-bam <csv>', 'CSV of gs:// HiFi BAM URIs (for whatshap phase)')
  .option('--gate <g>', 'floor | lambda | null-a', 'floor')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: ComethylSubmitOptions) => {
    try { await comethylSubmitCommand(serial, options); }
    catch (error) { Logger.error(`Comethyl submit failed: ${error}`); process.exit(1); }
  });

comethylCmd
  .command('exec')
  .description('VM-side executor: phase ONT reads by HiFi het SNPs + per-haplotype modkit at imprinted DMRs')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--modbam <gs>', 'gs:// merged ONT modBAM')
  .requiredOption('--hifi-vcf <gs>', 'gs:// HiFi het-SNP VCF')
  .requiredOption('--hifi-bams <csv>', 'CSV of gs:// HiFi BAM URIs')
  .option('--gate <g>', 'floor', 'floor')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: ComethylExecOptions) => {
    try { await comethylExecCommand(options); }
    catch (error) { Logger.error(`Comethyl exec failed: ${error}`); process.exit(1); }
  });

// SV-call command group — ONT structural-variant calling (Sniffles2)
const svCallCmd = program
  .command('sv-call')
  .description('ONT structural-variant calling (Sniffles2): submit (client) + exec (VM runner)');

svCallCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit an ONT SV-calling job to biofs-node (Sniffles2 over the aligned modBAM)')
  .requiredOption('--modbam <gs>', 'gs:// merged aligned ONT modBAM (the SV-calling input)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: SvCallSubmitOptions) => {
    try { await svCallSubmitCommand(serial, options); }
    catch (error) { Logger.error(`sv-call submit failed: ${error}`); process.exit(1); }
  });

svCallCmd
  .command('exec')
  .description('VM-side executor: Sniffles2 over the gcsfuse-mounted modBAM, persist SV VCF to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--modbam <gs>', 'gs:// merged ONT modBAM')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: SvCallExecOptions) => {
    try { await svCallExecCommand(options); }
    catch (error) { Logger.error(`sv-call exec failed: ${error}`); process.exit(1); }
  });

// QC command group — long-read read-quality + coverage (verkko-readiness)
const qcCmd = program
  .command('qc')
  .description('Long-read QC (read quality + coverage, verkko-readiness): submit (client) + exec (VM runner)');

qcCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a long-read QC job to biofs-node (cramino + seqkit + HiFi rq-tag QV over gcsfuse-RO)')
  .requiredOption('--inputs <gs>', 'CSV of gs:// inputs (BAM/CRAM and/or FASTA/FASTQ.gz)')
  .option('--genome-size <bp>', 'Haploid genome size for coverage', '3100000000')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: QcSubmitOptions) => {
    try { await qcSubmitCommand(serial, options); }
    catch (error) { Logger.error(`qc submit failed: ${error}`); process.exit(1); }
  });

qcCmd
  .command('exec')
  .description('VM-side executor: cramino/seqkit/rq over gcsfuse-mounted inputs, persist QC manifest to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--inputs <gs>', 'CSV of gs:// inputs (BAM/CRAM and/or FASTA/FASTQ.gz)')
  .option('--genome-size <bp>', 'Haploid genome size for coverage', '3100000000')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .action(async (options: QcExecOptions) => {
    try { await qcExecCommand(options); }
    catch (error) { Logger.error(`qc exec failed: ${error}`); process.exit(1); }
  });

// Verkko command group — telomere-to-telomere assembly (verkko 2.3.2), biocid-gated
const verkkoCmd = program
  .command('verkko')
  .description('Verkko T2T assembly (HiFi + ONT-ultralong): submit (client, biocids) + exec (VM runner)');

verkkoCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a verkko T2T assembly job to biofs-node (inputs are biorouter biocids, NOT gs://)')
  .requiredOption('--hifi <biocids>', 'CSV of biocid:// HiFi reads (from biorouter)')
  .requiredOption('--nano <biocids>', 'CSV of biocid:// ONT reads (from biorouter)')
  .option('--hifi-prop <p>', 'Downsample HiFi to this proportion of reads', '1.0')
  .option('--ont-minlen <bp>', 'Keep ONT reads >= this length (ultralong)', '100000')
  .option('--local-memory <gb>', 'verkko --local-memory (GB)', '320')
  .option('--local-cpus <n>', 'verkko --local-cpus', '80')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: VerkkoSubmitOptions) => {
    try { await verkkoSubmitCommand(serial, options); }
    catch (error) { Logger.error(`verkko submit failed: ${error}`); process.exit(1); }
  });

verkkoCmd
  .command('exec')
  .description('VM-side executor: verkko 2.3.2 over front-resolved gated gs:// inputs, persist assembly to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--hifi <gs>', 'CSV of resolved gs:// HiFi reads (gated by biofs-node)')
  .requiredOption('--nano <gs>', 'CSV of resolved gs:// ONT reads (gated by biofs-node)')
  .option('--hifi-prop <p>', 'Downsample HiFi proportion', '1.0')
  .option('--ont-minlen <bp>', 'ONT min length', '100000')
  .option('--local-memory <gb>', 'verkko --local-memory (GB)', '320')
  .option('--local-cpus <n>', 'verkko --local-cpus', '80')
  .option('--ref <build>', 'ignored (appended by the generic biofs-node spawner)')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'ignored (appended by the generic biofs-node spawner)')
  .action(async (options: VerkkoExecOptions) => {
    try { await verkkoExecCommand(options); }
    catch (error) { Logger.error(`verkko exec failed: ${error}`); process.exit(1); }
  });

// ONT-variants command group — ONT small-variant calling (Clair3)
const ontVariantsCmd = program
  .command('ont-variants')
  .description('ONT small-variant calling (Clair3, R10.4.1 sup): submit (client) + exec (VM runner)');

ontVariantsCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit an ONT SNV/indel job to biofs-node (Clair3 over the aligned modBAM)')
  .requiredOption('--modbam <gs>', 'gs:// merged aligned ONT modBAM (the SNV/indel-calling input)')
  .option('--model <name>', 'Clair3 model name (default: auto-pick R10.4.1 sup from the image)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: OntVariantsSubmitOptions) => {
    try { await ontVariantsSubmitCommand(serial, options); }
    catch (error) { Logger.error(`ont-variants submit failed: ${error}`); process.exit(1); }
  });

ontVariantsCmd
  .command('exec')
  .description('VM-side executor: Clair3 (ONT) over the gcsfuse-mounted modBAM, persist SNV/indel VCF to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--modbam <gs>', 'gs:// merged ONT modBAM')
  .option('--model <name>', 'Clair3 model name (auto-picked if empty)')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: OntVariantsExecOptions) => {
    try { await ontVariantsExecCommand(options); }
    catch (error) { Logger.error(`ont-variants exec failed: ${error}`); process.exit(1); }
  });

// hifi-deepvariant command group — HiFi small-variant calling (Parabricks DeepVariant, GPU)
const hifiDvCmd = program
  .command('hifi-deepvariant')
  .description('HiFi small-variant calling (Parabricks DeepVariant --mode pacbio, GPU): submit (client) + exec (GPU runner)');

hifiDvCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a HiFi DeepVariant job to biofs-node (pbrun deepvariant over the aligned HiFi BAM)')
  .requiredOption('--bam <gs>', 'gs:// CHM13-aligned HiFi BAM (output of hifi-align --ref CHM13)')
  .option('--ref <build>', 'Reference: CHM13 | GRCh38 | auto', 'auto')
  .option('--gvcf', 'Also emit a gVCF (second pbrun pass)')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: HifiDeepvariantSubmitOptions) => {
    try { await hifiDeepvariantSubmitCommand(serial, options); }
    catch (error) { Logger.error(`hifi-deepvariant submit failed: ${error}`); process.exit(1); }
  });

hifiDvCmd
  .command('exec')
  .description('GPU-side executor: pbrun deepvariant (--mode pacbio) over the gcsfuse-mounted HiFi BAM, persist VCF to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bam <gs>', 'gs:// CHM13-aligned HiFi BAM')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--gvcf', 'Also emit a gVCF')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: HifiDeepvariantExecOptions) => {
    try { await hifiDeepvariantExecCommand(options); }
    catch (error) { Logger.error(`hifi-deepvariant exec failed: ${error}`); process.exit(1); }
  });

// somatic-mutect command group — tumor/normal somatic calling (Parabricks Mutect2, GPU)
const somaticMutectCmd = program
  .command('somatic-mutect')
  .description('Tumor/normal somatic small-variant calling (Parabricks mutectcaller = GPU Mutect2): submit (client) + exec (GPU runner)');

somaticMutectCmd
  .command('submit <caseId>', { isDefault: true })
  .description('Submit a tumor/normal Mutect2 job to biofs-node (panel-design source for tumor-informed MRD)')
  .requiredOption('--tumor-bam <gs>', 'gs:// aligned tumor BAM')
  .requiredOption('--normal-bam <gs>', 'gs:// aligned matched-normal BAM (same reference)')
  .option('--ref-fasta <gs>', 'Explicit gs:// reference fasta the BAMs were aligned to')
  .option('--no-low-memory', 'Disable pbrun --mutect-low-memory')
  .option('--json', 'Output as JSON')
  .action(async (caseId: string, options: SomaticMutectSubmitOptions) => {
    try { await somaticMutectSubmitCommand(caseId, options); }
    catch (error) { Logger.error(`somatic-mutect submit failed: ${error}`); process.exit(1); }
  });

somaticMutectCmd
  .command('exec')
  .description('GPU-side executor: pbrun mutectcaller over NVMe-staged tumor/normal BAMs, persist somatic VCF to GCS')
  .requiredOption('--sample <caseId>', 'Case id (sample names come from the BAM @RG SM tags)')
  .requiredOption('--tumor-bam <gs>', 'gs:// aligned tumor BAM')
  .requiredOption('--normal-bam <gs>', 'gs:// aligned matched-normal BAM')
  .option('--ref-fasta <gs>', 'Explicit gs:// reference fasta')
  .option('--ref <build>', 'Reference build hint appended by the executor spawner (ignored; --ref-fasta wins)', 'auto')
  .option('--no-low-memory', 'Disable pbrun --mutect-low-memory')
  .option('--hotspot <ctg:pos>', 'Identity sanity pileup locus', '12:25398284')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'deepvariant-fastq-to-vcf-genobank-app')
  .action(async (options: SomaticMutectExecOptions) => {
    try { await somaticMutectExecCommand(options); }
    catch (error) { Logger.error(`somatic-mutect exec failed: ${error}`); process.exit(1); }
  });

somaticMutectCmd
  .command('filter')
  .description('CPU verb: GATK FilterMutectCalls over a raw mutectcaller VCF; persists filtered VCF + stats beside it')
  .requiredOption('--vcf <gs>', 'gs:// raw mutect2 .vcf.gz')
  .requiredOption('--ref-fasta <gs>', 'gs:// reference fasta (with .fai and .dict beside it)')
  .option('--stats <gs>', 'gs:// Mutect2 stats file (default: <vcf>.stats)')
  .option('--out-dir <gs>', 'gs:// output folder (default: the raw VCF folder)')
  .action(async (options: SomaticMutectFilterOptions) => {
    try { await somaticMutectFilterCommand(options); }
    catch (error) { Logger.error(`somatic-mutect filter failed: ${error}`); process.exit(1); }
  });

// liftover command group — cross-reference VCF liftover (CrossMap, CHM13 -> GRCh38)
const liftoverCmd = program
  .command('liftover')
  .description('Cross-reference VCF liftover (CrossMap, CHM13 -> GRCh38): submit (client) + exec (VM runner)');

liftoverCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a liftover job to biofs-node (CrossMap a CHM13 VCF to GRCh38 for ClinVar annotation)')
  .requiredOption('--vcf <gs>', 'gs:// CHM13-coordinate VCF to lift')
  .option('--to <build>', 'Target assembly', 'GRCh38')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: LiftoverSubmitOptions) => {
    try { await liftoverSubmitCommand(serial, options); }
    catch (error) { Logger.error(`liftover submit failed: ${error}`); process.exit(1); }
  });

liftoverCmd
  .command('exec')
  .description('VM-side executor: CrossMap CHM13->GRCh38 over the gcsfuse-mounted VCF, persist lifted VCF + reject to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--vcf <gs>', 'gs:// CHM13-coordinate VCF')
  .option('--to <build>', 'Target assembly', 'GRCh38')
  .option('--ref-from <build>', 'Source assembly', 'CHM13')
  .option('--ref <build>', 'Reference build (accepted+ignored; liftover uses --to + chain)', 'auto')
  .option('--tool <engine>', 'Liftover engine: crossmap (default) | gatk (swap-aware, recovers ref-discordant)', 'crossmap')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: LiftoverExecOptions) => {
    try { await liftoverExecCommand(options); }
    catch (error) { Logger.error(`liftover exec failed: ${error}`); process.exit(1); }
  });

// Dipcall command group — assembly-based variant calling (dipcall) for Study 2
const dipcallCmd = program.command('dipcall').description('Assembly-based variant calling (dipcall, phased diploid assembly -> reference): submit (client) + exec (VM runner)');
dipcallCmd.command('submit <serial>', { isDefault: true })
  .description('Submit an assembly-based dipcall job to biofs-node (two haplotype FASTAs -> dip VCF + confident BED)')
  .requiredOption('--hap1 <gs>', 'gs:// haplotype-1 assembly FASTA')
  .requiredOption('--hap2 <gs>', 'gs:// haplotype-2 assembly FASTA')
  .option('--ref <build>', 'Reference: CHM13 | GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: DipcallSubmitOptions) => {
    try { await dipcallSubmitCommand(serial, options); }
    catch (error) { Logger.error(`dipcall submit failed: ${error}`); process.exit(1); }
  });
dipcallCmd.command('exec')
  .description('VM-side executor: dipcall over the staged diploid assembly + reference, persist dip VCF + confident BED to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--hap1 <gs>', 'gs:// haplotype-1 assembly FASTA')
  .requiredOption('--hap2 <gs>', 'gs:// haplotype-2 assembly FASTA')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: DipcallExecOptions) => {
    try { await dipcallExecCommand(options); }
    catch (error) { Logger.error(`dipcall exec failed: ${error}`); process.exit(1); }
  });

// HiFi-align command group — PacBio HiFi read alignment (pbmm2, MM/ML preserved) — the keystone
const hifiAlignCmd = program
  .command('hifi-align')
  .description('PacBio HiFi read alignment (pbmm2 HIFI, 5mC tags preserved): submit (client) + exec (VM runner)');

hifiAlignCmd
  .command('submit <serial>', { isDefault: true })
  .description('Submit a HiFi alignment job to biofs-node (pbmm2 per-cell + merge, persist aligned BAM)')
  .requiredOption('--bams <csv>', 'CSV of gs:// unaligned HiFi BAM URIs (carry MM/ML 5mC tags)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: HifiAlignSubmitOptions) => {
    try { await hifiAlignSubmitCommand(serial, options); }
    catch (error) { Logger.error(`hifi-align submit failed: ${error}`); process.exit(1); }
  });

hifiAlignCmd
  .command('exec')
  .description('VM-side executor: pbmm2 align each HiFi cell (HIFI preset) + merge, persist aligned BAM to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bams <csv>', 'CSV of gs:// unaligned HiFi BAM URIs')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id')
  .option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: HifiAlignExecOptions) => {
    try { await hifiAlignExecCommand(options); }
    catch (error) { Logger.error(`hifi-align exec failed: ${error}`); process.exit(1); }
  });

// ---- downstream verbs the hifi-align keystone unblocks (M3/M4/M5/M9) ----

// pbsv — HiFi read-based structural variants
const pbsvCmd = program.command('pbsv').description('HiFi read-based structural-variant calling (pbsv): submit (client) + exec (VM runner)');
pbsvCmd.command('submit <serial>', { isDefault: true })
  .description('Submit a HiFi pbsv SV-calling job to biofs-node (pbsv over the aligned HiFi BAM)')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM (the pbsv-calling input)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: PbsvSubmitOptions) => {
    try { await pbsvSubmitCommand(serial, options); } catch (error) { Logger.error(`pbsv submit failed: ${error}`); process.exit(1); }
  });
pbsvCmd.command('exec')
  .description('VM-side executor: pbsv discover+call over the gcsfuse-mounted HiFi BAM, persist SV VCF to GCS')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id').option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: PbsvExecOptions) => {
    try { await pbsvExecCommand(options); } catch (error) { Logger.error(`pbsv exec failed: ${error}`); process.exit(1); }
  });

// repeat-genotype — tandem-repeat / repeat-expansion genotyping (TRGT)
const repeatCmd = program.command('repeat-genotype').description('Tandem-repeat / repeat-expansion genotyping (TRGT): submit (client) + exec (VM runner)');
repeatCmd.command('submit <serial>', { isDefault: true })
  .description('Submit a TRGT repeat-genotyping job to biofs-node (aligned HiFi BAM + repeat catalog)')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM (the genotyping input)')
  .requiredOption('--catalog <gs>', 'gs:// repeat catalog BED (repeat definitions)')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: RepeatGenotypeSubmitOptions) => {
    try { await repeatGenotypeSubmitCommand(serial, options); } catch (error) { Logger.error(`repeat-genotype submit failed: ${error}`); process.exit(1); }
  });
repeatCmd.command('exec')
  .description('VM-side executor: TRGT genotype over the gcsfuse-mounted HiFi BAM + catalog, persist repeat VCF')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM')
  .requiredOption('--catalog <gs>', 'gs:// repeat catalog BED')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id').option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: RepeatGenotypeExecOptions) => {
    try { await repeatGenotypeExecCommand(options); } catch (error) { Logger.error(`repeat-genotype exec failed: ${error}`); process.exit(1); }
  });

// phase — genome-wide read-backed phasing (HiPhase)
const phaseCmd = program.command('phase').description('Genome-wide read-backed phasing (HiPhase): submit (client) + exec (VM runner)');
phaseCmd.command('submit <serial>', { isDefault: true })
  .description('Submit a HiPhase phasing job to biofs-node (aligned HiFi BAM + small-variant VCF)')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM')
  .requiredOption('--vcf <gs>', 'gs:// small-variant VCF to phase')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: PhaseSubmitOptions) => {
    try { await phaseSubmitCommand(serial, options); } catch (error) { Logger.error(`phase submit failed: ${error}`); process.exit(1); }
  });
phaseCmd.command('exec')
  .description('VM-side executor: HiPhase over the gcsfuse-mounted HiFi BAM + VCF, persist phased VCF + haplotagged BAM')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM')
  .requiredOption('--vcf <gs>', 'gs:// small-variant VCF')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id').option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: PhaseExecOptions) => {
    try { await phaseExecCommand(options); } catch (error) { Logger.error(`phase exec failed: ${error}`); process.exit(1); }
  });

// hifi-methyl — orthogonal HiFi 5mC methylome (pb-CpG-tools)
const hifiMethylCmd = program.command('hifi-methyl').description('Orthogonal HiFi 5mC methylome (pb-CpG-tools): submit (client) + exec (VM runner)');
hifiMethylCmd.command('submit <serial>', { isDefault: true })
  .description('Submit a pb-CpG-tools HiFi methylome job to biofs-node (aligned HiFi BAM with MM/ML tags)')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM carrying MM/ML 5mC tags')
  .option('--ref <build>', 'Reference: GRCh38 | auto', 'auto')
  .option('--json', 'Output as JSON')
  .action(async (serial: string, options: HifiMethylSubmitOptions) => {
    try { await hifiMethylSubmitCommand(serial, options); } catch (error) { Logger.error(`hifi-methyl submit failed: ${error}`); process.exit(1); }
  });
hifiMethylCmd.command('exec')
  .description('VM-side executor: pb-CpG-tools over the gcsfuse-mounted HiFi BAM, persist 5mCG bedMethyl')
  .requiredOption('--sample <serial>', 'Biosample serial / SAMPLE')
  .requiredOption('--bam <gs>', 'gs:// aligned HiFi BAM')
  .option('--ref <build>', 'Reference build', 'auto')
  .option('--job-id <id>', 'Job id').option('--batch-id <id>', 'Batch id')
  .option('--creator <wallet>', 'Creator wallet (lowercased for GCS path)')
  .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
  .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
  .action(async (options: HifiMethylExecOptions) => {
    try { await hifiMethylExecCommand(options); } catch (error) { Logger.error(`hifi-methyl exec failed: ${error}`); process.exit(1); }
  });

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

// job reconcile - Mark stale clara_jobs (processing/queued) as failed
jobCmd
  .command('reconcile')
  .description('Mark stale clara_jobs (processing/queued past N hours) as failed — admin only. Required cleanup after GPU spot preemption before launching a fresh cohort-pipeline.')
  .option('--older-than <hours>', 'Threshold in hours (default 12)', '12')
  .option('--statuses <csv>', 'Comma-separated statuses to reconcile (default processing,queued)', 'processing,queued')
  .option('--json', 'Output as JSON')
  .action(async (options: JobReconcileOptions) => {
    try {
      await jobReconcileCommand(options);
    } catch (error) {
      Logger.error(`job reconcile failed: ${error}`);
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

researcherCmd
  .command('passport')
  .description('Publish or show known-identity passport (shown on Biodata Room admit / Telegram)')
  .option('--publish', 'Publish/update passport on biofs-node (default if no --show)')
  .option('--show', 'Show passport for a wallet')
  .option('--name <name>', 'Display name')
  .option('--provider <provider>', 'orcid|linkedin|twitter|google|metamask|…')
  .option('--orcid <id>', 'ORCID iD')
  .option('--linkedin <url>', 'LinkedIn profile URL')
  .option('--twitter <handle>', 'X / Twitter handle')
  .option('--institution <name>', 'Institution')
  .option('--ga4gh <level>', 'NONE|BASIC|LITE|FULL', 'BASIC')
  .option('--wallet <addr>', 'Wallet for --show')
  .option('--json', 'JSON output')
  .option('--quiet', 'Quiet')
  .action(async (options: PassportOptions & { publish?: boolean; show?: boolean }) => {
    try {
      if (options.show || options.wallet) {
        await researcherPassportShowCommand(options);
      } else {
        await researcherPassportPublishCommand(options);
      }
    } catch (error) {
      Logger.error(`Passport failed: ${error}`);
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

// Lab — single-lab operations (refresh-coverage, future: backfill, audit)
// Distinct from the read-only `labnfts` (plural) registry-listing command above.
const labCmd = program
  .command('lab')
  .description('Single-lab operations (refresh-coverage, audit, backfill)');

labCmd
  .command('refresh-coverage')
  .description('Stream higher-coverage FASTQ replacements from a lab S3 origin into the GCS mirror, supersede stale inventory rows, optionally invalidate downstream pipeline outputs')
  .requiredOption('--lab <name>', 'Lab name (e.g. augenomics, tecbase)')
  .requiredOption('--source <s3_uri>', 'S3 source prefix (e.g. s3://genobank/Demux/20240412_ExomeGB_ExtraReadsCombined)')
  .option('--aws-profile <profile>', 'AWS profile name for the source bucket (server-side)', 'augenomics')
  .option('--serials <csv>', 'Comma-separated biosample serials to upgrade (with or without lab FR prefix)')
  .option('--serials-file <path>', 'Newline-separated serials file (alternative to --serials)')
  .option('--invalidate-downstream', 'Mark prior BAM/VCF/sqlite as SUPERSEDED so the pipeline re-runs with the deeper FASTQs')
  .option('--re-run-pipeline', 'After refresh, queue `biofs pipeline run-wes` for each upgraded serial')
  .option('--dry-run', 'Print plan + byte deltas, do not stream')
  .option('--wait', 'Poll until job terminal (done|failed); 90-min ceiling')
  .option('--quiet', 'Suppress progress output')
  .option('--json', 'JSON output')
  .action(async (options: LabRefreshCoverageOptions) => {
    try {
      await labRefreshCoverageCommand(options);
    } catch (error) {
      Logger.error(`refresh-coverage failed: ${error}`);
      process.exit(1);
    }
  });

labCmd
  .command('refresh-coverage-status <job_id>')
  .description('Show progress of a refresh-coverage job')
  .option('--json', 'JSON output')
  .action(async (jobId: string, options: { json?: boolean }) => {
    try {
      await labRefreshCoverageStatusCommand(jobId, options);
    } catch (error) {
      Logger.error(`status failed: ${error}`);
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

// RRM-consensus — pre-compute Cosic characteristic frequency f_c from a
// gene's functional family for downstream f_c-based variant scoring.
program
  .command('rrm-consensus <gene>')
  .description('Compute Cosic-RRM characteristic frequency f_c via cross-spectrum of a gene\'s functional family')
  .option('--source <family|orthologs>', 'Sequence source: Pfam family (default) or same-name orthologs', 'family')
  .option('--taxonomy <id>', 'NCBI taxonomy id (default 7742 = Vertebrata)', '7742')
  .option('--no-reviewed', 'Include TrEMBL entries (default: Swiss-Prot reviewed only)')
  .option('--max <N>', 'Max sequences to pull (default 100)', '100')
  .option('--uniprot <acc>', 'Override UniProt accession (for novel genes)')
  .option('--pfam <id>', 'Override Pfam family (for novel genes)')
  .option('--refresh', 'Re-fetch and recompute even if cached')
  .option('--plot <path>', 'Render consensus spectrum to PNG with f_c annotated')
  .option('--quiet', 'Suppress progress output')
  .action(async (gene: string, options: RrmConsensusOptions) => {
    try {
      await rrmConsensusCommand(gene, options);
    } catch (error) {
      Logger.error(`RRM consensus failed: ${error}`);
      process.exit(1);
    }
  });

// PSM-consensus — Piezoelectric Signal Model: same cross-spectrum maths as
// rrm-consensus, but with side-chain dipole moment (Debye) replacing EIIP.
// Tests the hypothesis that the piezoelectric encoding picks up
// electromechanical resonances that the electron-donor EIIP table misses,
// especially in ion channels, transporters, and force sensors.
program
  .command('psm-consensus <gene>')
  .description('Piezoelectric Signal Model: characteristic frequency f_c via side-chain-dipole cross-spectrum')
  .option('--source <family|orthologs>', 'Sequence source: Pfam family (default) or same-name orthologs', 'family')
  .option('--taxonomy <id>', 'NCBI taxonomy id (default 7742 = Vertebrata)', '7742')
  .option('--no-reviewed', 'Include TrEMBL entries (default: Swiss-Prot reviewed only)')
  .option('--max <N>', 'Max sequences to pull (default 100)', '100')
  .option('--uniprot <acc>', 'Override UniProt accession (for novel genes)')
  .option('--pfam <id>', 'Override Pfam family (for novel genes)')
  .option('--refresh', 'Re-fetch and recompute even if cached')
  .option('--plot <path>', 'Render PSM spectrum to PNG with f_c annotated')
  .option('--quiet', 'Suppress progress output')
  .action(async (gene: string, options: PsmConsensusOptions) => {
    try {
      await psmConsensusCommand(gene, options);
    } catch (error) {
      Logger.error(`PSM consensus failed: ${error}`);
      process.exit(1);
    }
  });

// Wavelet-consensus — 2-D (position by scale) Morlet CWT consensus map for a
// gene's functional family. Spatial-spectral generalization of rrm-consensus.
// Addresses the v1 paper auditor's third upgrade point: localize variants at
// position and scale jointly rather than at a single fixed window size.
program
  .command('wavelet-consensus <gene>')
  .description('Morlet continuous wavelet transform consensus map (position by scale) for a gene family')
  .option('--source <family|orthologs>', 'Sequence source (default orthologs)', 'orthologs')
  .option('--taxonomy <id>', 'NCBI taxonomy id', '7742')
  .option('--no-reviewed', 'Include TrEMBL (default Swiss-Prot only)')
  .option('--max <N>', 'Max sequences', '100')
  .option('--uniprot <acc>', 'Override UniProt accession')
  .option('--pfam <id>', 'Override Pfam family')
  .option('--encoding <eiip|piezo>', 'Per-residue index (default eiip)', 'eiip')
  .option('--scales <list>', 'Comma scales in aa (default 2,3,4,6,8,12,16,24,32,48,64,96)')
  .option('--refresh', 'Re-fetch + recompute')
  .option('--quiet', 'Suppress progress')
  .action(async (gene: string, options: WaveletConsensusOptions) => {
    try {
      await waveletConsensusCommand(gene, options);
    } catch (error: any) {
      Logger.error(`wavelet-consensus failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// Score-protein — the Super-SCDS Phase A.2 canonical scoring verb. For one
// UniProt accession, fetch FASTA, load cached RRM/PSM consensuses, compute
// the SCDS family per missense variant, upsert into MongoDB collections
// scds_consensuses + scds_variants via /api_scds/upsert_protein on prod.
program
  .command('score-protein <uniprot>')
  .description('Super-SCDS Phase A.2: score one UniProt protein and upsert into scds_consensuses + scds_variants')
  .option('--gene-symbol <symbol>', 'Gene symbol (e.g., BRCA1) used as a fallback consensus-cache key')
  .option('--source <family|orthologs|trembl>', 'Family source for consensus (default: family)', 'family')
  .option('--taxonomy <id>', 'NCBI taxonomy id (default 7742 = Vertebrata)', '7742')
  .option('--pfam <id>', 'Override Pfam family')
  .option('--api-base <url>', 'GenoBank API base (default https://genobank.app)')
  .option('--dry-run', 'Compute and emit the payload, do not POST')
  .option('--skip-mongo-upsert', 'Compute the full payload but skip the API call (alias for --dry-run + no stdout)')
  .option('--output <path>', 'Write the payload to a JSON file')
  .option('--quiet', 'Suppress progress')
  .action(async (uniprot: string, options: ScoreProteinOptions) => {
    try {
      await scoreProteinCommand(uniprot, options);
    } catch (error: any) {
      Logger.error(`score-protein failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// Inventory subcommand: register-sqlite (closes v2 audit gap §5 item 2).
program
  .command('inventory-register-sqlite <sqlite-path>')
  .description('Register an externally-produced OpenCRAVAT annotation sqlite into bioroutes.inventory (v3.8.0 endpoint)')
  .requiredOption('--sample-serial <serial>', 'Biosample serial identifier (14-digit or lab-case-id form)')
  .option('--owner-wallet <addr>', 'Override owner biowallet (default: from `biofs login`)')
  .option('--case-id <id>', 'Optional lab case identifier (e.g., TN25-336147)')
  .option('--gcs-uri <uri>', 'Optional GCS URI if the sqlite is also stored in GCS')
  .option('--originlab <name>', 'Source lab name (e.g., caris, augenomics, genobank)', 'genobank')
  .option('--api-base <url>', 'GenoBank API base (default https://genobank.app)')
  .option('--dry-run', 'Compute and print the registration payload without calling the API')
  .option('--output <path>', 'Write the registration payload to a JSON file')
  .option('--quiet', 'Suppress progress')
  .action(async (sqlitePath: string, options: InventoryRegisterSqliteOptions) => {
    try {
      await inventoryRegisterSqliteCommand(sqlitePath, options);
    } catch (error: any) {
      Logger.error(`inventory-register-sqlite failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// Ingest rna-tpm — canonical wrapper for RNA TPM CSV ingestion (closes v2 audit
// gap §5 item 4).
program
  .command('ingest-rna-tpm <case-id>')
  .description('Ingest a gene-level RNA TPM CSV into the caris_rna_tpm MongoDB collection (v3.8.0 endpoint)')
  .option('--biocid <id>', 'BioRouter biocid pointing to the RNA TPM CSV')
  .option('--gcs-path <uri>', 'GCS URI of the RNA TPM CSV (if biocid is not yet registered)')
  .option('--owner-wallet <addr>', 'Override owner biowallet (default: from `biofs login`)')
  .option('--source-lab <name>', 'Source lab (e.g., caris, augenomics)', 'unknown')
  .option('--data-category <type>', 'Data category tag (default rna)', 'rna')
  .option('--expected-columns <list>', 'CSV column names', 'Gene,TPM,NumReads')
  .option('--no-drop-zero-tpm', 'Keep zero-TPM rows (default drops them)')
  .option('--api-base <url>', 'GenoBank API base (default https://genobank.app)')
  .option('--dry-run', 'Compute and print the ingest payload without calling the API')
  .option('--quiet', 'Suppress progress')
  .action(async (caseId: string, options: IngestRnaTpmOptions) => {
    try {
      await ingestRnaTpmCommand(caseId, options);
    } catch (error: any) {
      Logger.error(`ingest-rna-tpm failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// Tokenize-spectrum — emit LLM-friendly POS_NNNN__FREQ_F.FF__E_BINxx__P_BINxx
// tokens from a cached wavelet consensus (v3.8.0 roadmap item P2). Designed
// for autonomous-agent consumption on Claude / GPT / Llama. Reversibility via
// regex r"POS_(\d+)" on any flagged token.
program
  .command('tokenize-spectrum <gene>')
  .description('Emit LLM-friendly discrete spectral tokens for a gene with optional variant context')
  .option('--variant <hgvs>', 'Center the position window on this HGVS variant (e.g. p.Gly12Asp)')
  .option('--position-window <N>', 'Residues on each side of the variant', '10')
  .option('--encoding <eiip|piezo>', 'Primary encoding to load (both are included if cached)', 'eiip')
  .option('--vocab-bins <list>', 'Comma dB cutoffs for the BIN00-BIN06 vocabulary', '0,3,6,10,15,20')
  .option('--scale-binning <mode>', 'top5 (default), all, or characteristic', 'top5')
  .option('--format <type>', 'tokens (default plain string) or json', 'tokens')
  .option('--output <path>', 'Write to file instead of stdout')
  .option('--quiet', 'Suppress progress')
  .action(async (gene: string, options: TokenizeSpectrumOptions) => {
    try {
      await tokenizeSpectrumCommand(gene, options);
    } catch (error: any) {
      Logger.error(`tokenize-spectrum failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// Bode — render log-log |H(jω)| transfer function plots from cached rrm-consensus
// and psm-consensus spectra. Single-gene mode (bode <gene>) or panel mode
// (bode --panel <list>) for paper figures.
program
  .command('bode [gene]')
  .description('Log-log Bode plot of protein-family transfer function |H(jω)| from rrm-consensus / psm-consensus caches')
  .option('--panel <list>', 'Comma gene symbols for multi-gene panel grid')
  .option('--output <path>', 'Output file path (default ~/.biofs/cache/bode/<gene-or-hash>.png)')
  .option('--pdf', 'Emit PDF instead of PNG')
  .option('--rna-tpm <case_id>', 'Pull Caris RNA TPM for the case_id and annotate each gene')
  .option('--api-base <url>', 'GenoBank API base for RNA TPM lookups (default https://genobank.app)')
  .option('--no-rrm', 'Suppress RRM (EIIP) curve')
  .option('--no-psm', 'Suppress PSM (piezo) curve')
  .option('--cols <N>', 'Panel grid column count (default 3)')
  .option('--quiet', 'Suppress progress (still prints output path)')
  .action(async (gene: string | undefined, options: BodeOptions) => {
    try {
      await bodeCommand(gene, options);
    } catch (error: any) {
      Logger.error(`bode failed: ${error?.message || error}`);
      process.exit(1);
    }
  });

// Biowallet — mint and manage de-novo EIP-55 custodial biowallets for patients
const biowalletCmd = program
  .command('biowallet')
  .description('Mint and manage de-novo EIP-55 custodial biowallets that patients can later claim');

biowalletCmd
  .command('create')
  .description('Mint a fresh EIP-55 biowallet (random keypair, BIP-39 mnemonic, encrypted keystore)')
  .option('--bind-biosample <serials>', 'Comma-separated biosample serials to bind to the new biowallet')
  .option('--label <text>', 'Human-readable label (stored locally only, not on-chain)')
  .option('--password <pw>', 'Keystore password; if omitted, a random one is generated and printed once')
  .option('--out-dir <path>', 'Alternative output directory (default ~/.biofs/biowallets/)')
  .option('--no-mnemonic-file', "Don't persist the mnemonic to disk (operator must transcribe at creation)")
  .option('--json', 'Output as JSON (DANGER: includes secrets)')
  .option('--quiet', 'Suppress progress output')
  .action(async (options: BiowalletCreateOptions) => {
    try {
      await biowalletCreateCommand(options);
    } catch (error) {
      Logger.error(`Biowallet create failed: ${error}`);
      process.exit(1);
    }
  });

biowalletCmd
  .command('list')
  .description('List all local biowallets and their bound biosamples')
  .option('--operator <wallet>', 'Filter by operator wallet address')
  .option('--status <s>', 'Filter by status (operator-custodial | patient-claimed)')
  .option('--biosample <serial>', 'Filter to wallets bound to a specific biosample')
  .option('--short', 'Print addresses only, one per line')
  .option('--json', 'Output as JSON')
  .action(async (options: BiowalletListOptions) => {
    try {
      await biowalletListCommand(options);
    } catch (error) {
      Logger.error(`Biowallet list failed: ${error}`);
      process.exit(1);
    }
  });

biowalletCmd
  .command('bind <address> <biosample>')
  .description('Bind an existing local biowallet to a biosample serial')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress progress output')
  .action(async (address: string, biosample: string, options: BiowalletBindOptions) => {
    try {
      await biowalletBindCommand(address, biosample, options);
    } catch (error) {
      Logger.error(`Biowallet bind failed: ${error}`);
      process.exit(1);
    }
  });

// Family vault — BIP-32 HD wallet, one mnemonic deriving N child biowallets
const familyCmd = biowalletCmd
  .command('family')
  .description('Family Vault: one BIP-32 master mnemonic deriving N child biowallets (m/44\'/60\'/0\'/0/index)');

familyCmd
  .command('create')
  .description('Create a new family vault with optional initial members')
  .option('--label <text>', 'Human-readable label for the family')
  .option('--password <pw>', 'Keystore password (random if omitted)')
  .option('--members <list>', 'Comma-separated initial members in "role:biosample[:label]" format (e.g. mother:56102007614179,father:56102007614180,child:56102007614196,child:56102007614194)')
  .option('--no-mnemonic-file', "Don't persist the master mnemonic to disk")
  .option('--json', 'Output as JSON (DANGER: includes master mnemonic)')
  .option('--quiet', 'Suppress progress output')
  .action(async (options: FamilyCreateOptions) => {
    try {
      await familyCreateCommand(options);
    } catch (error) {
      Logger.error(`Family create failed: ${error}`);
      process.exit(1);
    }
  });

familyCmd
  .command('derive <family_id> <index>')
  .description('Derive an additional member at a specific index in an existing family vault')
  .option('--role <text>', 'Role label (mother, father, child_1, etc.)')
  .option('--bind-biosample <serials>', 'Comma-separated biosample serials to bind')
  .option('--label <text>', 'Human-readable label')
  .option('--json', 'Output as JSON')
  .option('--quiet', 'Suppress progress output')
  .action(async (familyId: string, index: string, options: FamilyDeriveOptions) => {
    try {
      await familyDeriveCommand(familyId, index, options);
    } catch (error) {
      Logger.error(`Family derive failed: ${error}`);
      process.exit(1);
    }
  });

familyCmd
  .command('list [family_id]')
  .description('List family vaults (and members if a family_id is given)')
  .option('--json', 'Output as JSON')
  .action(async (familyId: string | undefined, options: FamilyListOptions) => {
    try {
      await familyListCommand(familyId, options);
    } catch (error) {
      Logger.error(`Family list failed: ${error}`);
      process.exit(1);
    }
  });

// RRM-distribution — pull ClinVar classified missense for a gene and rank
// patient variants against the empirical distribution.
program
  .command('rrm-distribution <gene>')
  .description('Pull ClinVar classified missense for a gene and compute Cosic-RRM features for each, with optional patient-variant highlight and optional gnomAD pseudo-benign synthesis')
  .option('--highlight <variants>', 'Comma-separated HGVS protein changes to mark on the distribution (e.g. ITGA2B:p.Val779Ala,ITGA2B:p.Leu225Arg)')
  .option('--retmax <N>', 'Max ClinVar IDs to pull (default 10000; ClinVar VUS / Conflicting are excluded server-side)', '10000')
  .option('--gnomad-benigns <N>', 'Synthesize N pseudo-benign control variants from gnomAD common missense (e.g. 40 for rare-disease genes whose ClinVar B+LB is empty)')
  .option('--gnomad-min-af <af>', 'gnomAD AF threshold for pseudo-benign eligibility (default 0.01)', '0.01')
  .option('--plot <path>', 'Render 4-panel distribution figure to PNG')
  .option('--refresh', 'Re-fetch and recompute even if cached')
  .option('--quiet', 'Suppress progress output')
  .action(async (gene: string, options: RrmDistributionOptions) => {
    try {
      await rrmDistributionCommand(gene, options);
    } catch (error) {
      Logger.error(`RRM distribution failed: ${error}`);
      process.exit(1);
    }
  });

// Clinical — phenotype-driven multi-exome ACMG classifier for a single proband
// (n-of-1 or joint-N exomes from the same individual). Complements `cohort-acmg`
// which is batch-mode across many probands but only emits ClinVar P/LP.
program
  .command('clinical <biosample_serial>')
  .description('Phenotype-driven, multi-exome ACMG/AMP 2015 + ClinGen-SVI 2024 classifier. Provide a primary biosample serial, optional --serials list (joint-N exomes), and phenotype context (--phenotype words OR --hpo codes; --photo optional). Returns P/LP/VUS/LB/B with per-variant evidence stacks. Server-side, NFT-gated, no genomic bytes on laptop.')
  .option('--serials <list>', 'Comma-separated additional biosample serials for joint analysis (all assumed same individual)')
  .option('--hpo <codes>', 'Comma-separated HPO codes, e.g. HP:0000924,HP:0002659')
  .option('--phenotype <text>', 'Free-text phenotype description (mapped to HPO via local HPOA annotations)')
  .option('--photo <path>', 'Patient photo for Face2Gene-style syndrome prediction (graceful fallback if server lacks API key)')
  .option('--panel <name>', 'Gene panel name: skeletal_dysplasia (default), or none for HPO-only', 'skeletal_dysplasia')
  .option('--max-af <af>', 'gnomAD AF ceiling (default 0.01)', '0.01')
  .option('--output <dir>', 'Output directory (default ./clinical_reports/)')
  .option('--case-label <label>', 'Privacy-safe label for the case (no proper names per CLAUDE.md). Default proband-<wallet-prefix>.')
  .option('--format <fmt>', 'json | html | both (default both)', 'both')
  .option('--quiet', 'Suppress progress output')
  .option('--debug', 'Print full server response on error')
  .action(async (biosample: string, options: ClinicalOptions) => {
    try {
      await clinicalCommand(biosample, options);
    } catch (error) {
      Logger.error(`clinical failed: ${error}`);
      process.exit(1);
    }
  });

// Cohort-pipeline — batch FASTQ→VCF→sqlite→fhir.variant→Digital-Twin via
// the canonical biofs-cli + biofs-node + BioRouter + Sequentia protocol.
// Each per-serial run is `biofs pipeline run-wes <serial>`; this verb just
// fans them out with concurrency control + auto-mints custodial biowallets.
program
  .command('cohort-pipeline')
  .description('Batch end-to-end pipeline (FASTQ → Clara → CRAVAT → Vault → Digital Twin) across a cohort of biosample serials. Internally fans out `biofs pipeline run-wes <serial>`; auto-mints custodial biowallets for unbound serials via `biofs biowallet create --bind-biosample`. Resume-aware (skips serials already PHASE_RANGE_DONE in bioroutes.pipeline_runs).')
  .requiredOption('--serials <file>', 'File with one biosample serial per line. Use `biofs inventory cohort` to generate.')
  .option('--concurrency <N>', 'Number of parallel per-serial pipelines (default 1; max 2 for 2× A100 GPU)', '1')
  .option('--limit <N>', 'Process at most N serials (0 = all)', '0')
  .option('--output <dir>', 'Output directory for per-serial result JSONs + cohort summary (default ./cohort_pipeline_runs/<timestamp>/)')
  .option('--no-skip-existing', 'Re-run serials even if they already have a PHASE_RANGE_DONE pipeline_run')
  .option('--no-auto-mint-wallets', 'Skip the biowallet pre-mint step (assumes wallets already bound)')
  .option('--mode <WES|WGS>', 'Override auto-detection of WES vs WGS for the whole cohort')
  .option('--phase <range>', 'Run a subset of phases per serial (e.g. "1-4", "5-10", "all")')
  .option('--exclude <csv>', 'Comma-separated serials to skip (e.g. operator\'s own genome, already-ingested samples)')
  .option('--stop-on-failure <mode>', 'When to halt cohort: "first" (default), "never", or integer N for N consecutive failures', 'first')
  .option('--dry-run', 'Print what would happen but don\'t execute side-effecting phases')
  .option('--quiet', 'Suppress per-serial progress')
  .option('--json', 'Emit machine-readable JSON summary')
  .action(async (options: CohortPipelineOptions) => {
    try {
      await cohortPipelineCommand(options);
    } catch (error) {
      Logger.error(`cohort-pipeline failed: ${error}`);
      process.exit(1);
    }
  });

// Cohort-acmg — batch ACMG/SVI-compliant processor for an n-of-many cohort
program
  .command('cohort-acmg')
  .description('Batch process a cohort of biosample serials: mint biowallets (idempotent), extract ClinVar P+LP, apply ACMG-SVI evidence stacks per Section 2.7 of the biofs-rrm paper. Output keyed on biowallet (operator-private serial mapping preserved).')
  .option('--serials <file>', 'File with one biosample serial per line (required)')
  .option('--output <dir>', 'Output directory for per-biowallet JSON reports (default ./cohort_acmg_reports/)')
  .option('--limit <N>', 'Process at most N serials (0 = all)', '0')
  .option('--skip-existing', 'Skip serials whose per-biowallet report already exists')
  .option('--quiet', 'Suppress per-proband progress spinners')
  .action(async (options: CohortAcmgOptions) => {
    try {
      await cohortAcmgCommand(options);
    } catch (error) {
      Logger.error(`cohort-acmg failed: ${error}`);
      process.exit(1);
    }
  });

// Cohort-fourier-score — per-patient × per-variant Cosic-RRM spectral scoring,
// the missing rung between single-variant `biofs fourier-score` and the
// per-gene ClinVar `biofs cohort-train`. Section 14.4 of the biofs-rrm paper
// proposes this verb explicitly. Server-side, NFT-gated, gcsfuse-mounted.
program
  .command('cohort-fourier-score')
  .description('Cohort-scale Cosic-RRM (EIIP + DFT) spectral scoring: for each biosample serial, extract rare missense variants, compute the five Cosic metrics (windowed Σ|ΔF|, windowed ΔE%, full-spectrum L1, f_c ratio, weighted aggregate ΔE%) against the cached family characteristic frequency, return per-biowallet score matrices. Server-side, NFT-gated, zero genomic bytes on laptop.')
  .option('--serials <file>', 'File with one biosample serial per line (mutually exclusive with --from-acmg)')
  .option('--from-acmg <path>', 'Recover serials from a prior `biofs cohort-acmg` cohort_summary.json via the operator-private biowallet index (recommended path)')
  .option('--output <dir>', 'Output directory for per-biowallet JSON reports (default ./cohort_fourier_reports/)')
  .option('--limit <N>', 'Process at most N serials (0 = all)', '0')
  .option('--max-af <af>', 'gnomAD AF ceiling for rare-missense filter (default 0.01)', '0.01')
  .option('--am-threshold <s>', 'AlphaMissense threshold for the --include-high-am rule (default 0.5)', '0.5')
  .option('--include-vus', 'Also score ClinVar VUS variants (otherwise ClinVar P/LP only)')
  .option('--include-high-am', 'Also score variants with AlphaMissense ≥ --am-threshold even if absent from ClinVar')
  .option('--window <N>', 'Window size (residues) for the centered Σ|ΔF| (default 31)')
  .option('--window-tm <N>', 'Window size for variants in transmembrane regions (default 51)')
  .option('--skip-existing', 'Skip serials whose per-biowallet report already exists')
  .option('--quiet', 'Suppress per-proband progress spinners')
  .action(async (options: CohortFourierScoreOptions) => {
    try {
      await cohortFourierScoreCommand(options);
    } catch (error) {
      Logger.error(`cohort-fourier-score failed: ${error}`);
      process.exit(1);
    }
  });

// MyVariant — standalone interface to MyVariant.info v1 API
program
  .command('myvariant [id_or_query]')
  .description('Query MyVariant.info v1: single variant, batch from file, gene-wide, or raw /query expression')
  .option('--batch <file>', 'Batch lookup from a file with one ID (HGVS or rsID) per line')
  .option('--gene <symbol>', 'Fetch variants in a gene via /query (uses dbnsfp/clinvar/snpeff gene_name)')
  .option('--query', 'Treat the positional argument as a raw /query expression')
  .option('--fields <list>', 'Comma-separated MyVariant.info field paths (overrides presets)')
  .option('--predictors', 'Shortcut for AM/REVEL/PrimateAI/EVE/ESM1b/CADD/MetaRNN/BayesDel/ClinPred')
  .option('--clinical', 'Shortcut for ClinVar/COSMIC/gnomAD/1000G/ExAC/EMV')
  .option('--basic', 'Shortcut for dbSNP rsID/HGVS/VCF/SnpEff annotations')
  .option('--all', 'Predictors + clinical + basic')
  .option('--assembly <hg19|hg38>', 'Assembly for HGVS-coordinate queries (informational)', 'hg38')
  .option('--limit <N>', 'Max records for /gene or /query mode (default 500 gene, 200 query)')
  .option('--json', 'Output raw JSON')
  .option('--csv', 'Output as CSV')
  .option('--tsv', 'Output as TSV')
  .option('--out-file <path>', 'Write output to file instead of stdout')
  .option('--quiet', 'Suppress progress spinner')
  .action(async (idArg: string | undefined, options: MyVariantOptions) => {
    try {
      await myvariantCommand(idArg, options);
    } catch (error) {
      Logger.error(`MyVariant query failed: ${error}`);
      process.exit(1);
    }
  });

// Cohort-train — apply the rrm-consensus + rrm-distribution + rrm-train pipeline
// across a cohort of disease genes to characterize Cosic-RRM's applicability domain
program
  .command('cohort-train')
  .description('Multi-gene benchmark: run rrm-consensus + rrm-distribution + rrm-train across a cohort and report per-gene AUC deltas')
  .option('--genes <list>', 'Comma-separated gene symbols')
  .option('--gene-file <path>', 'File with one gene symbol per line (lines starting with # are comments)')
  .option('--min-train <N>', 'Skip genes with fewer than N labeled training variants (default 8)', '8')
  .option('--ortholog-source <s>', 'rrm-consensus --source value (default "orthologs")', 'orthologs')
  .option('--refresh-consensus', 'Re-fetch UniProt orthologs and recompute consensus even if cached')
  .option('--refresh-distribution', 'Re-fetch ClinVar variants and recompute distribution even if cached')
  .option('--gnomad-benigns <N>', 'Synthesize N pseudo-benign control variants per gene from gnomAD common missense (unlocks AUC benchmarking on rare-disease genes whose ClinVar B+LB is empty)')
  .option('--gnomad-min-af <af>', 'gnomAD AF threshold for pseudo-benign eligibility (default 0.01)', '0.01')
  .option('--output <path>', 'JSON manifest output path (default ~/.biofs/cache/rrm/cohort_<hash>.json)')
  .option('--plot <path>', 'Render 3-panel cohort benchmark figure to PNG')
  .option('--quiet', 'Suppress per-gene progress output')
  .action(async (options: CohortTrainOptions) => {
    try {
      await cohortTrainCommand(options);
    } catch (error) {
      Logger.error(`Cohort training failed: ${error}`);
      process.exit(1);
    }
  });

// RRM-train — XGBoost ensemble combining Cosic-RRM with deep-learning predictors
program
  .command('rrm-train <gene>')
  .description('Train XGBoost ensemble combining Cosic-RRM features with AlphaMissense/REVEL/PrimateAI for variant pathogenicity prediction')
  .option('--predict <variants>', 'Comma-separated HGVS protein changes to predict (e.g. ITGA2B:p.Val779Ala,ITGA2B:p.Leu225Arg)')
  .option('--folds <N>', 'Stratified CV folds (default 5)', '5')
  .option('--plot <path>', 'Render ROC curves + feature importance to PNG')
  .option('--refresh', 'Re-fetch MyVariant.info scores even if cached')
  .option('--include-predictions', 'Persist per-variant CV predictions for downstream stacking analysis')
  .option('--quiet', 'Suppress progress output')
  .action(async (gene: string, options: RrmTrainOptions) => {
    try {
      await rrmTrainCommand(gene, options);
    } catch (error) {
      Logger.error(`RRM training failed: ${error}`);
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
  .option('--plot <path>', 'Render |ΔF| windowed spectrum to PNG (one panel per variant)')
  .option('--consensus-fc', 'Also score full-protein DFT at family characteristic frequency f_c (requires `biofs rrm-consensus <gene>` first)')
  .option('--plot-full <path>', 'Render full-protein |X(k)| spectrum to PNG with f_c annotated (requires --consensus-fc)')
  .option('--quiet', 'Suppress progress output')
  .action(async (variants: string, options: FourierScoreOptions) => {
    try {
      await fourierScoreCommand(variants, options);
    } catch (error) {
      Logger.error(`Fourier scoring failed: ${error}`);
      process.exit(1);
    }
  });

// Query — the consented query surface over QUERYABLE biodata (Phase-1 flagship).
// Run a read-only SELECT server-side against an NFT-gated OpenCRAVAT sqlite,
// addressed by biocid or biosample. Opaque biodata (FASTQ/BAM) is NOT queryable
// and is served by `biofs mount`/`stream` instead.
program
  .command('erase [biosample]')
  .description('GDPR Art.17 erasure — destroy a biosample\'s bytes, registry rows and derived copies (DRY RUN by default)')
  .option('--execute', 'Actually perform the erasure (irreversible; prompts for confirmation)')
  .option('--resume <erasure_id>', 'Resume an interrupted erasure saga')
  .option('--yes', 'Skip the interactive confirmation prompt (use with care)')
  .option('--json', 'JSON output for the dry-run plan')
  .action(async (biosample: string | undefined, options: EraseOptions) => {
    try {
      await eraseCommand(biosample, options);
    } catch (error) {
      Logger.error(`Erase failed: ${error}`);
      process.exit(1);
    }
  });

program
  .command('query <target> [sql]')
  .description('Consent-gated read-only SQL over a queryable-biodata sqlite (biocid or biosample); the sqlite never leaves prod, only rows transit')
  .option('--schema', 'List the tables in the annotated sqlite instead of running a query')
  .option('--format <type>', 'Output format: table | tsv | csv | json (default: table)', 'table')
  .option('--output <path>', 'Write output to a file instead of stdout')
  .option('--row-cap <n>', 'Cap rows returned by the server (default 10000, max 100000)')
  .option('--timeout-ms <n>', 'Server-side query time budget in ms (default 30000)')
  .option('--job-id <timestamp>', 'Pick a specific OC job timestamp when multiple sqlites exist')
  .option('--async', 'Run as a background job (submit-then-poll) for heavy full-table scans that exceed the 60s sync limit')
  .option('--quiet', 'Suppress progress output')
  .action(async (target: string, sql: string | undefined, options: QueryOptions) => {
    try {
      await queryCommand(target, sql, options);
    } catch (error) {
      Logger.error(`Query failed: ${error}`);
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
  .option('--refresh', 'No-op (kept for back-compat; variants now runs server-side, no local cache)')
  .option('--sqlite-uri <gsuri>', 'Deprecated: no longer supported (server-side runs against bioroutes inventory only)')
  .option('--job-id <timestamp>', 'Pick a specific OC job timestamp (e.g. 260411-053533) when multiple sqlites exist')
  .option('--with-acmg', 'Attach ACMG-SVI evidence stack per Section 2.7 to each row (single-tool PP3 + PVS1 + PM2)')
  .option('--limit <n>', 'Cap rows returned by the server (handy for fast probes of a large sqlite)')
  .option('--quiet', 'Suppress progress output')
  .option('--debug', 'Show server resolution debug info')
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

routeCmd
  .command('anchor')
  .description('Instantiate pending bioroutes.inventory rows on Sequentia (BioRoutes registerRoute). Default scope: John.')
  .option('--wallet <address>', 'Owner wallet to anchor (default: John 0x88110B7e…). Admin only for other wallets.')
  .option('--serial <serial>', 'Biosample serial / fingerprint scope')
  .option('--all', 'Anchor every pending row across all wallets (admin)')
  .option('--writes <csv>', 'On-chain writes: route[,bioasset]', 'route')
  .option('--filetypes <csv>', 'Limit to these filetypes (e.g. vcf,bam)')
  .option('--batch <n>', 'Rows registered per request (1-100)', '25')
  .option('--limit <n>', 'Cap total rows this run (0 = no cap)')
  .option('--dry-run', 'Preview eligible rows; no chain writes')
  .option('--json', 'Emit raw JSON output')
  .action(async (options: RouteAnchorOptions) => {
    await routeAnchorCommand(options);
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

// BIODATA_ROOM_20260801: dual-role profiles (patient vault vs known researcher)
const profileCmd = program
  .command('profile')
  .description('Manage dual BioFS profiles (patient vs researcher credential roots)');
profileCmd
  .command('list')
  .description('List local profiles under ~/.biofs/profiles/*')
  .option('--json', 'JSON output')
  .action(async (o: ProfileOptions) => {
    try { await profileListCommand(o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
profileCmd
  .command('use <name>')
  .description('Prepare a named profile; print export BIOFS_PROFILE=... (--print for shell eval)')
  .option('--print', 'Print shell exports only (for eval "$(biofs profile use researcher --print)")')
  .option('--json', 'JSON output')
  .action(async (name: string, o: ProfileOptions) => {
    try { await profileUseCommand(name, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
profileCmd
  .command('status')
  .description('Show active profile, config dir, and wallet')
  .option('--json', 'JSON output')
  .action(async (o: ProfileOptions) => {
    try { await profileStatusCommand(o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });

// BIODATA_ROOM_20260801: investor-style biodata room for researcher deep dives
const roomCmd = program
  .command('room')
  .description('Researcher Biodata Room: create, request, admit, enter, scoped files (via biofs-node)');
roomCmd
  .command('create')
  .description('Owner: create a room over one or more biocid:// assets')
  .requiredOption('--biocids <list>', 'Comma/space-separated biocid:// list')
  .option('--purpose <text>', 'Research purpose shown to the owner', 'research deep dive')
  .option('--skills <list>', 'Allowed verbs (comma-separated)')
  .option('--days <n>', 'TTL days after admit (1-30)', '7')
  .option('--researcher <wallet>', 'Optional pre-assign researcher wallet')
  .option('--json', 'JSON output')
  .option('--quiet', 'Quiet mode')
  .action(async (o: RoomOptions) => {
    try { await roomCreateCommand(o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('request <room_id>')
  .description('Researcher: request admission to a room')
  .option('--purpose <text>', 'Purpose of the deep dive')
  .option('--message <text>', 'Message to the data owner')
  .option('--skills <list>', 'Requested skills')
  .option('--json', 'JSON output')
  .option('--quiet', 'Quiet mode')
  .action(async (roomId: string, o: RoomOptions) => {
    try { await roomRequestCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('status <room_id>')
  .description('Show room status (members see full card)')
  .option('--json', 'JSON output')
  .action(async (roomId: string, o: RoomOptions) => {
    try { await roomStatusCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('admit <room_id>')
  .description('Owner (patient): admit the researcher and open the room')
  .option('--json', 'JSON output')
  .option('--quiet', 'Quiet mode')
  .action(async (roomId: string, o: RoomOptions) => {
    try { await roomAdmitCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('revoke <room_id>')
  .description('Owner or researcher: revoke/leave the room')
  .option('--json', 'JSON output')
  .option('--quiet', 'Quiet mode')
  .action(async (roomId: string, o: RoomOptions) => {
    try { await roomRevokeCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('list')
  .description('List rooms for the active profile wallet')
  .option('--json', 'JSON output')
  .action(async (o: RoomOptions) => {
    try { await roomListCommand(o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('enter <room_id>')
  .description('Enter an OPEN room (sets local active_room.json session)')
  .option('--json', 'JSON output')
  .option('--quiet', 'Quiet mode')
  .action(async (roomId: string, o: RoomOptions) => {
    try { await roomEnterCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('leave')
  .description('Clear the local active room session')
  .option('--json', 'JSON output')
  .action(async (o: RoomOptions) => {
    try { await roomLeaveCommand(o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('files [room_id]')
  .description('List biocids in a room (defaults to active room). No gs:// paths returned.')
  .option('--json', 'JSON output')
  .action(async (roomId: string | undefined, o: RoomOptions) => {
    try { await roomFilesCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });
roomCmd
  .command('signing-url <room_id>')
  .description('Get patient web + Telegram signing links for a room')
  .option('--json', 'JSON output')
  .action(async (roomId: string, o: RoomOptions) => {
    try { await roomSigningUrlCommand(roomId, o); } catch (e) { Logger.error(String(e)); process.exit(1); }
  });

// CONSENT_VERBS_20260730: subject-signed consent for an AI-agent session. Two steps because the
// node cannot sign for the data owner, which is the property that stops consent being
// minted ABOUT a person instead of BY them.
const consentCmd = program
  .command('consent')
  .description('Grant or inspect consent for an AI-agent session (dispatched through biofs-node)');
consentCmd
  .command('payload')
  .description('Build the consent terms the data owner must sign for one MCP session')
  .requiredOption('--session <id>', 'MCP session id (Mcp-Session-Id)')
  .requiredOption('--biocid <biocid>', 'The biocid:// the grant covers')
  .option('--days <n>', 'Validity in days (1-30)', '1')
  .option('--json', 'Emit JSON')
  .option('--quiet', 'Suppress progress')
  .action(async (o: any) => {
    try { await consentPayloadCommand(o.session, o.biocid, o); }
    catch (e) { Logger.error(`consent payload failed: ${e}`); process.exit(1); }
  });
consentCmd
  .command('submit')
  .description('Relay a data-owner-signed consent grant on-chain (the node pays the gas)')
  .requiredOption('--session <id>', 'MCP session id')
  .requiredOption('--message <json>', 'The signed grant message, inline JSON or a path')
  .requiredOption('--signature <sig>', 'EIP-712 signature by the data owner')
  .option('--json', 'Emit JSON')
  .option('--quiet', 'Suppress progress')
  .action(async (o: any) => {
    try { await consentSubmitCommand(o.session, o.message, o.signature, o); }
    catch (e) { Logger.error(`consent submit failed: ${e}`); process.exit(1); }
  });

// FLUENCY_LINEAGE_VERBS_20260730: make a genomics store AI-conversable, and report the metamorphosis.
// Registered with the other groups, BEFORE the welcome banner and program.parse().
const fluencyCmd = program
  .command('fluency')
  .description('Make a genomics store AI-conversable: precompute per-contig coverage + per-gene rollups (dispatched through biofs-node)');
fluencyCmd
  .command('build <biocid>')
  .description('Build (or adopt) the fluency artifact. Idempotent; the derivative is registered to the data owner with parent lineage')
  .option('--json', 'Emit JSON')
  .option('--quiet', 'Suppress progress')
  .action(async (biocid: string, options: { json?: boolean; quiet?: boolean }) => {
    try { await fluencyBuildCommand(biocid, options); } catch (error) { Logger.error(`fluency build failed: ${error}`); process.exit(1); }
  });
fluencyCmd
  .command('state <biocid>')
  .description('Report whether a store is fluent (fresh / building / absent) and what it covers')
  .option('--json', 'Emit JSON')
  .option('--quiet', 'Suppress progress')
  .action(async (biocid: string, options: { json?: boolean; quiet?: boolean }) => {
    try { await fluencyStateCommand(biocid, options); } catch (error) { Logger.error(`fluency state failed: ${error}`); process.exit(1); }
  });

program
  .command('lineage <biocid>')
  .description('Report the biodata metamorphosis: what this was derived from, what came from it, who owns each piece, and what erases with what')
  .option('--json', 'Emit JSON')
  .option('--quiet', 'Suppress progress')
  .action(async (biocid: string, options: { json?: boolean; quiet?: boolean }) => {
    try { await lineageCommand(biocid, options); } catch (error) { Logger.error(`lineage failed: ${error}`); process.exit(1); }
  });

// Show welcome message if no command
if (process.argv.length === 2) {
  console.log(chalk.cyan('\n╔═════════════════════════════════════════════╗'));
  console.log(chalk.cyan(`║  BioFS CLI v${String(BIOFS_VERSION).padEnd(31)}║`));
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
  console.log(`  ${chalk.green('profile')}     - Dual profiles (patient vs researcher credentials)`);
  console.log(`  ${chalk.green('room')}        - Researcher Biodata Room (admit + scoped deep dive)`);
  console.log(`  ${chalk.green('fluency')}     - Make a store AI-conversable (coverage + per-gene rollups)`);
  console.log(`  ${chalk.green('lineage')}     - Biodata metamorphosis: parents, derivatives, owners`);
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

// Note: the authoritative unhandledRejection/uncaughtException handlers are
// registered once near the top of this file (they route through reportAndExit
// for a crash report). A second unhandledRejection listener here would also fire
// and could process.exit(1) before that async report is sent, so it was removed.

process.on('SIGINT', () => {
  console.log('\n\nInterrupted. Goodbye!');
  process.exit(0);
});

