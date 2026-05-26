/**
 * biofs wavelet-consensus <gene>
 *
 * Continuous-wavelet replacement for `rrm-consensus`. Computes a 2-D
 * (position by scale) magnitude map of a protein family's EIIP-encoded
 * primary sequence using the complex Morlet wavelet, then derives a
 * consensus across the family by log-domain product. The result is a
 * spatial-spectral localization of where, along the residue axis, the
 * family resonates and at what scale (in amino-acid period units).
 *
 * Rationale (response to the v1 paper auditor's third upgrade point).
 * The 1-D Fourier transform measures global periodicity and smears the
 * energy of a single point mutation across all bins. The windowed Fourier
 * we used in §2.4 of the v1 manuscript localizes within a fixed W = 31
 * residue window but uses a single scale. The continuous Morlet wavelet
 * resolves position and scale jointly, which is the correct primitive for
 * cohort-scale variant scoring at multiple structural scales (alpha helix
 * pitch 3.6 aa, beta strand 2 aa, beta turn 4 aa, domain spacing tens to
 * hundreds of aa).
 *
 * Output: cached JSON at ~/.biofs/cache/wavelet/<gene>.json containing the
 * consensus 2-D magnitude map (sub-sampled to keep file size bounded), the
 * dominant peak (position, scale), the family's characteristic scale, and
 * the per-position aggregate magnitude profile for downstream
 * `biofs wavelet-score` per-variant disruption scoring.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';

import { GENE_TO_PFAM, GENE_TO_UNIPROT } from '../lib/gene-map';

const WAVELET_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'wavelet');

export interface WaveletConsensusOptions {
  source?: string;
  taxonomy?: string;
  reviewed?: boolean;
  max?: string;
  refresh?: boolean;
  quiet?: boolean;
  uniprot?: string;
  pfam?: string;
  encoding?: string;     // 'eiip' (default) or 'piezo'
  scales?: string;       // comma-separated, default '2,3,4,6,8,12,16,24,32,48,64,96'
}

interface PeakInfo {
  position: number;
  scale_bin: number;
  scale_aa: number;
  magnitude: number;
}

export interface WaveletConsensusResult {
  gene: string;
  uniprot: string;
  source: 'family' | 'orthologs';
  pfam?: string;
  taxonomy: string;
  encoding: string;
  n_sequences: number;
  common_length: number;
  scales_aa: number[];
  consensus_magnitude_subsampled?: number[][];     // saved to disk
  position_aggregate_profile?: number[];           // sum over scales per position
  scale_aggregate_profile?: number[];              // sum over positions per scale
  dominant_peaks: PeakInfo[];
  characteristic_scale_bin: number;
  characteristic_scale_aa: number;
  background_mean: number;
  background_std: number;
  signal_to_noise_ratio: number;
  generated_at: string;
  uniprot_ids: string[];
}

const EIIP_PY_LITERAL = `{
    'A': 0.0373, 'R': 0.0959, 'N': 0.0036, 'D': 0.1263, 'C': 0.0829,
    'E': 0.0058, 'Q': 0.0761, 'G': 0.0050, 'H': 0.0242, 'I': 0.0000,
    'L': 0.0000, 'K': 0.0371, 'M': 0.0823, 'F': 0.0946, 'P': 0.0198,
    'S': 0.0829, 'T': 0.0941, 'W': 0.0548, 'Y': 0.0516, 'V': 0.0057,
}`;

const PIEZO_PY_LITERAL = `{
    'A': 0.40,  'R': 13.5,  'N': 3.50,  'D': 7.20,  'C': 1.40,
    'E': 7.00,  'Q': 3.60,  'G': 0.00,  'H': 2.30,  'I': 0.13,
    'L': 0.13,  'K': 8.30,  'M': 1.20,  'F': 0.13,  'P': 0.00,
    'S': 1.70,  'T': 1.70,  'W': 2.10,  'Y': 1.60,  'V': 0.13,
}`;

function buildPyConsensus(encoding: 'eiip' | 'piezo'): string {
  const indexLiteral = encoding === 'piezo' ? PIEZO_PY_LITERAL : EIIP_PY_LITERAL;
  return `
import sys, json, re, math
import numpy as np

AA_INDEX = ${indexLiteral}

# --- Morlet CWT ---
# Complex Morlet wavelet with central frequency parameter w.
# coef[i,j] = (mother wavelet at scale s_i, translated to position j) convolved
# with the signal. We return |coef| as the spatial-spectral magnitude.
def morlet_wavelet(M, s, w=6.0):
    x = np.linspace(-2 * np.pi, 2 * np.pi, M) * s
    psi = np.exp(1j * w * x / s) * np.exp(-0.5 * (x / s) ** 2) * (np.pi ** -0.25) / np.sqrt(s)
    # Subtract the admissibility correction term
    psi -= np.exp(-0.5 * w ** 2) * np.exp(-0.5 * (x / s) ** 2) * (np.pi ** -0.25) / np.sqrt(s)
    return psi

def cwt_morlet(signal, scales, w=6.0):
    n = len(signal)
    out = np.zeros((len(scales), n), dtype=float)
    for i, s in enumerate(scales):
        M = min(n, int(10 * s) + 1)
        if M < 4:
            M = 4
        psi = morlet_wavelet(M, s, w=w)
        # Convolve signal with conjugate-reversed wavelet for cross-correlation.
        conv = np.convolve(signal, np.conj(psi[::-1]), mode='same')
        out[i] = np.abs(conv)
    return out

# --- input parsing ---
cfg = json.loads(sys.stdin.read())
fasta = cfg['fasta']
scales_str = cfg.get('scales') or '2,3,4,6,8,12,16,24,32,48,64,96'
scales = np.array([float(x) for x in scales_str.split(',')])

entries = []
parts = re.split(r'^>([^\\n]+)\\n', fasta, flags=re.M)
parts = parts[1:]
for i in range(0, len(parts), 2):
    hdr = parts[i]
    seq = re.sub(r'\\s', '', parts[i+1] if i+1 < len(parts) else '').upper()
    acc_match = re.match(r'(sp|tr)\\|([A-Z0-9]+)\\|', hdr)
    acc = acc_match.group(2) if acc_match else hdr.split(' ')[0]
    if len(seq) >= 100:
        entries.append({'accession': acc, 'sequence': seq, 'length': len(seq)})

if len(entries) < 5:
    print(json.dumps({'error': f'too few sequences ({len(entries)}); need at least 5'}))
    sys.exit(2)

lengths = [e['length'] for e in entries]
common_length = int(np.median(lengths))

# --- compute per-sequence CWT magnitude map, then geometric-mean consensus ---
print(f'  Computing CWT for {len(entries)} sequences across {len(scales)} scales (target length {common_length} aa)...', file=sys.stderr)
all_maps = []
for idx, e in enumerate(entries):
    s = e['sequence'][:common_length]
    if len(s) < common_length:
        s = s + 'X' * (common_length - len(s))
    encoded = np.array([AA_INDEX.get(aa, 0.0) for aa in s], dtype=float)
    encoded = encoded - encoded.mean()
    mag = cwt_morlet(encoded, scales)
    total = mag.sum()
    if total > 0:
        mag = mag / total
    all_maps.append(mag)

stacked = np.stack(all_maps)  # (M, n_scales, n_pos)

log_stack = np.log(stacked + 1e-12)
consensus = np.exp(log_stack.sum(axis=0))
csum = consensus.sum()
if csum > 0:
    consensus = consensus / csum

bg_mean = float(np.median(consensus))
bg_std = float(np.std(consensus))
threshold = bg_mean + 3 * bg_std

# Top peaks (2-D maxima above threshold, suppress neighbors within +/- 4 pos and +/- 1 scale)
flat = consensus.flatten()
sort_idx = np.argsort(flat)[::-1]
peaks = []
claimed = np.zeros_like(consensus, dtype=bool)
for ix in sort_idx[:200]:
    si, pi = np.unravel_index(ix, consensus.shape)
    if claimed[si, pi]:
        continue
    if consensus[si, pi] <= threshold:
        break
    peaks.append({
        'position': int(pi),
        'scale_bin': int(si),
        'scale_aa': float(scales[si]),
        'magnitude': float(consensus[si, pi]),
    })
    lo_s = max(0, si - 1)
    hi_s = min(consensus.shape[0], si + 2)
    lo_p = max(0, pi - 4)
    hi_p = min(consensus.shape[1], pi + 5)
    claimed[lo_s:hi_s, lo_p:hi_p] = True
    if len(peaks) >= 16:
        break

if not peaks:
    # fall back to argmax
    si, pi = np.unravel_index(np.argmax(consensus), consensus.shape)
    peaks = [{
        'position': int(pi),
        'scale_bin': int(si),
        'scale_aa': float(scales[si]),
        'magnitude': float(consensus[si, pi]),
    }]

top = peaks[0]
snr = float((top['magnitude'] - bg_mean) / (bg_std + 1e-12))

# Position aggregate (sum over scales) and scale aggregate (sum over positions)
pos_profile = consensus.sum(axis=0).tolist()
scale_profile = consensus.sum(axis=1).tolist()

# Subsample 2-D map for disk economy: keep up to 600 positions x all scales
n_pos = consensus.shape[1]
if n_pos <= 600:
    submap = consensus.tolist()
else:
    stride = max(1, n_pos // 600)
    submap = consensus[:, ::stride].tolist()

result = {
    'n_sequences': len(entries),
    'common_length': common_length,
    'scales_aa': scales.tolist(),
    'consensus_magnitude_subsampled': submap,
    'position_aggregate_profile': pos_profile,
    'scale_aggregate_profile': scale_profile,
    'dominant_peaks': peaks,
    'characteristic_scale_bin': top['scale_bin'],
    'characteristic_scale_aa': top['scale_aa'],
    'background_mean': bg_mean,
    'background_std': bg_std,
    'signal_to_noise_ratio': snr,
    'uniprot_ids': [e['accession'] for e in entries],
}
print(json.dumps(result))
`;
}

function printSummary(r: WaveletConsensusResult): void {
  console.log(chalk.cyan(`\n🌊 Wavelet Consensus Map  ${r.gene} (${r.uniprot})`));
  console.log(chalk.cyan('─'.repeat(72)));
  console.log(`  encoding:                    ${r.encoding}`);
  console.log(`  source:                      ${r.source}${r.pfam ? `, Pfam ${r.pfam}` : ''}`);
  console.log(`  taxonomy id:                 ${r.taxonomy}`);
  console.log(`  sequences:                   ${r.n_sequences}`);
  console.log(`  common length:               ${r.common_length} aa`);
  console.log(`  scales (aa):                 ${r.scales_aa.join(', ')}`);
  console.log(chalk.cyan('─'.repeat(72)));
  console.log(chalk.bold(`  Characteristic scale s_c:`));
  console.log(`    bin                        ${r.characteristic_scale_bin}`);
  console.log(`    scale (aa)                 ${r.characteristic_scale_aa.toFixed(2)}`);
  console.log(`    signal-to-noise            ${r.signal_to_noise_ratio.toFixed(2)} σ above background`);
  console.log(chalk.cyan('─'.repeat(72)));
  console.log('  Top dominant peaks (position, scale, magnitude):');
  for (const p of r.dominant_peaks.slice(0, 6)) {
    console.log(`    pos ${String(p.position).padStart(4)}   scale ${p.scale_aa.toFixed(1).padStart(5)} aa   mag ${p.magnitude.toExponential(3)}`);
  }
  console.log('');
}

export async function waveletConsensusCommand(gene: string, opts: WaveletConsensusOptions): Promise<void> {
  const upper = gene.toUpperCase();
  const uniprot = opts.uniprot || GENE_TO_UNIPROT[upper];
  if (!uniprot) {
    throw new Error(`No UniProt mapping for ${upper}. Pass --uniprot <ACC>. Built-in: ${Object.keys(GENE_TO_UNIPROT).join(', ')}`);
  }
  const encoding = (opts.encoding || 'eiip').toLowerCase();
  if (encoding !== 'eiip' && encoding !== 'piezo') {
    throw new Error(`--encoding must be 'eiip' or 'piezo' (got '${encoding}')`);
  }

  fs.mkdirSync(WAVELET_CACHE_DIR, { recursive: true });
  const cachePath = path.join(WAVELET_CACHE_DIR, `${upper}_${encoding}.json`);

  if (fs.existsSync(cachePath) && !opts.refresh) {
    if (!opts.quiet) console.error(chalk.gray(`✓ Cached at ${cachePath} (use --refresh to recompute)`));
    const cached: WaveletConsensusResult = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    printSummary(cached);
    return;
  }

  const source = (opts.source as 'family' | 'orthologs') || 'orthologs';
  const taxonomy = opts.taxonomy || '7742';
  const reviewed = opts.reviewed !== false;
  const maxN = parseInt(opts.max || '100', 10);
  const pfam = opts.pfam || GENE_TO_PFAM[upper];

  let query: string;
  if (source === 'family') {
    if (!pfam) throw new Error(`No Pfam mapping for ${upper}. Pass --pfam <PFXXXXX>.`);
    query = `xref:pfam-${pfam}+AND+taxonomy_id:${taxonomy}`;
  } else {
    query = `gene_exact:${upper}+AND+taxonomy_id:${taxonomy}`;
  }
  if (reviewed) query += '+AND+reviewed:true';

  const url = `https://rest.uniprot.org/uniprotkb/search?query=${query}&format=fasta&size=${maxN}`;
  const spinner = opts.quiet ? null : ora(`Fetching ${source} sequences from UniProt (taxonomy ${taxonomy})...`).start();
  const fastaResult = spawnSync('curl', ['-sS', '-A', 'biofs/3.7.0', '--max-time', '60', url], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (fastaResult.status !== 0 || !fastaResult.stdout.startsWith('>')) {
    if (spinner) spinner.fail('UniProt fetch failed');
    throw new Error(`UniProt fetch failed (HTTP/curl): ${fastaResult.stderr || 'no FASTA returned'}`);
  }
  const seqCount = (fastaResult.stdout.match(/^>/gm) || []).length;
  if (spinner) spinner.succeed(`Fetched ${seqCount} sequences`);

  const PY_CONSENSUS = buildPyConsensus(encoding as 'eiip' | 'piezo');
  const pyResult = spawnSync('python3', ['-c', PY_CONSENSUS], {
    encoding: 'utf8',
    input: JSON.stringify({ fasta: fastaResult.stdout, scales: opts.scales || '' }),
    maxBuffer: 500 * 1024 * 1024,
    timeout: 600_000,
  });
  if (pyResult.status !== 0) {
    throw new Error(`Wavelet consensus computation failed: ${pyResult.stderr || pyResult.stdout}`);
  }
  if (!opts.quiet) process.stderr.write(pyResult.stderr);
  const parsed = JSON.parse(pyResult.stdout);
  if (parsed.error) {
    throw new Error(`Wavelet computation: ${parsed.error}`);
  }

  const result: WaveletConsensusResult = {
    gene: upper,
    uniprot,
    source,
    pfam,
    taxonomy,
    encoding,
    ...parsed,
    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  if (!opts.quiet) console.error(chalk.green(`✓ Cached wavelet consensus to ${cachePath}`));

  printSummary(result);
}
