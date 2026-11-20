/**
 * biofs bamprep submit|status: coordinate-sort (only when the header says the BAM is not sorted) and index one BAM you own (biofs-node kind bamprep, 20 November 2026).
 *
 * The source is only read. A sorted copy and/or the index are new registered files with the source as their parent; flagstat before and after must be equal in every category
 * and the index's own record count equal to the file's, or the job fails. biofs-node's region read finds the index by that lineage. Worker only.
 */
import { Logger } from '../../lib/utils/logger';
import { submitKindCommand, ownerOr, parseSha256, requireBiocid } from '../neoantigen-pipeline';

export const BAMPREP_SORT_MODES = ['auto', 'never', 'always'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

export interface BamprepOptions {
  bam: string;
  sort?: string;
  threads?: string;
  name?: string;
  codeSha256: string;
  owner?: string;
  wait?: boolean;
  json?: boolean;
}

export function buildBamprepBody(caseId: string, o: BamprepOptions, wallet: string, signature: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const sort = o.sort === undefined ? 'auto' : String(o.sort);
  if (!BAMPREP_SORT_MODES.includes(sort)) throw new Error(`--sort must be one of ${BAMPREP_SORT_MODES.join(', ')}`);
  const threads = o.threads === undefined ? 4 : Number(o.threads);
  if (!Number.isInteger(threads) || threads < 1 || threads > 16) throw new Error('--threads must be an integer from 1 to 16');
  if (o.name !== undefined && !NAME_RE.test(o.name)) throw new Error('--name must be letters, digits and . _ - (the output file name)');
  const body: Record<string, unknown> = {
    wallet: ownerOr(o.owner, wallet), signature, case_id: caseId,
    bam_biocid: requireBiocid('--bam', o.bam), sort, threads,
    code_sha256: parseSha256('--code-sha256', o.codeSha256), executor: 'worker',
  };
  if (o.name !== undefined) body.name = o.name;
  return body;
}

export async function bamprepSubmitCommand(caseId: string, options: BamprepOptions): Promise<void> {
  try {
    await submitKindCommand('bamprep', (wallet, signature) => buildBamprepBody(caseId, options, wallet, signature), options);
  } catch (e: any) {
    Logger.error(`bamprep submit failed: ${e.message}`);
    process.exit(1);
  }
}
