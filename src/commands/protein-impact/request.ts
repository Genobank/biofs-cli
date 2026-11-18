/**
 * Canonical JSON, request hash and job id for protein-impact. An identical request always yields the
 * same hash and job id, so a rerun finds its per-stage cache and does zero compute.
 */

import * as crypto from 'crypto';
import { ProteinImpactRequest } from './guard';

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sha256Hex(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * The approval block never enters the hash: approving a GPU estimate must not change which job it is.
 * Substitutions and genes are sorted so order does not matter.
 */
export function requestHash(req: ProteinImpactRequest): string {
  const { approval: _approval, ...rest } = req;
  const targets = [...rest.targets]
    .map(t => ({ ...t, subs: [...t.subs].sort((a, b) => a.pos - b.pos || a.alt.localeCompare(b.alt)) }))
    .sort((a, b) => a.gene.localeCompare(b.gene));
  const layers = [...rest.layers].sort();
  const sources = rest.sources ? [...rest.sources].sort() : undefined;
  return sha256Hex(canonicalJson({ ...rest, targets, layers, sources }));
}

export function jobIdFor(req: ProteinImpactRequest): string {
  return `pi-${req.mode}-${req.serial || 'public'}-${requestHash(req).slice(0, 12)}`;
}
