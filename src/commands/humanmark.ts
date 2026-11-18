/**
 * biofs humanmark — the product's entry point to HumanMark v1.0.
 *
 * HumanMark proves a file was authored by a human: it screens for PHI and raw
 * genomic data, commits the exact bytes with the ERC-8356 keccak scheme
 * (keccak256(salt || sha256(content)), the same commitment ConsentGrant.sol
 * verifies on chain), and emits a portable authorship proof bound to a wallet
 * EIP-712 signature and a 50-SNP DNA fingerprint that lives inside Bind.
 *
 * This is a thin client. Screening and commitment live in the tested `humanmark`
 * Python engine (one source of truth, no fork), which this verb shells to. The
 * 50-SNP bloom half reuses biofs's own VCFFingerprint so the authorship-by-DNA
 * commitment is computed the same way `biofs fingerprint` computes it.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { Logger } from '../lib/utils/logger';
import { VCFFingerprint } from '../lib/genomics/vcf-fingerprint';
import { CredentialsManager } from '../lib/auth/credentials';
import { submitBindContent, readBinding, CONSENT_GRANT_C2PA } from '../lib/sequentia/consent-grant-c2pa';

export interface HumanmarkScanOptions {
  quiet?: boolean;
}

export interface HumanmarkProveOptions {
  biocid?: string;
  revocable?: boolean;
  snpBloom?: string;
  fingerprint?: string;
  out?: string;
}

export interface HumanmarkVerifyOptions {
  bundle?: string;
}

export interface HumanmarkBlessOptions {
  reason?: string;
}

export interface HumanmarkAttestOptions {
  biocid?: string;
  fingerprint?: string;
  out?: string;
  bind?: boolean;
}

export interface HumanmarkBindOptions {
  bundle?: string;
  sidecar?: string;
  attestor?: string;
  sig?: string;
}

export interface HumanMarkRecord {
  path: string;
  status: 'safe' | 'phi' | 'genomic' | 'review';
  hits: Record<string, number>;
  content_commitment?: string;
  sha256?: string;
  blessed?: boolean;
}

export function humanmarkInvocation(): { cmd: string; base: string[] } {
  const override = process.env.BIOFS_HUMANMARK_CMD;
  if (override) {
    const parts = override.split(' ');
    return { cmd: parts[0], base: parts.slice(1) };
  }
  const probe = spawnSync('humanmark', ['--help'], { stdio: 'ignore' });
  if (probe.status === 0) return { cmd: 'humanmark', base: [] };
  return { cmd: 'python3', base: ['-m', 'humanmark'] };
}

function runHumanmark(args: string[], inherit = true): { status: number; stdout: string; stderr: string } {
  const { cmd, base } = humanmarkInvocation();
  const r = spawnSync(cmd, [...base, ...args], {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    Logger.error(
      'HumanMark engine not found. Install the humanmark package (pip install -e <humanmark-repo>) ' +
      'or set BIOFS_HUMANMARK_CMD to how it should be invoked.');
    return { status: 127, stdout: '', stderr: String(r.error) };
  }
  return {
    status: r.status ?? 1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
}

/** Screen one local file. Does not download remote biocids. */
export function screenLocalFile(filePath: string): HumanMarkRecord {
  const r = runHumanmark(['scan', filePath, '--json'], false);
  if (r.status !== 0) {
    throw new Error(r.stderr || `humanmark scan exited ${r.status}`);
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error('humanmark scan produced no JSON');
  return JSON.parse(line);
}

/**
 * Gate used by `biofs upload` and `biofs tokenize`.
 * PHI is refused. Genomic is allowed (this is a genomic vault) unless
 * `publicAuthored` is set. Review is allowed with a warning.
 */
export function assertUploadAllowed(filePath: string, opts: { publicAuthored?: boolean } = {}): HumanMarkRecord {
  const rec = screenLocalFile(filePath);
  if (rec.status === 'phi') {
    throw new Error(
      `HumanMark blocked this file (PHI/PII). Redact it or bless it with a written reason. Hits: ${JSON.stringify(rec.hits)}`);
  }
  if (rec.status === 'genomic' && opts.publicAuthored) {
    throw new Error(
      'This is genomic or clinical data. It cannot be published as a public authored work. Upload it as consent-gated vault data (omit --public).');
  }
  if (rec.status === 'review') {
    Logger.warn('HumanMark could not fully read this file. Upload proceeds as review, not as a green authorship mark.');
  }
  return rec;
}

function bloomToBytes32(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 64) return h;
  return h;
}

export async function humanmarkScanCommand(paths: string[], _options: HumanmarkScanOptions = {}): Promise<void> {
  const code = runHumanmark(['scan', ...paths]).status;
  if (code !== 0) process.exit(code);
}

export async function humanmarkBlessCommand(file: string, options: HumanmarkBlessOptions = {}): Promise<void> {
  if (!options.reason) {
    Logger.error('A written reason is required: --reason "why this is safe"');
    process.exit(2);
  }
  const code = runHumanmark(['bless', file, '--reason', options.reason]).status;
  if (code !== 0) process.exit(code);
}

