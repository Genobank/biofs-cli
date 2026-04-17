/**
 * Alias store — user-defined shortcuts for ip_ids / BioCIDs.
 *
 * File: ~/.biofs/aliases.json  (same directory as credentials.json)
 * Overridable via env: BIOFS_ALIASES
 *
 * Aliases only fire on non-hex, non-BioCID inputs, so real ip_ids always
 * pass through untouched. Prevents shadowing of real ids.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type AliasMap = Record<string, string>;

function aliasesPath(): string {
  return process.env.BIOFS_ALIASES || path.join(os.homedir(), '.biofs', 'aliases.json');
}

export function loadAliases(): AliasMap {
  const p = aliasesPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AliasMap;
  } catch {
    return {};
  }
}

export function saveAliases(a: AliasMap): void {
  const p = aliasesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(a, Object.keys(a).sort(), 2) + '\n', 'utf8');
}

/** If `s` matches a saved alias, return the underlying id/BioCID. */
export function resolveAlias(s: string): string {
  if (!s) return s;
  if (s.startsWith('0x') || s.startsWith('biocid://')) return s;
  const a = loadAliases();
  return a[s] ?? s;
}

export function aliasFilePath(): string {
  return aliasesPath();
}
