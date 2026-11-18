/**
 * Cost estimate and approval check for protein-impact. Every GPU layer needs a priced estimate and an
 * explicit approval (`--approve <estimate_id> --max-usd N`). The estimate id is derived from the request
 * hash, the total and the UTC day, so approving one request never approves another, and an approval
 * expires at the end of the UTC day. Prices are the listed on-demand rates checked 2026-10-21 and are
 * ESTIMATES: the watchdog on the node stops a job at 1.5 times the approved total.
 */

import { GPU_LAYERS, Layer } from './constants';
import { ProteinImpactRequest } from './guard';
import { requestHash, sha256Hex } from './request';

export interface Machine { id: string; label: string; usd_per_hour: number; gpu: boolean }

export const MACHINES: Record<string, Machine> = {
  'methyl-cpu': { id: 'methyl-cpu', label: 'methyl-cpu (c3-standard-88)', usd_per_hour: 4.49, gpu: false },
  'genoclaw-small-gpu': { id: 'genoclaw-small-gpu', label: 'L4 24 GB (us-west1-a)', usd_per_hour: 0.85, gpu: true },
  'parabricks-gpu': { id: 'parabricks-gpu', label: 'A100 40 GB (us-central1-f)', usd_per_hour: 3.67, gpu: true },
  'parabricks-gpu-spot': { id: 'parabricks-gpu-spot', label: '2 x A100 spot (us-central1-f)', usd_per_hour: 7.35, gpu: true },
};

/** Planning figure for the number of benchmark variants in a validate run. */
export const VALIDATE_ASSUMED_VARIANTS = 200;

/** The design figure: 12 trajectories of 100 ns take about 100 A100-hours. */
export const MD_A100_HOURS_PER_100NS = 100 / 12;

export interface EstimateOptions { mdNs?: number; mdReplicas?: number; complexTools?: number }
export interface EstimateLine { layer: Layer | 'startup'; machine: string; hours: number; usd: number; note: string }
export interface Estimate {
  request_hash: string;
  lines: EstimateLine[];
  total_hours: number;
  total_usd: number;
  gpu: boolean;
  estimate_id: string;
  valid_until_utc: string;
  assumptions: string[];
}

export class ApprovalError extends Error {}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function estimate(req: ProteinImpactRequest, now: Date = new Date(), opts: EstimateOptions = {}): Estimate {
  const given = req.targets.reduce((a, t) => a + t.subs.length, 0);
  // a validate request carries no substitutions: the benchmark supplies them (planning figure)
  const n = req.mode === 'validate' && given === 0 ? VALIDATE_ASSUMED_VARIANTS : given;
  const mdNs = opts.mdNs ?? 100;
  const mdReplicas = opts.mdReplicas ?? 3;
  const complexTools = opts.complexTools ?? 3;
  const lines: EstimateLine[] = [];
  const add = (layer: Layer | 'startup', machine: string, hours: number, note: string) => {
    lines.push({ layer, machine, hours: r2(hours), usd: r2(hours * MACHINES[machine].usd_per_hour), note });
  };

  for (const layer of req.layers) {
    switch (layer) {
      case 'fetch': add(layer, 'methyl-cpu', 0.1, 'UniProt and RCSB downloads, sha256 pinned'); break;
      case 'features': add(layer, 'methyl-cpu', 0.1, 'BLOSUM62, hydropathy, volume, charge, UniProt feature overlap'); break;
      // planning figure until the first measured run: 0.5 h for the image pull and weights, then 20 s per variant
      case 'plm': add(layer, 'methyl-cpu', 0.5 + (n * 20) / 3600, 'ESM2 masked-marginal scores on the CPU executor'); break;
      case 'structure': add(layer, 'methyl-cpu', 0.3 + 0.05 * n, 'burial, contacts and interface features on experimental structures'); break;
      case 'probe': add(layer, 'parabricks-gpu', 0.5, 'memory probe of the full heterodimer on an A100 40 GB'); break;
      case 'complex': add(layer, 'parabricks-gpu', 0.15 * n * 2 * complexTools, `${n} substitution(s) x wild type and mutant x ${complexTools} predictors on 700-residue crops`); break;
      case 'md': add(layer, 'parabricks-gpu', n * 2 * mdReplicas * (mdNs / 100) * MD_A100_HOURS_PER_100NS, `${n * 2 * mdReplicas} trajectories of ${mdNs} ns`); break;
    }
  }

  // a stopped GPU executor has to boot, pull its image and fetch model weights before any layer starts
  if (req.layers.some(l => GPU_LAYERS.includes(l))) add('startup', 'parabricks-gpu', 0.5, 'VM start, container image pull and model weights (first run on a stopped executor)');

  const total_hours = r2(lines.reduce((a, l) => a + l.hours, 0));
  const total_usd = r2(lines.reduce((a, l) => a + l.usd, 0));
  const day = now.toISOString().slice(0, 10);
  const rh = requestHash(req);
  return {
    request_hash: rh,
    lines,
    total_hours,
    total_usd,
    gpu: req.layers.some(l => GPU_LAYERS.includes(l)),
    estimate_id: sha256Hex(`${rh}|${total_usd.toFixed(2)}|${day}`).slice(0, 16),
    valid_until_utc: `${day}T23:59:59Z`,
    assumptions: [
      'on-demand list prices checked 2026-10-21; spot prices and stockouts vary',
      'hours are planning figures, not measurements; the node watchdog stops a job at 1.5 x the approved total',
      'a VM started by the job is stopped when the job ends',
    ],
  };
}

/** Throws unless the request's approval matches a fresh estimate of the same request on the same UTC day. */
export function verifyApproval(req: ProteinImpactRequest, now: Date = new Date(), opts: EstimateOptions = {}): void {
  const est = estimate(req, now, opts);
  if (!est.gpu) return;
  const a = req.approval;
  if (!a) throw new ApprovalError('GPU layers need an approved estimate');
  if (a.estimate_id !== est.estimate_id) throw new ApprovalError('approval does not match this request today (estimates expire at 23:59 UTC; run estimate again)');
  if (a.max_usd < est.total_usd) throw new ApprovalError(`max_usd ${a.max_usd} is below the estimated total ${est.total_usd}`);
}
