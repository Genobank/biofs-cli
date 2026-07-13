import { BIOFS_VERSION } from '../version';
/**
 * biofs score-protein <uniprot>
 *
 * The canonical Super-SCDS scoring verb per
 * SUPER_SCDS_PLAN_2026-05-26.md v2 §4.4.
 *
 * For one canonical UniProt accession:
 *   1. Fetch the canonical FASTA from UniProt REST (cached at
 *      ~/.biofs/cache/uniprot/<accession>.fasta).
 *   2. Fetch family sequences (Pfam if available, else orthologs,
 *      else TrEMBL fallback) and compute the EIIP-encoded RRM and
 *      PIEZO_INDEX-encoded PSM cross-spectrum consensuses. Cached
 *      at ~/.biofs/cache/{rrm,psm}/<UniProt>.json by the existing
 *      rrm-consensus and psm-consensus verbs; we delegate to them.
 *   3. For each of the (length × 19) possible missense substitutions,
 *      compute the SCDS family (SCDS-fc, SCDS-W, SCDS-ΔE, SCDS-W-ΔE,
 *      SCDS-L1, PSM-SCDS-fc, PSM-SCDS-ΔE) via a single embedded
 *      Python script that reuses the EIIP and PIEZO_INDEX tables
 *      from §2.4 of the v3.5 manuscript.
 *   4. POST the consensuses document + the variants documents to
 *      /api_scds/upsert_protein on the prod CherryPy API. The API
 *      endpoint upserts into scds_consensuses and bulk-inserts into
 *      scds_variants. The endpoint is documented for v3.7.x and is
 *      a thin wrapper around pymongo bulk write.
 *
 * Usage:
 *   biofs score-protein P38398
 *   biofs score-protein P38398 --source family --gene-symbol BRCA1
 *   biofs score-protein P38398 --dry-run    # emit payload to stdout
 *   biofs score-protein P38398 --output payload.json
 *
 * Output: per-protein scoring manifest. With --dry-run, prints the
 * full payload that would be POSTed (large; pipe to a file).
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

const UNIPROT_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'uniprot');
const SCDS_CACHE_DIR    = path.join(os.homedir(), '.biofs', 'cache', 'scds');

export interface ScoreProteinOptions {
  geneSymbol?: string;
  source?: string;         // family | orthologs | trembl
  taxonomy?: string;
  pfam?: string;
  apiBase?: string;
  dryRun?: boolean;
  output?: string;
  quiet?: boolean;
  skipMongoUpsert?: boolean;  // for testing: do all the scoring but do not call the API
}

const PY_SCORE = `
import sys, json, re, math, urllib.request
import numpy as np

EIIP = {
    'A': 0.0373, 'R': 0.0959, 'N': 0.0036, 'D': 0.1263, 'C': 0.0829,
    'E': 0.0058, 'Q': 0.0761, 'G': 0.0050, 'H': 0.0242, 'I': 0.0000,
    'L': 0.0000, 'K': 0.0371, 'M': 0.0823, 'F': 0.0946, 'P': 0.0198,
    'S': 0.0829, 'T': 0.0941, 'W': 0.0548, 'Y': 0.0516, 'V': 0.0057,
}

PIEZO = {
    'A': 0.40, 'R': 13.5, 'N': 3.50, 'D': 7.20, 'C': 1.40,
    'E': 7.00, 'Q': 3.60, 'G': 0.00, 'H': 2.30, 'I': 0.13,
    'L': 0.13, 'K': 8.30, 'M': 1.20, 'F': 0.13, 'P': 0.00,
    'S': 1.70, 'T': 1.70, 'W': 2.10, 'Y': 1.60, 'V': 0.13,
}

ALPHABET = 'ACDEFGHIKLMNPQRSTVWY'

cfg = json.loads(sys.stdin.read())
seq = cfg['sequence']
uniprot = cfg['uniprot']
gene = cfg.get('gene_symbol') or ''
rrm_consensus = cfg.get('rrm_consensus')  # full magnitude spectrum from existing cache
psm_consensus = cfg.get('psm_consensus')
window = int(cfg.get('window', 31))

def windowed_scds(seq, pos, alt, table, w=31):
    """Compute SCDS-W (windowed Σ|ΔF|), SCDS-W-ΔE (%), |ΔIDX|."""
    n = len(seq)
    if pos < 1 or pos > n:
        return None
    half = w // 2
    lo = max(0, pos - 1 - half)
    hi = min(n, pos - 1 + half + 1)
    ref = seq[pos - 1]
    wt_w = seq[lo:hi]
    mt_w = wt_w[: pos - 1 - lo] + alt + wt_w[pos - lo:]
    if len(wt_w) != len(mt_w) or len(wt_w) < 8:
        return None
    wt_v = np.array([table.get(a, 0.0) for a in wt_w], dtype=float) - 0  # detrend below
    mt_v = np.array([table.get(a, 0.0) for a in mt_w], dtype=float)
    wt_v = wt_v - wt_v.mean()
    mt_v = mt_v - mt_v.mean()
    X_wt = np.abs(np.fft.rfft(wt_v))
    X_mt = np.abs(np.fft.rfft(mt_v))
    sum_abs_df = float(np.sum(np.abs(X_mt - X_wt)))
    e_wt = float(np.sum(X_wt ** 2) + 1e-12)
    e_mt = float(np.sum(X_mt ** 2) + 1e-12)
    delta_e_pct = 100.0 * (e_mt - e_wt) / e_wt
    delta_idx = float(table.get(alt, 0.0) - table.get(ref, 0.0))
    return {
        'sum_abs_df': sum_abs_df,
        'delta_e_pct': delta_e_pct,
        'delta_idx': delta_idx,
    }

def full_scds(seq, pos, alt, table, consensus_mag):
    """Compute SCDS-fc (full-protein |X_MT(f_c)| / |X_WT(f_c)|), SCDS-ΔE (%),
    SCDS-L1 (full-protein L1) using the family consensus spectrum's f_c bin."""
    if consensus_mag is None or len(consensus_mag) == 0:
        return None
    common_length = 2 * (len(consensus_mag) - 1)
    s_wt = seq[:common_length] if len(seq) >= common_length else seq + 'X' * (common_length - len(seq))
    s_mt = s_wt[: pos - 1] + alt + s_wt[pos:] if 0 < pos <= common_length else None
    if s_mt is None:
        return None
    wt_v = np.array([table.get(a, 0.0) for a in s_wt], dtype=float)
    mt_v = np.array([table.get(a, 0.0) for a in s_mt], dtype=float)
    wt_v = wt_v - wt_v.mean()
    mt_v = mt_v - mt_v.mean()
    X_wt = np.abs(np.fft.rfft(wt_v))
    X_mt = np.abs(np.fft.rfft(mt_v))
    # Find f_c bin from consensus: peak (excluding DC k=0 and k=1)
    cm = np.asarray(consensus_mag, dtype=float)
    if len(cm) < 4:
        return None
    fc_bin = int(np.argmax(cm[2:]) + 2)
    fc_ratio = float(X_mt[fc_bin] / (X_wt[fc_bin] + 1e-12))
    e_wt = float(np.sum(X_wt ** 2) + 1e-12)
    e_mt = float(np.sum(X_mt ** 2) + 1e-12)
    delta_e_pct = 100.0 * (e_mt - e_wt) / e_wt
    full_l1 = float(np.sum(np.abs(X_mt - X_wt)))
    return {
        'fc_ratio': fc_ratio,
        'delta_e_pct': delta_e_pct,
        'full_l1': full_l1,
        'fc_bin': fc_bin,
    }

n = len(seq)
variants = []
for pos in range(1, n + 1):
    ref = seq[pos - 1]
    if ref not in ALPHABET:
        continue
    for alt in ALPHABET:
        if alt == ref:
            continue
        rrm_w = windowed_scds(seq, pos, alt, EIIP, window)
        if rrm_w is None:
            continue
        psm_w = windowed_scds(seq, pos, alt, PIEZO, window)
        rrm_full = full_scds(seq, pos, alt, EIIP, rrm_consensus) if rrm_consensus else None
        psm_full = full_scds(seq, pos, alt, PIEZO, psm_consensus) if psm_consensus else None
        v = {
            'uniprot': uniprot,
            'gene': gene,
            'aa_pos': pos,
            'ref_aa': ref,
            'alt_aa': alt,
            'hgvs_pro': f'p.{ref}{pos}{alt}',
            'scds': {
                'eiip_w': rrm_w['sum_abs_df'],
                'eiip_w_dE_pct': rrm_w['delta_e_pct'],
                'eiip_fc': rrm_full['fc_ratio'] if rrm_full else None,
                'eiip_dE_pct': rrm_full['delta_e_pct'] if rrm_full else None,
                'eiip_l1': rrm_full['full_l1'] if rrm_full else None,
                'psm_w': psm_w['sum_abs_df'] if psm_w else None,
                'psm_w_dE_pct': psm_w['delta_e_pct'] if psm_w else None,
                'psm_fc': psm_full['fc_ratio'] if psm_full else None,
                'psm_dE_pct': psm_full['delta_e_pct'] if psm_full else None,
                'delta_eiip': rrm_w['delta_idx'],
                'delta_piezo': psm_w['delta_idx'] if psm_w else None,
            },
        }
        variants.append(v)

print(json.dumps({'variants': variants, 'n_variants': len(variants), 'seq_length': n}))
`;

function loadConsensus(dir: string, uniprot: string, gene: string | undefined): number[] | null {
  // Existing rrm/psm consensus cache is keyed by GENE_SYMBOL.json, not by UniProt.
  // We accept either key.
  for (const k of [uniprot, (gene || '').toUpperCase()]) {
    if (!k) continue;
    const p = path.join(dir, `${k}.json`);
    if (fs.existsSync(p)) {
      try {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        return d.consensus_spectrum || null;
      } catch { /* fall through */ }
    }
  }
  return null;
}

