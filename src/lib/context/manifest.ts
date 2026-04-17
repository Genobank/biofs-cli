/**
 * BioContext manifest lib — EIP-712 typed data, Merkle proofs, signing, verification.
 * Used by `biofs context {create,publish,verify,revoke}`.
 *
 * Schema MUST match:
 *   - biorouter: /home/danieluribe/biorouter/api_biorouter.py (_EIP712_TYPES)
 *   - mcp-bio-context: @genobank/mcp-bio-context src/index.ts
 */

import { ethers } from 'ethers';
import { createHash } from 'crypto';

export const SEQUENTIA_CHAIN_ID = 15132025;
export const BIODATA_ROUTER_ADDRESS =
  '0x678d668ECAB612390bF60F6eB04d9e9f5398f2F3';

import type { TypedDataDomain, TypedDataField } from 'ethers';

export const EIP712_DOMAIN: TypedDataDomain = {
  name: 'GenoBank-BioContext',
  version: '1',
  chainId: SEQUENTIA_CHAIN_ID,
  verifyingContract: BIODATA_ROUTER_ADDRESS,
};

export const EIP712_TYPES: Record<string, TypedDataField[]> = {
  BioContext: [
    { name: 'caseId',          type: 'string'  },
    { name: 'kind',            type: 'string'  },
    { name: 'owner',           type: 'address' },
    { name: 'agentId',         type: 'string'  },
    { name: 'consent',         type: 'Consent' },
    { name: 'skillsAllowHash', type: 'bytes32' },
    { name: 'skillsDenyHash',  type: 'bytes32' },
    { name: 'assetsRoot',      type: 'bytes32' },
    { name: 'narrativeHash',   type: 'bytes32' },
    { name: 'loaderEndpoint',  type: 'string'  },
    { name: 'nonce',           type: 'uint256' },
    { name: 'deadline',        type: 'uint256' },
  ],
  Consent: [
    { name: 'bioPilId',           type: 'uint8'   },
    { name: 'commercial',         type: 'bool'    },
    { name: 'expiresAt',          type: 'uint64'  },
    { name: 'deniedPurposesHash', type: 'bytes32' },
  ],
};

// ─── Types ──────────────────────────────────────────────────────────
export type FileType =
  | 'vcf' | 'bam' | 'fastq' | 'sqlite' | 'fhir'
  | 'dtc-genotype' | 'ancestry-result' | 'clinical-report' | 'pdf' | 'generic';

export interface BioAsset {
  biocid: string;
  fileType: FileType;
  labPermittee: string;
  contentHash: string;   // 0x + 64 hex
  sizeBytes: number;
  streamOnly: boolean;
}

export interface Consent {
  bioPilId: number;       // 1..9
  commercial: boolean;
  expiresAt: number;      // unix seconds
  deniedPurposes: string[];
}

export interface BioContextInput {
  caseId: string;
  kind?: string;
  owner: string;
  agentId?: string;
  consent: Consent;
  skillsAllow: string[];
  skillsDeny: string[];
  assets: BioAsset[];
  narrativeText: string;
  nonce?: number;
  deadline?: number;
}

export interface SignedManifest {
  '@context': string;
  domain: TypedDataDomain;
  primaryType: 'BioContext';
  message: {
    caseId: string;
    kind: string;
    owner: string;
    agentId: string;
    consent: {
      bioPilId: number;
      commercial: boolean;
      expiresAt: number;
      deniedPurposesHash: string;
    };
    skillsAllowHash: string;
    skillsDenyHash: string;
    assetsRoot: string;
    narrativeHash: string;
    loaderEndpoint: string;
    nonce: number;
    deadline: number;
  };
  assets: (BioAsset & { merkleProof: string[] })[];
  skillsAllow: string[];
  skillsDeny: string[];
  deniedPurposes: string[];
  narrative: string;
  signature: string;
}

// ─── Hashing ────────────────────────────────────────────────────────
const sha256 = (buf: Buffer | string) =>
  createHash('sha256').update(buf).digest();

const sha256Hex = (buf: Buffer | string) =>
  '0x' + sha256(buf).toString('hex');

export function hashStringArray(arr: string[]): string {
  const sorted = [...arr].sort();
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(sorted)));
}

export function narrativeHash(text: string): string {
  return sha256Hex(text);
}

function leafHash(a: BioAsset): string {
  const canon = JSON.stringify({
    biocid: a.biocid,
    contentHash: a.contentHash,
    fileType: a.fileType,
    labPermittee: a.labPermittee,
    sizeBytes: a.sizeBytes,
    streamOnly: a.streamOnly,
  });
  return sha256(canon).toString('hex');
}

