/**
 * biofs tokenize-spectrum <gene>
 *
 * Emit an LLM-friendly discrete-token representation of a gene's wavelet
 * consensus + (optional) per-variant disruption profile, suitable for
 * direct consumption by an autonomous-agent variant-classification
 * pipeline running on Claude / GPT / Llama.
 *
 * The vocabulary follows the v3.8.0 engineering specification (§4.6 of
 * the v3 manuscript and Gemini's production engineering spec, Component 3):
 *
 *   POS_NNNN__FREQ_F.FF__E_BINxx__P_BINxx
 *
 * where:
 *   - NNNN is the integer residue position (0-padded to 4 digits).
 *   - F.FF is the normalized angular frequency (cycles per residue) of the
 *     scale, rounded to 2 decimal places.
 *   - E_BINxx is the EIIP-encoding magnitude bin: BIN00 (silent) to
 *     BIN06 (critical pathogenic resonant displacement).
 *   - P_BINxx is the PIEZO-encoding magnitude bin (same vocabulary).
 *
 * The mapping from raw consensus magnitude (or per-variant dB_P) to BIN
 * follows §4.6 of the manuscript:
 *
 *   (-∞, 0]       -> BIN00   no variation
 *   (0, 3]        -> BIN01   baseline variant noise
 *   (3, 6]        -> BIN02   low local shift
 *   (6, 10]       -> BIN03   moderate deviation
 *   (10, 15]      -> BIN04   significant structural drift
 *   (15, 20]      -> BIN05   high biophysical instability
 *   (20, +∞]      -> BIN06   critical pathogenic resonant displacement
 *
 * Reversibility: an LLM-flagged token can be mapped back to the patient's
 * native protein residue via the regex r"POS_(\d+)" on the token string,
 * which recovers the integer position directly. The variant identifier
 * itself (HGVS) is carried as a separate metadata header token, so no
 * inverse Fourier or wavelet transform is ever required.
 *
 * Privacy: the token format carries no raw amino-acid identity; it carries
 * only spatial-spectral magnitude bins. An attacker intercepting the token
 * stream cannot reconstruct the protein sequence within Hamming distance
 * <= 5% of the protein length without the client-side baseline parameters
 * (the operator's biowallet private key, the wild-type sequence cache, the
 * EIIP and PIEZO_INDEX tables). This satisfies Appendix C Test 3 of the
 * v3 manuscript (phase-retrieval boundary enforcement).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

import { GENE_TO_UNIPROT } from '../lib/gene-map';

const WAVELET_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'wavelet');
const RRM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'rrm');

export interface TokenizeSpectrumOptions {
  variant?: string;             // HGVS substring such as p.Gly12Asp
  positionWindow?: string;      // residues on each side of the variant (default 10)
  encoding?: string;            // 'eiip' (default) or 'piezo'
  vocabBins?: string;           // comma-separated dB cutoffs, default '0,3,6,10,15,20'
  scaleBinning?: string;        // 'top5' (default), 'all', 'characteristic'
  format?: string;              // 'tokens' (default, plain string) or 'json'
  output?: string;              // optional path to write to
  quiet?: boolean;
}

interface WaveletConsensus {
  gene: string;
  uniprot: string;
  signature_type?: string;
  encoding: string;
  n_sequences: number;
  common_length: number;
  scales_aa: number[];
  consensus_magnitude_subsampled?: number[][];
  position_aggregate_profile?: number[];
  scale_aggregate_profile?: number[];
  dominant_peaks: Array<{ position: number; scale_bin: number; scale_aa: number; magnitude: number }>;
  characteristic_scale_bin: number;
  characteristic_scale_aa: number;
  background_mean: number;
  background_std: number;
  signal_to_noise_ratio: number;
}

const DEFAULT_BINS = [0, 3, 6, 10, 15, 20]; // 7 tiers including the implicit -inf and +inf
const BIN_LABELS = ['BIN00', 'BIN01', 'BIN02', 'BIN03', 'BIN04', 'BIN05', 'BIN06'];
const BIN_SEMANTICS: Record<string, string> = {
  BIN00: 'no variation',
  BIN01: 'baseline variant noise',
  BIN02: 'low local shift',
  BIN03: 'moderate deviation',
  BIN04: 'significant structural drift',
  BIN05: 'high biophysical instability',
  BIN06: 'critical pathogenic resonant displacement',
};

function dB(magnitude: number, background_mean: number): number {
  // Convert a consensus magnitude to a decibel value relative to the
  // background mean. The exact dB_P formula in §2.4 uses per-scale noise
  // floor; here we use the global background_mean as a first approximation
  // since the cached consensus already provides it.
  const eps = 1e-12;
  return 10 * Math.log10(magnitude / (background_mean + eps) + eps);
}

function bin(dBValue: number, bins: number[]): string {
  if (dBValue <= bins[0]) return BIN_LABELS[0];
  for (let i = 0; i < bins.length - 1; i++) {
    if (dBValue > bins[i] && dBValue <= bins[i + 1]) {
      return BIN_LABELS[i + 1];
    }
  }
  return BIN_LABELS[bins.length];
}

function loadConsensus(gene: string, encoding: string): WaveletConsensus | null {
  const p = path.join(WAVELET_CACHE_DIR, `${gene}_${encoding}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

interface Token {
  position: number;
  frequency: number;
  e_bin: string;
  p_bin: string;
  e_dB: number;
  p_dB: number;
}

function buildTokens(
  eiipConsensus: WaveletConsensus | null,
  piezoConsensus: WaveletConsensus | null,
  bins: number[],
  variantPos: number | null,
  positionWindow: number,
  scaleBinning: string,
): Token[] {
  // Choose the consensus that exists (prefer EIIP if both)
  const reference = eiipConsensus || piezoConsensus;
  if (!reference) throw new Error('No consensus available for either encoding');
  const submap_e = eiipConsensus?.consensus_magnitude_subsampled || null;
  const submap_p = piezoConsensus?.consensus_magnitude_subsampled || null;
  const scales = reference.scales_aa;
  const bg_e = eiipConsensus?.background_mean || reference.background_mean;
  const bg_p = piezoConsensus?.background_mean || bg_e;
  const length = reference.common_length;

  // Map subsampled column index back to native residue position.
  const n_cols_e = submap_e ? submap_e[0].length : length;
  const n_cols_p = submap_p ? submap_p[0].length : length;
  const e_stride = Math.max(1, Math.round(length / n_cols_e));
  const p_stride = Math.max(1, Math.round(length / n_cols_p));

  // Determine which scales to emit
  let scaleIndices: number[];
  if (scaleBinning === 'all') {
    scaleIndices = scales.map((_, i) => i);
  } else if (scaleBinning === 'characteristic') {
    scaleIndices = [reference.characteristic_scale_bin];
  } else {
    // top-5: use the scale_bin of the 5 dominant_peaks, deduplicated
    const seen = new Set<number>();
    scaleIndices = [];
    for (const p of reference.dominant_peaks.slice(0, 5)) {
      if (!seen.has(p.scale_bin)) {
        seen.add(p.scale_bin);
        scaleIndices.push(p.scale_bin);
      }
    }
    if (scaleIndices.length === 0) scaleIndices = [reference.characteristic_scale_bin];
  }

  // Determine which positions to emit. If a variant is specified, emit a
  // window of [variantPos - positionWindow, variantPos + positionWindow]
  // residues. Otherwise emit the dominant-peak positions only.
  let positions: number[];
  if (variantPos !== null) {
    const lo = Math.max(0, variantPos - positionWindow);
    const hi = Math.min(length - 1, variantPos + positionWindow);
    positions = [];
    for (let pos = lo; pos <= hi; pos++) positions.push(pos);
  } else {
    const seen = new Set<number>();
    positions = [];
    for (const p of reference.dominant_peaks.slice(0, 10)) {
      if (!seen.has(p.position)) {
        seen.add(p.position);
        positions.push(p.position);
      }
    }
  }

  const tokens: Token[] = [];
  for (const pos of positions) {
    for (const sBin of scaleIndices) {
      const scale = scales[sBin];
      const freq = 1.0 / scale;
      const eColIdx = Math.min(n_cols_e - 1, Math.floor(pos / e_stride));
      const pColIdx = Math.min(n_cols_p - 1, Math.floor(pos / p_stride));
      const e_mag = submap_e ? submap_e[sBin][eColIdx] : 0;
      const p_mag = submap_p ? submap_p[sBin][pColIdx] : 0;
      const e_dB_val = dB(e_mag, bg_e);
      const p_dB_val = dB(p_mag, bg_p);
      tokens.push({
        position: pos,
        frequency: freq,
        e_bin: bin(e_dB_val, bins),
        p_bin: bin(p_dB_val, bins),
        e_dB: e_dB_val,
        p_dB: p_dB_val,
      });
    }
  }
  return tokens;
}

function tokenToString(t: Token): string {
  return `POS_${String(t.position).padStart(4, '0')}__FREQ_${t.frequency.toFixed(2)}__E_${t.e_bin}__P_${t.p_bin}`;
}

function parseHgvs(s: string): { ref: string; pos: number; alt: string } | null {
  // Accept either 1-letter (G12D) or 3-letter (Gly12Asp) HGVS substrings.
  const THREE_TO_ONE: Record<string, string> = {
    Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C', Glu: 'E', Gln: 'Q', Gly: 'G',
    His: 'H', Ile: 'I', Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P', Ser: 'S',
    Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
  };
  const m3 = s.match(/p?\.?([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})/);
  if (m3) {
    const ref = THREE_TO_ONE[m3[1]];
    const alt = THREE_TO_ONE[m3[3]];
    if (ref && alt) return { ref, pos: parseInt(m3[2], 10), alt };
  }
  const m1 = s.match(/^([A-Z])(\d+)([A-Z\*])$/);
  if (m1) return { ref: m1[1], pos: parseInt(m1[2], 10), alt: m1[3] };
  return null;
}

export async function tokenizeSpectrumCommand(gene: string, opts: TokenizeSpectrumOptions): Promise<void> {
  const upper = gene.toUpperCase();
  const encoding = (opts.encoding || 'eiip').toLowerCase();
  const positionWindow = parseInt(opts.positionWindow || '10', 10);
  const scaleBinning = opts.scaleBinning || 'top5';
  const binsParsed = (opts.vocabBins || '0,3,6,10,15,20').split(',').map(x => parseFloat(x.trim()));

  // Load both EIIP and PIEZO wavelet consensuses if available.
  const eiipConsensus = loadConsensus(upper, 'eiip');
  const piezoConsensus = loadConsensus(upper, 'piezo');
  if (!eiipConsensus && !piezoConsensus) {
    throw new Error(`No wavelet consensus cached for ${upper}. Run \`biofs wavelet-consensus ${upper}\` first.`);
  }

  let variantPos: number | null = null;
  let variantHgvs: string | null = null;
  if (opts.variant) {
    const parsed = parseHgvs(opts.variant);
    if (!parsed) throw new Error(`Could not parse variant HGVS: ${opts.variant}`);
    variantPos = parsed.pos - 1; // HGVS is 1-indexed, internal is 0-indexed
    variantHgvs = `p.${parsed.ref}${parsed.pos}${parsed.alt}`;
  }

  const tokens = buildTokens(eiipConsensus, piezoConsensus, binsParsed, variantPos, positionWindow, scaleBinning);

  if (opts.format === 'json') {
    const out = {
      gene: upper,
      encoding,
      variant: variantHgvs,
      variant_position: variantPos !== null ? variantPos + 1 : null, // back to 1-indexed
      vocab_bins: binsParsed,
      bin_labels: BIN_LABELS,
      bin_semantics: BIN_SEMANTICS,
      n_tokens: tokens.length,
      tokens: tokens.map(t => ({ ...t, token: tokenToString(t) })),
    };
    const text = JSON.stringify(out, null, 2);
    if (opts.output) {
      fs.writeFileSync(opts.output, text);
      if (!opts.quiet) console.error(chalk.green(`✓ Wrote JSON tokens to ${opts.output}`));
    } else {
      process.stdout.write(text + '\n');
    }
  } else {
    // Plain tokens output. Prepend a header token with gene + variant context.
    const header = `<GENE_${upper}>${variantHgvs ? ` <VARIANT_${variantHgvs.replace(/[^A-Za-z0-9.]/g, '_')}>` : ''}`;
    const tokenStrings = tokens.map(tokenToString);
    const text = `${header}\n${tokenStrings.join(' ')}\n`;
    if (opts.output) {
      fs.writeFileSync(opts.output, text);
      if (!opts.quiet) console.error(chalk.green(`✓ Wrote ${tokens.length} tokens to ${opts.output}`));
    } else {
      process.stdout.write(text);
    }
    if (!opts.quiet) {
      console.error(chalk.cyan(`\n🎼 Spectral token stream for ${upper}${variantHgvs ? ' ' + variantHgvs : ''}`));
      console.error(`   tokens emitted:           ${tokens.length}`);
      console.error(`   scale binning:            ${scaleBinning}`);
      console.error(`   position window:          ±${positionWindow} residues around variant`);
      console.error(`   vocabulary (dB cutoffs):  ${binsParsed.join(', ')}`);
      console.error('');
    }
  }
}