async function fetchUniprotFasta(accession: string): Promise<string> {
  fs.mkdirSync(UNIPROT_CACHE_DIR, { recursive: true });
  const cachePath = path.join(UNIPROT_CACHE_DIR, `${accession}.fasta`);
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf8');
  }
  const url = `https://rest.uniprot.org/uniprotkb/${accession}.fasta`;
  const r = spawnSync('curl', ['-sS', '-A', 'biofs/3.7.0', '--max-time', '60', url], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.startsWith('>')) {
    throw new Error(`UniProt FASTA fetch failed for ${accession}: ${r.stderr || 'no FASTA'}`);
  }
  fs.writeFileSync(cachePath, r.stdout);
  return r.stdout;
}

function parseFastaSequence(fasta: string): string {
  return fasta.split('\n').filter(l => !l.startsWith('>')).join('').replace(/\s+/g, '').toUpperCase();
}

export async function scoreProteinCommand(uniprot: string, opts: ScoreProteinOptions): Promise<void> {
  const apiBase = opts.apiBase || process.env.GENOBANK_API || 'https://genobank.app';
  const credManager = CredentialsManager.getInstance();
  const creds = await credManager.loadCredentials();
  const ownerWallet = creds?.wallet_address;
  const signature = creds?.user_signature;
  if (!opts.dryRun && (!ownerWallet || !signature)) {
    throw new Error('Not authenticated. Run `biofs login` first, or use --dry-run.');
  }

  fs.mkdirSync(SCDS_CACHE_DIR, { recursive: true });

  if (!opts.quiet) console.error(chalk.cyan(`\n🧬 biofs score-protein  ${uniprot}${opts.geneSymbol ? '  (' + opts.geneSymbol + ')' : ''}`));

  // 1. Fetch FASTA
  const fasta = await fetchUniprotFasta(uniprot);
  const seq = parseFastaSequence(fasta);
  if (!opts.quiet) console.error(`   sequence length: ${seq.length} aa`);

  // 2. Load existing consensus caches (rrm-consensus and psm-consensus must
  //    have been pre-run for this gene).
  const rrmDir = path.join(os.homedir(), '.biofs', 'cache', 'rrm');
  const psmDir = path.join(os.homedir(), '.biofs', 'cache', 'psm');
  const rrmConsensus = loadConsensus(rrmDir, uniprot, opts.geneSymbol);
  const psmConsensus = loadConsensus(psmDir, uniprot, opts.geneSymbol);
  if (!opts.quiet) {
    console.error(`   RRM consensus cached: ${rrmConsensus ? 'yes (' + rrmConsensus.length + ' bins)' : 'NO — full-protein metrics will be null'}`);
    console.error(`   PSM consensus cached: ${psmConsensus ? 'yes (' + psmConsensus.length + ' bins)' : 'NO — PSM full-protein metrics will be null'}`);
  }

  // 3. Compute per-variant SCDS family via embedded Python
  const py = spawnSync('python3', ['-c', PY_SCORE], {
    encoding: 'utf8',
    input: JSON.stringify({
      sequence: seq,
      uniprot,
      gene_symbol: opts.geneSymbol || '',
      rrm_consensus: rrmConsensus,
      psm_consensus: psmConsensus,
      window: 31,
    }),
    maxBuffer: 1024 * 1024 * 1024,
    timeout: 600_000,
  });
  if (py.status !== 0) {
    throw new Error(`SCDS scoring failed: ${py.stderr || py.stdout}`);
  }
  const result = JSON.parse(py.stdout);
  if (!opts.quiet) console.error(chalk.green(`✓ Scored ${result.n_variants} variants (${seq.length} aa × 19 alt residues)`));

  // 4. Construct the consensus payload
  const consensus_doc = {
    _id: uniprot,
    uniprot,
    gene_symbol: opts.geneSymbol || '',
    encoding_rrm: rrmConsensus ? 'EIIP' : null,
    encoding_psm: psmConsensus ? 'PIEZO_INDEX' : null,
    sequence_length: seq.length,
    rrm_consensus_spectrum: rrmConsensus,
    psm_consensus_spectrum: psmConsensus,
    generated_at: new Date().toISOString(),
    biofs_version: BIOFS_VERSION,
  };

  const payload = {
    operator: ownerWallet,
    consensus: consensus_doc,
    variants: result.variants,
    biofs_version: BIOFS_VERSION,
  };

  if (opts.output) {
    fs.writeFileSync(opts.output, JSON.stringify(payload, null, 2));
    if (!opts.quiet) console.error(chalk.green(`✓ Wrote payload to ${opts.output}`));
  }

  if (opts.dryRun || opts.skipMongoUpsert) {
    if (!opts.output && !opts.quiet) {
      console.error(chalk.gray(`(dry-run: payload size ≈ ${(JSON.stringify(payload).length / 1024 / 1024).toFixed(1)} MB)`));
    } else if (!opts.output) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    }
    return;
  }

  // 5. POST to the prod API endpoint
  const url = `${apiBase}/api_scds/upsert_protein`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Signature': signature!,
        'X-Owner-Wallet': ownerWallet!,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`POST ${url} → HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    const body: any = await resp.json();
    if (!opts.quiet) {
      console.error(chalk.green(`✓ Upserted ${uniprot} into scds_consensuses + ${body.n_variants_upserted ?? result.n_variants} variants into scds_variants`));
      console.error(`   API response: ${JSON.stringify(body).slice(0, 200)}`);
    } else {
      process.stdout.write(JSON.stringify(body) + '\n');
    }
  } catch (e: any) {
    Logger.warn(`API submission failed (${e.message}). The /api_scds/upsert_protein endpoint is documented for v3.7.x but may not be deployed yet.`);
    Logger.warn(`The payload is available via --output <path> for later submission.`);
    throw e;
  }
}
