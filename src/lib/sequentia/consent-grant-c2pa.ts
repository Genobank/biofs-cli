/**
 * ERC-8356 Content Credentials: bind a HumanMark prove bundle on Sequentia.
 * Relayer may submit; the Bind signature must be the author's.
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import { SEQUENTIA_NETWORK } from '../config/constants';
import { Logger } from '../utils/logger';

export const CONSENT_GRANT_C2PA = (
  process.env.CONSENT_GRANT_ADDRESS ||
  '0xC1F0E978FF99263ade7dC81a7E6222BBd926c025'
);

export const BIND_TYPES = {
  Bind: [
    { name: 'contentCommitment', type: 'bytes32' },
    { name: 'manifestCommitment', type: 'bytes32' },
    { name: 'biocid', type: 'string' },
    { name: 'revocable', type: 'bool' },
    { name: 'ingredientsRoot', type: 'bytes32' },
    { name: 'subjectCommit', type: 'bytes32' },
    { name: 'snpBloom', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const BIND_ABI = [
  'function bindContent(bytes32,bytes32,bytes32,bytes32,bytes32,bool,string,uint256,address,bytes,bytes32,bytes32[],bytes32)',
  'function bindNonces(bytes32) view returns (uint256)',
  'function bindings(bytes32) view returns (bytes32,bytes32,bytes32,address,uint48,bool,bytes32)',
  'function isBindingActive(bytes32) view returns (bool)',
];

export function asBytes32(v: string | undefined): string {
  if (!v) return ethers.ZeroHash;
  const s = String(v);
  if (s.startsWith('0x')) return ethers.zeroPadValue(s, 32);
  if (/^[0-9a-fA-F]{64}$/.test(s)) return '0x' + s.toLowerCase();
  return ethers.ZeroHash;
}

export function bindDomain(verifyingContract: string, chainId = SEQUENTIA_NETWORK.chainId) {
  return {
    name: 'ConsentGrant',
    version: '1',
    chainId,
    verifyingContract,
  };
}

export function bindMessageFromBundle(bundle: any, nonce: number) {
  const b = bundle.bind;
  const mc = asBytes32(b.manifest_commitment);
  if (mc === ethers.ZeroHash) {
    throw new Error(
      'Prove bundle Bind must cover a non-zero manifestCommitment. Re-prove with HumanMark 1.1 (Bind after C2PA seal).',
    );
  }
  return {
    contentCommitment: asBytes32(bundle.content_commitment),
    manifestCommitment: mc,
    biocid: b.biocid,
    revocable: !!b.revocable,
    ingredientsRoot: asBytes32(b.ingredients_root),
    subjectCommit: asBytes32(b.subject_commit),
    snpBloom: asBytes32(b.snp_bloom),
    nonce,
  };
}

export function nonceKey(attestor: string, subjectCommit: string): string {
  if (subjectCommit && subjectCommit !== ethers.ZeroHash) return subjectCommit;
  return ethers.zeroPadValue(attestor, 32);
}

export function sequentiaProvider(): ethers.JsonRpcProvider {
  const url = process.env.SEQUENTIA_RPC_URL || 'https://explorer.sequentias-test.genobank.io/rpc';
  return new ethers.JsonRpcProvider(url, SEQUENTIA_NETWORK.chainId);
}

export function loadBundle(fileOrBundle: string): any {
  if (fileOrBundle.trim().startsWith('{')) return JSON.parse(fileOrBundle);
  const p = fileOrBundle.endsWith('.humanmark.json') ? fileOrBundle : fileOrBundle + '.humanmark.json';
  if (!fs.existsSync(p)) throw new Error(`No prove bundle at ${p}. Run biofs humanmark prove first.`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function manifestCommitmentFromSidecar(sidecarPath?: string): string {
  if (!sidecarPath || !fs.existsSync(sidecarPath)) return ethers.ZeroHash;
  const bytes = fs.readFileSync(sidecarPath);
  return ethers.keccak256(ethers.sha256(bytes));
}

export async function readBinding(contentCommitment: string) {
  const cg = new ethers.Contract(CONSENT_GRANT_C2PA, BIND_ABI, sequentiaProvider());
  const b = await cg.bindings(asBytes32(contentCommitment));
  const active = await cg.isBindingActive(asBytes32(contentCommitment));
  return {
    contract: CONSENT_GRANT_C2PA,
    active,
    manifestCommitment: b[0],
    ingredientsRoot: b[1],
    snpBloom: b[2],
    attestor: b[3],
    boundAt: Number(b[4]),
    revocable: b[5],
    grantId: b[6],
  };
}

export interface BindSubmitOpts {
  bundlePath: string;
  sidecarPath?: string;
  attestor?: string;
  signature?: string;
  privateKey?: string;
  relayKey?: string;
}

export async function submitBindContent(opts: BindSubmitOpts) {
  const bundle = loadBundle(opts.bundlePath);
  const provider = sequentiaProvider();
  const cgRead = new ethers.Contract(CONSENT_GRANT_C2PA, BIND_ABI, provider);
  const attestor = ethers.getAddress(opts.attestor || bundle.author_wallet || '');
  const subjectCommit = asBytes32(bundle.bind.subject_commit);
  const nk = nonceKey(attestor, subjectCommit);
  const nonce = Number(await cgRead.bindNonces(nk));
  const msg = bindMessageFromBundle(bundle, nonce);
  const domain = bindDomain(CONSENT_GRANT_C2PA);

  let sig = opts.signature;
  const authorKey = opts.privateKey || process.env.HUMANMARK_AUTHOR_KEY || process.env.BIOFS_BIND_PRIVATE_KEY
    || process.env.SEQUENTIA_DEPLOYER_PRIVATE_KEY;
  if (!sig && authorKey) {
    const w = new ethers.Wallet(authorKey);
    if (w.address.toLowerCase() === attestor.toLowerCase()) {
      sig = await w.signTypedData(domain, BIND_TYPES, msg);
    } else if (opts.privateKey || process.env.HUMANMARK_AUTHOR_KEY || process.env.BIOFS_BIND_PRIVATE_KEY) {
      throw new Error(`Author key is ${w.address}, attestor is ${attestor}`);
    }
  }
  if (!sig) {
    return {
      status: 'needs_signature',
      contract: CONSENT_GRANT_C2PA,
      chainId: SEQUENTIA_NETWORK.chainId,
      explorer: `${SEQUENTIA_NETWORK.explorer}/HumanMark`,
      domain,
      types: BIND_TYPES,
      message: msg,
      attestor,
      note: 'Sign this Bind typed data with the author wallet, then re-run with --sig 0x… or use Bind on Sequentia on the explorer.',
    };
  }

  const recovered = ethers.verifyTypedData(domain, BIND_TYPES, msg, sig);
  if (recovered.toLowerCase() !== attestor.toLowerCase()) {
    throw new Error(`Bind sig recovers ${recovered}, expected attestor ${attestor}`);
  }

  const relayKey = opts.relayKey || process.env.SEQUENTIA_DEPLOYER_PRIVATE_KEY;
  if (!relayKey) {
    return {
      status: 'signed_not_submitted',
      signature: sig,
      recovered,
      contract: CONSENT_GRANT_C2PA,
      message: msg,
      note: 'Have a Sequentia signer submit bindContent, or set SEQUENTIA_DEPLOYER_PRIVATE_KEY as relayer.',
    };
  }

  const signer = new ethers.Wallet(relayKey, provider);
  const cg = new ethers.Contract(CONSENT_GRANT_C2PA, BIND_ABI, signer);
  const sidecar = opts.sidecarPath || opts.bundlePath.replace(/\.humanmark\.json$/, '.c2pa.json');
  if (sidecar && fs.existsSync(sidecar) && bundle.manifest_sha256) {
    const actual = ethers.sha256(fs.readFileSync(sidecar)).replace(/^0x/, '');
    if (actual !== String(bundle.manifest_sha256).toLowerCase()) {
      throw new Error('C2PA sidecar sha256 does not match the prove bundle manifest_sha256');
    }
  }
  const tx = await cg.bindContent(
    msg.contentCommitment,
    msg.manifestCommitment,
    msg.ingredientsRoot,
    msg.subjectCommit,
    msg.snpBloom,
    msg.revocable,
    msg.biocid,
    msg.nonce,
    attestor,
    sig,
    ethers.ZeroHash,
    [],
    ethers.ZeroHash,
    { gasLimit: 800_000n },
  );
  Logger.info(`bindContent tx ${tx.hash}`);
  const rc = await tx.wait();
  const bound = await readBinding(msg.contentCommitment);
  return {
    status: rc.status === 1 ? 'bound' : 'failed',
    tx: tx.hash,
    explorer: `${SEQUENTIA_NETWORK.explorer}/tx/${tx.hash}`,
    binding: bound,
  };
}