export function buildMerkleTree(
  assets: BioAsset[]
): { root: string; proofs: string[][] } {
  if (assets.length === 0) {
    return { root: '0x' + '0'.repeat(64), proofs: [] };
  }
  const leaves = assets.map(leafHash);
  const proofs: string[][] = assets.map(() => []);
  let level = [...leaves];
  let pos = leaves.map((_, i) => i);

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const L = level[i];
      const R = i + 1 < level.length ? level[i + 1] : L;
      next.push(
        sha256(
          Buffer.concat([Buffer.from(L, 'hex'), Buffer.from(R, 'hex')])
        ).toString('hex')
      );
      for (let li = 0; li < assets.length; li++) {
        if (pos[li] === i) proofs[li].push('0x' + R);
        else if (pos[li] === i + 1) proofs[li].push('0x' + L);
      }
    }
    level = next;
    pos = pos.map(p => Math.floor(p / 2));
  }
  return { root: '0x' + level[0], proofs };
}

export function verifyMerkleProof(
  asset: BioAsset,
  proof: string[],
  root: string
): boolean {
  let h = leafHash(asset);
  for (const sibling of proof) {
    const sib = sibling.replace(/^0x/, '');
    const asLeft = sha256(
      Buffer.concat([Buffer.from(h, 'hex'), Buffer.from(sib, 'hex')])
    ).toString('hex');
    const asRight = sha256(
      Buffer.concat([Buffer.from(sib, 'hex'), Buffer.from(h, 'hex')])
    ).toString('hex');
    h = h < sib ? asLeft : asRight;
  }
  return '0x' + h === root;
}

// ─── Build + sign ───────────────────────────────────────────────────
export async function buildManifest(
  input: BioContextInput,
  signer: ethers.Signer
): Promise<SignedManifest> {
  const kind = input.kind || 'CancerDigitalTwin';
  const agentId = input.agentId || 'user';
  const nonce = input.nonce ?? 0;
  const deadline =
    input.deadline ?? Math.floor(Date.now() / 1000) + 30 * 86400;

  const { root: assetsRoot, proofs } = buildMerkleTree(input.assets);
  const skillsAllowHash = hashStringArray(input.skillsAllow);
  const skillsDenyHash = hashStringArray(input.skillsDeny);
  const deniedPurposesHash = hashStringArray(input.consent.deniedPurposes);
  const nh = narrativeHash(input.narrativeText);

  const message = {
    caseId: input.caseId,
    kind,
    owner: ethers.getAddress(input.owner),
    agentId,
    consent: {
      bioPilId: input.consent.bioPilId,
      commercial: input.consent.commercial,
      expiresAt: input.consent.expiresAt,
      deniedPurposesHash,
    },
    skillsAllowHash,
    skillsDenyHash,
    assetsRoot,
    narrativeHash: nh,
    loaderEndpoint: 'https://biorouter.genobank.app/api_biorouter',
    nonce,
    deadline,
  };

  const signature = await signer.signTypedData(
    EIP712_DOMAIN,
    EIP712_TYPES,
    message
  );

  return {
    '@context': 'https://genobank.io/schemas/bio-context/v1',
    domain: EIP712_DOMAIN,
    primaryType: 'BioContext',
    message,
    assets: input.assets.map((a, i) => ({ ...a, merkleProof: proofs[i] })),
    skillsAllow: input.skillsAllow,
    skillsDeny: input.skillsDeny,
    deniedPurposes: input.consent.deniedPurposes,
    narrative: input.narrativeText,
    signature,
  };
}

// ─── Verify ─────────────────────────────────────────────────────────
export interface VerifyResult {
  verified: boolean;
  errors: string[];
  recovered?: string;
}

export function verifyManifest(m: SignedManifest): VerifyResult {
  const errors: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  if (m.message.deadline < now) {
    errors.push(`manifest expired (deadline ${m.message.deadline} < now ${now})`);
  }
  if (hashStringArray(m.skillsAllow) !== m.message.skillsAllowHash) {
    errors.push('skillsAllow hash mismatch');
  }
  if (hashStringArray(m.skillsDeny) !== m.message.skillsDenyHash) {
    errors.push('skillsDeny hash mismatch');
  }
  if (hashStringArray(m.deniedPurposes) !== m.message.consent.deniedPurposesHash) {
    errors.push('deniedPurposes hash mismatch');
  }
  if (narrativeHash(m.narrative) !== m.message.narrativeHash) {
    errors.push('narrativeHash mismatch — .bio.md may be tampered');
  }
  for (const asset of m.assets) {
    if (!verifyMerkleProof(asset, asset.merkleProof, m.message.assetsRoot)) {
      errors.push(`merkleProof failed for ${asset.biocid}`);
    }
  }
  let recovered: string | undefined;
  try {
    recovered = ethers.verifyTypedData(
      m.domain,
      EIP712_TYPES,
      m.message,
      m.signature
    );
    if (recovered.toLowerCase() !== m.message.owner.toLowerCase()) {
      errors.push(`signer ${recovered} != owner ${m.message.owner}`);
    }
  } catch (e: any) {
    errors.push(`signature verify threw: ${e.message}`);
  }
  return { verified: errors.length === 0, errors, recovered };
}

export async function hashLocalFile(filePath: string): Promise<string> {
  const fs = await import('fs');
  const stream = fs.createReadStream(filePath);
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return '0x' + hash.digest('hex');
}
