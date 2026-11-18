/**
 * Baseline substitution features (pure code, no model, no network): BLOSUM62, Kyte-Doolittle
 * hydropathy, residue volume and charge. These are the "best baseline" the validation gate compares
 * the ensemble against, and the CPU-only v0 layer of `apply`.
 */

const ORDER = 'ARNDCQEGHILKMFPSTWYV';

// Standard BLOSUM62 (Henikoff and Henikoff 1992), rows and columns in ORDER.
const ROWS: number[][] = [
  [4, -1, -2, -2, 0, -1, -1, 0, -2, -1, -1, -1, -1, -2, -1, 1, 0, -3, -2, 0],
  [-1, 5, 0, -2, -3, 1, 0, -2, 0, -3, -2, 2, -1, -3, -2, -1, -1, -3, -2, -3],
  [-2, 0, 6, 1, -3, 0, 0, 0, 1, -3, -3, 0, -2, -3, -2, 1, 0, -4, -2, -3],
  [-2, -2, 1, 6, -3, 0, 2, -1, -1, -3, -4, -1, -3, -3, -1, 0, -1, -4, -3, -3],
  [0, -3, -3, -3, 9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2, -1],
  [-1, 1, 0, 0, -3, 5, 2, -2, 0, -3, -2, 1, 0, -3, -1, 0, -1, -2, -1, -2],
  [-1, 0, 0, 2, -4, 2, 5, -2, 0, -3, -3, 1, -2, -3, -1, 0, -1, -3, -2, -2],
  [0, -2, 0, -1, -3, -2, -2, 6, -2, -4, -4, -2, -3, -3, -2, 0, -2, -2, -3, -3],
  [-2, 0, 1, -1, -3, 0, 0, -2, 8, -3, -3, -1, -2, -1, -2, -1, -2, -2, 2, -3],
  [-1, -3, -3, -3, -1, -3, -3, -4, -3, 4, 2, -3, 1, 0, -3, -2, -1, -3, -1, 3],
  [-1, -2, -3, -4, -1, -2, -3, -4, -3, 2, 4, -2, 2, 0, -3, -2, -1, -2, -1, 1],
  [-1, 2, 0, -1, -3, 1, 1, -2, -1, -3, -2, 5, -1, -3, -1, 0, -1, -3, -2, -2],
  [-1, -1, -2, -3, -1, 0, -2, -3, -2, 1, 2, -1, 5, 0, -2, -1, -1, -1, -1, 1],
  [-2, -3, -3, -3, -2, -3, -3, -3, -1, 0, 0, -3, 0, 6, -4, -2, -2, 1, 3, -1],
  [-1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4, 7, -1, -1, -4, -3, -2],
  [1, -1, 1, 0, -1, 0, 0, 0, -1, -2, -2, 0, -1, -2, -1, 4, 1, -3, -2, -2],
  [0, -1, 0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1, 1, 5, -2, -2, 0],
  [-3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1, 1, -4, -3, -2, 11, 2, -3],
  [-2, -2, -2, -3, -2, -1, -2, -3, 2, -1, -1, -2, -1, 3, -3, -2, -2, 2, 7, -1],
  [0, -3, -3, -3, -1, -2, -2, -3, -3, 3, 1, -2, 1, -1, -2, -2, 0, -3, -1, 4],
];

export function blosum62(a: string, b: string): number {
  const i = ORDER.indexOf(a), j = ORDER.indexOf(b);
  if (i < 0 || j < 0) throw new Error(`not a standard residue: ${a}, ${b}`);
  return ROWS[i][j];
}

// Kyte and Doolittle 1982.
export const KYTE_DOOLITTLE: Record<string, number> = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, Q: -3.5, E: -3.5, G: -0.4, H: -3.2, I: 4.5,
  L: 3.8, K: -3.9, M: 1.9, F: 2.8, P: -1.6, S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2,
};

// Residue volume in cubic angstroms (Zamyatnin 1972).
export const RESIDUE_VOLUME: Record<string, number> = {
  A: 88.6, R: 173.4, N: 114.1, D: 111.1, C: 108.5, Q: 143.8, E: 138.4, G: 60.1, H: 153.2, I: 166.7,
  L: 166.7, K: 168.6, M: 162.9, F: 189.9, P: 112.7, S: 89.0, T: 116.1, W: 227.8, Y: 193.6, V: 140.0,
};

// Net side-chain charge near pH 7 (His as a partial charge).
export const RESIDUE_CHARGE: Record<string, number> = { D: -1, E: -1, K: 1, R: 1, H: 0.1 };

export interface SubstitutionFeatures {
  blosum62: number;
  delta_hydropathy: number;
  delta_volume: number;
  delta_charge: number;
  to_proline: boolean;
  from_glycine: boolean;
  from_proline: boolean;
  to_cysteine: boolean;
  from_cysteine: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function substitutionFeatures(ref: string, alt: string): SubstitutionFeatures {
  if (!(ref in KYTE_DOOLITTLE) || !(alt in KYTE_DOOLITTLE)) throw new Error(`not a standard residue: ${ref}, ${alt}`);
  return {
    blosum62: blosum62(ref, alt),
    delta_hydropathy: r2(KYTE_DOOLITTLE[alt] - KYTE_DOOLITTLE[ref]),
    delta_volume: r2(RESIDUE_VOLUME[alt] - RESIDUE_VOLUME[ref]),
    delta_charge: r2((RESIDUE_CHARGE[alt] || 0) - (RESIDUE_CHARGE[ref] || 0)),
    to_proline: alt === 'P',
    from_glycine: ref === 'G',
    from_proline: ref === 'P',
    to_cysteine: alt === 'C',
    from_cysteine: ref === 'C',
  };
}

/** AUROC of a score against binary labels (1 = damaging). Ties count half. Returns NaN if one class is empty. */
export function auroc(scores: number[], labels: number[]): number {
  if (scores.length !== labels.length) throw new Error('scores and labels differ in length');
  let pos = 0, neg = 0, wins = 0;
  for (let i = 0; i < scores.length; i++) {
    if (labels[i] !== 1) continue;
    pos++;
    for (let j = 0; j < scores.length; j++) {
      if (labels[j] !== 0) continue;
      if (scores[i] > scores[j]) wins += 1; else if (scores[i] === scores[j]) wins += 0.5;
    }
  }
  for (const l of labels) if (l === 0) neg++;
  return pos && neg ? wins / (pos * neg) : NaN;
}
