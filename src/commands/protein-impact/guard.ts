/**
 * Request validation and the NO-DESIGN GUARD for biofs protein-impact.
 *
 * This verb ANALYZES known missense substitutions of two pinned human proteins. It cannot be used to
 * design anything: the only accepted inputs are (gene, ref, pos, alt) tuples, checked against a pinned
 * UniProt sequence later by the executor. There is no free-text sequence, FASTA, SMILES or structure
 * input; unknown fields are rejected; any field name that suggests design, generation or sampling is
 * rejected by name at any depth; and a long run of amino-acid letters in ANY string value is rejected.
 *
 * The same function runs in three places: the client (before submit), biofs-node (before it forwards or
 * starts anything) and the executor (before it runs a stage). A forged request has to get past all three.
 */

import {
  BIOCID_RE, GATE_ID_RE, GENES, GPU_LAYERS, LAYERS, MAX_GENES_PER_REQUEST, MAX_SOURCES, MAX_SUBS_PER_REQUEST,
  MODES, SCHEMA_REQUEST, STANDARD_AA, Layer, Mode,
} from './constants';

export interface RequestSub { pos: number; ref: string; alt: string }
export interface RequestTarget { gene: string; uniprot: string; subs: RequestSub[] }
export interface Approval { estimate_id: string; max_usd: number }

export interface ProteinImpactRequest {
  schema: string;
  mode: Mode;
  serial?: string;        // apply only: the biosample the variants were read from
  sources?: string[];     // apply only: biocids the variants were read from (consent is checked against these)
  targets: RequestTarget[];
  layers: Layer[];
  gate?: string;          // apply only: gate:sha256:<hex> of the passing, signed gate document
  approval?: Approval;    // GPU layers only
  diagnosis_assumption?: string;
}

export class GuardError extends Error {
  constructor(public violations: string[]) {
    super(`protein-impact request refused: ${violations.join('; ')}`);
  }
}

const ALLOWED_TOP = new Set(['schema', 'mode', 'serial', 'sources', 'targets', 'layers', 'gate', 'approval', 'diagnosis_assumption']);
const ALLOWED_TARGET = new Set(['gene', 'uniprot', 'subs']);
const ALLOWED_SUB = new Set(['pos', 'ref', 'alt']);
const ALLOWED_APPROVAL = new Set(['estimate_id', 'max_usd']);
const DESIGN_KEY = /seq|fasta|smiles|design|generat|sampl|temperature|diffus|inpaint|scaffold|binder|librar|optimi[sz]e|pdb_?text|structure_?text/i;
// Case-insensitive on purpose: a lowercase 20-mer is as much a sequence as an uppercase one.
const AA_RUN = new RegExp(`[${STANDARD_AA}]{20,}`, 'i');
// Fields whose whole value is a fixed-format hex string checked by a strict regex below; a long run of the
// hex letters a to f in them is not a sequence, so the run test skips exactly these two.
const HEX_FIELDS = new Set(['gate', 'approval.estimate_id']);
const SERIAL = /^[A-Za-z0-9]{4,32}$/;
const ESTIMATE_ID = /^[a-f0-9]{16}$/;
const MAX_APPROVED_USD = 2000;