export async function humanmarkVerifyCommand(file: string, options: HumanmarkVerifyOptions = {}): Promise<void> {
  const args = ['verify', file];
  if (options.bundle) args.push('--bundle', options.bundle);
  const code = runHumanmark(args).status;
  if (code !== 0) process.exit(code);
}

export async function resolveSnpBloom(options: { snpBloom?: string; fingerprint?: string }): Promise<string | undefined> {
  if (options.snpBloom) return bloomToBytes32(options.snpBloom);
  if (!options.fingerprint) return undefined;
  if (!fs.existsSync(options.fingerprint)) {
    throw new Error(`No such fingerprint file: ${options.fingerprint}`);
  }
  const hex = await new VCFFingerprint().processFile(options.fingerprint, 0, 50);
  Logger.info(`50-SNP bloom commitment: ${hex}`);
  return bloomToBytes32(hex);
}

export async function humanmarkProveCommand(file: string, options: HumanmarkProveOptions = {}): Promise<void> {
  if (!fs.existsSync(file)) {
    Logger.error(`No such file: ${file}`);
    process.exit(1);
  }
  let snpBloom: string | undefined;
  try {
    snpBloom = await resolveSnpBloom(options);
  } catch (e) {
    Logger.error(String(e));
    process.exit(1);
  }
  const args = ['prove', file];
  if (options.biocid) args.push('--biocid', options.biocid);
  if (options.revocable) args.push('--revocable');
  if (snpBloom) args.push('--snp-bloom', snpBloom);
  if (options.out) args.push('--out', options.out);
  const code = runHumanmark(args).status;
  if (code !== 0) process.exit(code);
}

/**
 * Local attest: screen, write the C2PA assertion sidecar, emit the prove bundle.
 * Does not pull genomic bytes from a biocid (that is a biofs-node job).
 * On-chain bindContent is printed as the Bind digest; sending the tx requires
 * a deployed ConsentGrant address and a wallet, which is a separate step.
 */
export async function humanmarkAttestCommand(file: string, options: HumanmarkAttestOptions = {}): Promise<void> {
  if (file.startsWith('biocid://')) {
    Logger.error(
      'biofs attest does not pull biocid bytes onto this machine. ' +
      'Dispatch C2PA emission through biofs-node (gcsfuse) with: biofs job submit --pipeline c2pa-attest --biocid ' + file);
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    Logger.error(`No such file: ${file}`);
    process.exit(1);
  }
  const rec = screenLocalFile(file);
  if (rec.status === 'phi') {
    Logger.error(`HumanMark blocked this file (PHI/PII). Hits: ${JSON.stringify(rec.hits)}`);
    process.exit(1);
  }
  let snpBloom: string | undefined;
  try {
    snpBloom = await resolveSnpBloom({ fingerprint: options.fingerprint });
  } catch (e) {
    Logger.error(String(e));
    process.exit(1);
  }
  const biocid = options.biocid || `biocid://humanmark/local/doc/${file.split('/').pop()}`;
  const revocable = rec.status === 'genomic';
  const proveOut = options.out || `${file}.humanmark.json`;
  const proveArgs = ['prove', file, '--biocid', biocid, '--out', proveOut];
  if (revocable) proveArgs.push('--revocable');
  if (snpBloom) proveArgs.push('--snp-bloom', snpBloom);
  const prove = runHumanmark(proveArgs, false);
  if (prove.status !== 0) {
    Logger.error(prove.stderr || 'humanmark prove failed');
    process.exit(prove.status);
  }
  process.stdout.write(prove.stdout);
  if (prove.stderr) process.stderr.write(prove.stderr);
  const assertionPath = `${file}.c2pa.json`;
  if (fs.existsSync(assertionPath)) {
    Logger.success(`Sealed C2PA claim (Bind is not inside it): ${assertionPath}`);
  }
  Logger.success(`Wrote prove bundle: ${proveOut}`);
  if (options.bind) {
    await humanmarkBindCommand(file, { bundle: proveOut });
  }
}

export async function humanmarkBindCommand(file: string, options: HumanmarkBindOptions = {}): Promise<void> {
  const bundlePath = options.bundle || (file.endsWith('.humanmark.json') ? file : `${file}.humanmark.json`);
  let attestor = options.attestor;
  if (!attestor) {
    try {
      const creds = await CredentialsManager.getInstance().loadCredentials();
      attestor = creds?.wallet_address;
    } catch { /* optional */ }
  }
  if (!attestor) {
    Logger.error('Pass --attestor 0x… (the author wallet that signs Bind)');
    process.exit(2);
  }
  try {
    const result = await submitBindContent({
      bundlePath,
      sidecarPath: options.sidecar,
      attestor,
      signature: options.sig,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'bound') process.exit(result.status === 'needs_signature' ? 3 : 0);
  } catch (e) {
    Logger.error(String(e));
    process.exit(1);
  }
}

export async function humanmarkOnchainCommand(commitment: string): Promise<void> {
  const b = await readBinding(commitment);
  console.log(JSON.stringify(b, null, 2));
}
