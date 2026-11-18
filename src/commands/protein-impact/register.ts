/**
 * Commander wiring for `biofs protein-impact`. Kept out of index.ts so the verb is one import and one call.
 */

import { Command } from 'commander';
import { Logger } from '../../lib/utils/logger';
import { proteinImpactExecCommand, ProteinImpactExecOptions } from './exec';
import {
  ApplyOptions, FetchOptions, GateSignOptions, ProbeOptions, ResultsOptions, ValidateOptions,
  applyCommand, fetchCommand, gateSignCommand, probeCommand, resultsCommand, validateCommand,
} from './submit';

const collect = (v: string, prev: string[]) => [...(prev || []), v];

export function registerProteinImpact(program: Command): void {
  const cmd = program
    .command('protein-impact')
    .description('Protein-level impact of KNOWN missense substitutions in ITGA2B and ITGB3 (research-grade analysis; it cannot design anything)');

  cmd
    .command('fetch')
    .description('Fetch and pin the UniProt reference sequences (public data only)')
    .option('--genes <csv>', 'Genes to fetch', 'ITGA2B,ITGB3')
    .option('--json', 'Output as JSON')
    .action(async (options: FetchOptions) => {
      try { await fetchCommand(options); } catch (error) { Logger.error(`protein-impact fetch failed: ${error}`); process.exit(1); }
    });

  cmd
    .command('validate')
    .description('Score the public benchmark (known pathogenic and benign missense changes) and write the gate document; public data only')
    .option('--genes <csv>', 'Genes to validate', 'ITGA2B,ITGB3')
    .option('--layers <csv>', 'Scoring layers to rank: plm (more with structure)', 'plm')
    .option('--estimate', 'Print the price and the estimate id, and submit nothing')
    .option('--approve <estimate_id>', 'Estimate id printed by --estimate (GPU layers only)')
    .option('--max-usd <n>', 'Most you approve to spend on this job (GPU layers only)')
    .option('--json', 'Output as JSON')
    .action(async (options: ValidateOptions) => {
      try { await validateCommand(options); } catch (error) { Logger.error(`protein-impact validate failed: ${error}`); process.exit(1); }
    });

  cmd
    .command('apply <serial>')
    .description('Score variants a sample carries. Needs a passing, signed gate; GPU layers need --approve after --estimate')
    .option('--variant <hgvs>', 'Variant as GENE:p.Leu225Arg (repeat for several)', collect, [] as string[])
    .option('--source <biocid>', 'Biocid the variants were read from (repeat for several)', collect, [] as string[])
    .requiredOption('--gate-file <path>', 'Signed gate document (from `gate-sign`)')
    .option('--layers <csv>', 'Layers to run: fetch,features,plm,structure,complex,probe,md', 'features')
    .option('--estimate', 'Print the price and the estimate id, and submit nothing')
    .option('--approve <estimate_id>', 'Estimate id printed by --estimate (GPU layers)')
    .option('--max-usd <n>', 'Most you approve to spend on this job (GPU layers)')
    .option('--diagnosis-assumption <text>', 'Recorded in the manifest, e.g. GT/ITGA2B')
    .option('--json', 'Output as JSON')
    .action(async (serial: string, options: ApplyOptions) => {
      try { await applyCommand(serial, options); } catch (error) { Logger.error(`protein-impact apply failed: ${error}`); process.exit(1); }
    });

  cmd
    .command('probe')
    .description('Measure peak GPU memory of the full ITGA2B plus ITGB3 complex on the wild-type sequences (public data only; GPU)')
    .option('--genes <csv>', 'Genes in the complex', 'ITGA2B,ITGB3')
    .option('--estimate', 'Print the price and the estimate id, and submit nothing')
    .option('--approve <estimate_id>', 'Estimate id printed by --estimate')
    .option('--max-usd <n>', 'Most you approve to spend on this job')
    .option('--json', 'Output as JSON')
    .action(async (options: ProbeOptions) => {
      try { await probeCommand(options); } catch (error) { Logger.error(`protein-impact probe failed: ${error}`); process.exit(1); }
    });

  cmd
    .command('gate-sign <file>')
    .description('Review a passing gate document and sign it as the operator (writes <file>.signed.json and prints its gate id)')
    .option('--yes', 'Sign after reviewing the numbers')
    .option('--out <path>', 'Where to write the signed document')
    .action(async (file: string, options: GateSignOptions) => {
      try { await gateSignCommand(file, options); } catch (error) { Logger.error(`protein-impact gate-sign failed: ${error}`); process.exit(1); }
    });

  cmd
    .command('results <jobId>')
    .description('Fetch the manifest of a finished job, then file it with `biofs register-derived`')
    .option('--out <path>', 'Where to save the manifest')
    .option('--json', 'Output as JSON')
    .action(async (jobId: string, options: ResultsOptions) => {
      try { await resultsCommand(jobId, options); } catch (error) { Logger.error(`protein-impact results failed: ${error}`); process.exit(1); }
    });

  cmd
    .command('exec')
    .description('VM-side executor (spawned by biofs-node): re-checks guard, approval and gate, runs the stages, writes the manifest')
    .option('--sample <serial>', 'Biosample serial (public for public modes)')
    .option('--ref <ref>', 'Reference (accepted for the spawner, unused)')
    .option('--job-id <id>', 'Job id')
    .option('--batch-id <id>', 'Batch id')
    .option('--creator <wallet>', 'Creator wallet (lowercased for the GCS path)')
    .option('--out-bucket <name>', 'Output bucket', 'genobank-parabricks-output')
    .option('--ref-bucket <name>', 'Reference bucket', 'genobank-references')
    .option('--request-b64 <b64>', 'The request JSON, base64')
    .option('--request-file <path>', 'The request JSON file')
    .option('--gate-b64 <b64>', 'The gate document JSON, base64 (apply)')
    .option('--gate-file <path>', 'The gate document JSON file (apply)')
    .option('--work-dir <path>', 'Scratch directory')
    .option('--local-root <path>', 'Dry run: map gs:// paths into this local directory')
    .action(async (options: ProteinImpactExecOptions) => {
      try { await proteinImpactExecCommand(options); } catch (error) { Logger.error(`protein-impact exec failed: ${error}`); process.exit(1); }
    });
}