function walk(v: unknown, path: string, out: string[]): void {
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path.replace(/\.$/, '')}[${i}].`, out)); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (DESIGN_KEY.test(k)) out.push(`field name "${path}${k}" is not allowed (no-design guard)`);
      walk(x, `${path}${k}.`, out);
    }
    return;
  }
  const where = path.replace(/\.$/, '');
  if (typeof v === 'string' && !HEX_FIELDS.has(where) && AA_RUN.test(v)) {
    out.push(`value at "${where || '(root)'}" looks like a protein sequence (no-design guard)`);
  }
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string, out: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) out.push(`unknown field "${where}${k}"`);
}

export function validateRequest(raw: unknown): ProteinImpactRequest {
  const v: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GuardError(['request must be a JSON object']);
  const r = raw as Record<string, any>;
  walk(r, '', v);
  unknownKeys(r, ALLOWED_TOP, '', v);

  if (r.schema !== SCHEMA_REQUEST) v.push(`schema must be ${SCHEMA_REQUEST}`);
  if (!MODES.includes(r.mode)) v.push(`mode must be one of ${MODES.join(', ')}`);

  // layers
  const layers: unknown = r.layers;
  if (!Array.isArray(layers) || layers.length === 0) v.push('layers must be a non-empty array');
  else {
    for (const l of layers) if (!LAYERS.includes(l as Layer)) v.push(`unknown layer "${String(l)}"`);
    if (new Set(layers).size !== layers.length) v.push('layers must not repeat');
  }

  // targets
  const targets: unknown = r.targets;
  let subCount = 0;
  if (!Array.isArray(targets) || targets.length === 0) v.push('targets must be a non-empty array');
  else {
    if (targets.length > MAX_GENES_PER_REQUEST) v.push(`at most ${MAX_GENES_PER_REQUEST} genes per request`);
    const seenGenes = new Set<string>();
    targets.forEach((t: any, ti: number) => {
      const where = `targets[${ti}].`;
      if (!t || typeof t !== 'object' || Array.isArray(t)) { v.push(`${where.slice(0, -1)} must be an object`); return; }
      unknownKeys(t, ALLOWED_TARGET, where, v);
      const g = typeof t.gene === 'string' ? GENES[t.gene] : undefined;
      if (!g) { v.push(`${where}gene "${String(t.gene)}" is not supported (supported: ${Object.keys(GENES).join(', ')})`); return; }
      if (seenGenes.has(g.gene)) v.push(`${where}gene ${g.gene} appears twice`);
      seenGenes.add(g.gene);
      if (t.uniprot !== g.uniprot) v.push(`${where}uniprot must be ${g.uniprot} for ${g.gene}`);
      // fetch, probe and validate work on genes or on a benchmark, so they may carry no substitutions
      const mayBeEmpty = r.mode === 'fetch' || r.mode === 'probe' || r.mode === 'validate';
      if (!Array.isArray(t.subs) || (t.subs.length === 0 && !mayBeEmpty)) { v.push(`${where}subs must be a non-empty array`); return; }
      const seen = new Set<string>();
      t.subs.forEach((s: any, si: number) => {
        const sw = `${where}subs[${si}].`;
        subCount++;
        if (!s || typeof s !== 'object' || Array.isArray(s)) { v.push(`${sw.slice(0, -1)} must be an object`); return; }
        unknownKeys(s, ALLOWED_SUB, sw, v);
        if (!Number.isInteger(s.pos) || s.pos <= g.signal || s.pos > g.length) v.push(`${sw}pos must be an integer in ${g.signal + 1}..${g.length} (HGVS numbering)`);
        if (typeof s.ref !== 'string' || s.ref.length !== 1 || !STANDARD_AA.includes(s.ref)) v.push(`${sw}ref must be one standard amino acid letter`);
        if (typeof s.alt !== 'string' || s.alt.length !== 1 || !STANDARD_AA.includes(s.alt)) v.push(`${sw}alt must be one standard amino acid letter`);
        if (s.ref === s.alt) v.push(`${sw}ref and alt must differ (missense only)`);
        const key = `${s.pos}${s.ref}${s.alt}`;
        if (seen.has(key)) v.push(`${sw.slice(0, -1)} duplicates another substitution`);
        seen.add(key);
      });
    });
    if (subCount > MAX_SUBS_PER_REQUEST) v.push(`at most ${MAX_SUBS_PER_REQUEST} substitutions per request`);
  }

  // mode rules: only apply touches a biosample; fetch, validate and probe use public data alone
  const mode: Mode = r.mode;
  if (mode === 'apply') {
    if (typeof r.serial !== 'string' || !SERIAL.test(r.serial)) v.push('serial (4 to 32 letters or digits) is required for apply');
    if (typeof r.gate !== 'string' || !GATE_ID_RE.test(r.gate)) v.push('apply requires gate: the id (gate:sha256:<64 hex>) of a passing, signed gate document');
    const s = r.sources;
    if (!Array.isArray(s) || s.length < 1 || s.length > MAX_SOURCES || !s.every((x: unknown) => typeof x === 'string' && BIOCID_RE.test(x))) {
      v.push(`apply requires sources: 1 to ${MAX_SOURCES} biocids the variants were read from`);
    }
  } else {
    if (r.serial !== undefined) v.push(`${mode} works on public data only: serial must be absent`);
    if (r.gate !== undefined) v.push('gate is only accepted by apply');
    if (r.sources !== undefined) v.push('sources are only accepted by apply');
  }
  if (mode === 'validate' && subCount > 0) v.push('validate scores the benchmark: it takes no substitutions');
  if (mode === 'probe' && Array.isArray(layers) && !(layers.length === 1 && layers[0] === 'probe')) v.push('probe mode accepts exactly the layer "probe"');
  if (mode === 'fetch' && Array.isArray(layers) && !(layers.length === 1 && layers[0] === 'fetch')) v.push('fetch mode accepts exactly the layer "fetch"');

  // GPU layers need a priced, approved estimate
  const gpu = Array.isArray(layers) && layers.some(l => GPU_LAYERS.includes(l as Layer));
  if (gpu) {
    const a = r.approval;
    if (!a || typeof a !== 'object') v.push('GPU layers require approval: { estimate_id, max_usd }');
    else {
      unknownKeys(a, ALLOWED_APPROVAL, 'approval.', v);
      if (typeof a.estimate_id !== 'string' || !ESTIMATE_ID.test(a.estimate_id)) v.push('approval.estimate_id must be the 16-hex id printed by `biofs protein-impact estimate`');
      if (typeof a.max_usd !== 'number' || !(a.max_usd > 0) || a.max_usd > MAX_APPROVED_USD) v.push(`approval.max_usd must be a number in (0, ${MAX_APPROVED_USD}]`);
    }
  } else if (r.approval !== undefined) v.push('approval is only accepted with GPU layers');

  if (r.diagnosis_assumption !== undefined && (typeof r.diagnosis_assumption !== 'string' || r.diagnosis_assumption.length > 40)) v.push('diagnosis_assumption must be a short string');

  if (v.length) throw new GuardError(v);
  return r as ProteinImpactRequest;
}
