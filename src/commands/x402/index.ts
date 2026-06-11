import { Command } from 'commander';
import { createPayCommand } from './pay';
import { createListServicesCommand } from './list-services';
import { x402SubmitCommand } from './submit';
import { pipelineCancerTwinCommand } from './pipeline-cancer-twin';
import { x402VerifyPaymentCommand } from './verify-payment';
import { Logger } from '../../lib/utils/logger';

/**
 * x402 command group — Sequentia HTTP-native micropayments for genomic agents.
 *
 *   biofs x402 list-services
 *   biofs x402 pay --service …
 *   biofs x402 submit --agent clara --biosample TN25-336147 [--dry-run]
 *   biofs x402 pipeline cancer-twin TN25-336147 [--from fastq] [--dry-run] [--wait]
 */
export function createX402Command(): Command {
  const command = new Command('x402')
    .description('x402 micropayment + agentic pipelines on Sequentia (ERC-8004 agents)')
    .addCommand(createPayCommand())
    .addCommand(createListServicesCommand())
    .addCommand(createX402SubmitCommand())
    .addCommand(createX402VerifyPaymentCommand())
    .addCommand(createX402PipelineCommand());

  return command;
}

/** biofs x402 verify-payment — owner/oracle confirms ERC-8004 payment proofs. */
function createX402VerifyPaymentCommand(): Command {
  return new Command('verify-payment')
    .description('Owner-verify ERC-8004 payment proofs on BioAgentRegistry (credits agent spend)')
    .argument('[paymentIds...]', 'Payment id(s) to verify')
    .option('--all', 'Verify every unverified payment proof')
    .option('--dry-run', 'Preview without broadcasting (no owner key needed)')
    .option('--json', 'Emit JSON')
    .action(async (paymentIds: string[], options) => {
      try {
        await x402VerifyPaymentCommand(paymentIds, options);
      } catch (error: any) {
        Logger.error(`x402 verify-payment failed: ${error?.message || error}`);
        process.exit(1);
      }
    });
}

/** biofs x402 submit — pay one ERC-8004 agent and dispatch its job. */
function createX402SubmitCommand(): Command {
  return new Command('submit')
    .description('Pay an ERC-8004 agent in seqUSDC and dispatch its job (x402 single step)')
    .requiredOption('-a, --agent <name>', 'Agent: clara | opencravat | genoclaw')
    .requiredOption('-b, --biosample <serial>', 'Biosample serial to process')
    .option('--amount <usdc>', 'Override the agent price (seqUSDC)')
    .option('--input-biocid <biocid>', 'Explicit input BioCID for the payment asset id')
    .option('--package <pkg>', 'Forwarded package (e.g. wes_default, cancer_twin)')
    .option('--no-dispatch', 'Settle payment + record proof only; do not call the job endpoint')
    .option('--native', 'Settle in native Sequentia token instead of seqUSDC')
    .option('--dry-run', 'Simulate the full x402 flow (no chain, gas, or live node)')
    .option('--json', 'Emit JSON')
    .action(async (options) => {
      try {
        await x402SubmitCommand(options);
      } catch (error: any) {
        Logger.error(`x402 submit failed: ${error?.message || error}`);
        process.exit(1);
      }
    });
}

/** biofs x402 pipeline cancer-twin — full 3-agent agentic pipeline. */
function createX402PipelineCommand(): Command {
  const pipeline = new Command('pipeline')
    .description('x402 agentic pipelines (multi-agent, paid, traceable on Sequentia)');

  pipeline
    .command('cancer-twin <biosample_serial>')
    .description('Run the full Cancer Digital Twin pipeline (Clara → OpenCRAVAT → GenoClaw), x402-paid & Sequentia-traceable')
    .option('--from <type>', 'Input type: fastq | vcf | sqlite (drives smart routing)', 'vcf')
    .option('--start <stage>', 'Explicit start stage: clara | opencravat | genoclaw')
    .option('--owner <wallet>', 'Patient/owner wallet (defaults to logged-in wallet)')
    .option('--case-id <id>', 'BioContext case id (defaults to biosample serial)')
    .option('--package <pkg>', 'Interpretation package', 'cancer_twin')
    .option('--native', 'Settle each x402 stage in native Sequentia token instead of seqUSDC')
    .option('--dry-run', 'Simulate the full pipeline deterministically (no chain/compute)')
    .option('--wait', 'Wait for each agent job to complete before proceeding')
    .option('--json', 'Emit raw JSON-line events + final manifest')
    .action(async (biosampleSerial: string, options) => {
      try {
        const rc = await pipelineCancerTwinCommand(biosampleSerial, options);
        process.exit(rc);
      } catch (error: any) {
        Logger.error(`cancer-twin pipeline failed: ${error?.message || error}`);
        process.exit(1);
      }
    });

  return pipeline;
}

export default createX402Command;
