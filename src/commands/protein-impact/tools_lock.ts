/**
 * The tools lock: container image digests, model revisions and structure hashes that a protein-impact
 * run is allowed to use. A stage whose image has no digest, or a model without a pinned revision, refuses
 * to run, so nothing executes from a floating tag. The hash of this file is written into every gate
 * document and manifest, so changing a tool invalidates earlier validation on purpose.
 */

import lockJson from './tools.lock.json';
import { canonicalJson, sha256Hex } from './request';

export interface LockedImage { name: string; digest: string | null; layers: string[] }
export interface LockedModel { hf_repo: string; revision: string | null; license: string }
export interface LockedStructure { id: string; sha256: string | null }

export interface ToolsLock {
  schema: string;
  locked_on: string | null;
  images: Record<string, LockedImage>;
  models: Record<string, LockedModel>;
  /** Which models each layer loads; a model that is listed in `models` but not here is not used. */
  layer_models: Record<string, string[]>;
  structures: LockedStructure[];
}

export class ToolsLockError extends Error {}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;

export function loadToolsLock(): ToolsLock {
  const l = lockJson as unknown as ToolsLock;
  if (l.schema !== 'genobank.protein-impact.tools-lock/v1') throw new ToolsLockError('tools.lock.json has the wrong schema');
  return l;
}

export function toolsLockSha256(lock: ToolsLock = loadToolsLock()): string {
  return sha256Hex(canonicalJson(lock));
}

/** `name@sha256:digest` for the image that serves a layer, or throws if the lock does not pin one. */
export function imageForLayer(layer: string, lock: ToolsLock = loadToolsLock()): string {
  const entry = Object.values(lock.images).find(i => i.layers.includes(layer));
  if (!entry) throw new ToolsLockError(`no image is assigned to layer "${layer}"`);
  if (!entry.digest || !DIGEST.test(entry.digest)) {
    throw new ToolsLockError(`image ${entry.name} for layer "${layer}" has no pinned digest in tools.lock.json (build and lock it first)`);
  }
  return `${entry.name}@${entry.digest}`;
}

/** The pinned Hugging Face repo and commit of a model, or throws if the revision is not a 40-hex commit. */
export function modelRevision(key: string, lock: ToolsLock = loadToolsLock()): { hf_repo: string; revision: string } {
  const m = lock.models[key];
  if (!m) throw new ToolsLockError(`model "${key}" is not in tools.lock.json`);
  if (!m.revision || !REVISION.test(m.revision)) throw new ToolsLockError(`model ${key} (${m.hf_repo}) has no pinned commit in tools.lock.json`);
  return { hf_repo: m.hf_repo, revision: m.revision };
}
