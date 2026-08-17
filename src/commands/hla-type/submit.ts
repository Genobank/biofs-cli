/**
 * biofs hla-type submit <biosample_serial>
 *
 * Queue server-side arcasHLA on the case RNA BAM. Does not pull BAM bytes
 * to the laptop. Optional confirmation when a map already carries arcasHLA.
 */
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import { BioFilesCacheManager } from '../../lib/storage/biofiles-cache';
import { fileMatchesTypeFilter } from '../../lib/biofiles/filetype';
import { BioCIDParser } from '../../lib/biofiles/biocid';

const BIOFS_NODE_BASE = process.env.BIOFS_NODE_URL
  || `${process.env.GENOBANK_API_URL || 'https://genobank.app'}/api_biofs_node`;

export interface HlaTypeOptions {
  rnaBiocid?: string;
  wait?: boolean;
  json?: boolean;
}

export async function hlaTypeSubmitCommand(
  serial: string,
  options: HlaTypeOptions = {},
): Promise<void> {
  const spinner = options.json ? null : ora(`hla-type submit ${serial}`).start();
  const credentials = await getCredentials();
  if (!credentials) {
    spinner?.fail('Not authenticated. Run: biofs login');
    process.exit(1);
  }
  let rnaBiocid = options.rnaBiocid;
  if (!rnaBiocid) {
    const cache = new BioFilesCacheManager().getAll(credentials.wallet_address);
    const hit = cache.find((f) => {
      const name = f.filename || '';
      const biocid = f.locations.biocid || '';
      return (
        name.includes(serial) &&
        /rna/i.test(name + biocid) &&
        fileMatchesTypeFilter('bam', { type: f.metadata.file_type, filename: name, biocid })
      );
    });
    rnaBiocid = hit?.locations.biocid;
    if (rnaBiocid && BioCIDParser.parse(rnaBiocid)) {
      rnaBiocid = BioCIDParser.parse(rnaBiocid)!.fullCID;
    }
  }
  if (!rnaBiocid) {
    spinner?.fail('No RNA BAM biocid. Pass --rna-biocid biocid://lab/wallet/bam/<file>.bam');
    process.exit(1);
  }
  const body = {
    biosample_serial: serial,
    wallet: credentials.wallet_address,
    signature: credentials.user_signature,
    rna_biocid: rnaBiocid,
  };
  const r = await axios.post(`${BIOFS_NODE_BASE}/hla-type`, body, {
    timeout: 60_000,
    validateStatus: (s) => s < 500,
  });
  if (r.status >= 400) {
    spinner?.fail(`hla-type ${r.status}: ${r.data?.error || 'unknown'}`);
    if (options.json) console.log(JSON.stringify(r.data, null, 2));
    process.exit(1);
  }
  spinner?.succeed(`hla_job_id=${r.data.hla_job_id} status=${r.data.status}`);
  if (options.json) console.log(JSON.stringify(r.data, null, 2));
  else if (r.data.note) console.log(chalk.gray('  ' + r.data.note));
}
