/**
 * On-chain BioNFT client. Wraps ethers.Contract calls to the deployed
 * BioAssetVault + BioNFTCredentials on Sequentia.
 *
 * Contract addresses are the mainnet defaults; override via env:
 *   SEQUENTIA_RPC, SEQUENTIA_CHAIN_ID, BIOVAULT_VAULT_ADDRESS, BIOVAULT_CREDS_ADDRESS
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// biofs-cli compiles to CommonJS, so __dirname is always defined at runtime.
const _dirname = __dirname;

export const DEFAULT_RPC = 'https://seqrpc.genobank.app';
export const DEFAULT_CHAIN_ID = 15132025;
export const DEFAULT_VAULT_ADDR = '0x2fd98bFF77571F1338bf1F44E68b80Be77205850';
export const DEFAULT_CREDS_ADDR = '0xfbEf8e795e6306a23F16d5e0Dc480b89F1D316Bf';

// Ranges — must match the Solidity contract
export const BIOSAMPLE_PARENT_MIN = 1n;
export const BIOSAMPLE_PARENT_MAX = 1_000_000n;
export const DATA_FILE_CHILD_MIN = 1_000_001n;
export const DATA_FILE_CHILD_MAX = 2_000_000n;
export const RENT_AGREEMENT_MIN = 2_000_001n;
export const RENT_AGREEMENT_MAX = 3_000_000n;
export const INGEST_TICKET_MIN = 3_000_001n;

export type BioNFTCategory = 'BIOSAMPLE_PARENT' | 'DATA_FILE_CHILD' | 'RENT_AGREEMENT' | 'INGEST_TICKET';
export const INGEST_STATUS = ['ISSUED', 'CONSUMED', 'BURNED', 'QUARANTINED'] as const;

export function categoryOf(tokenId: bigint | number | string): BioNFTCategory {
  const id = typeof tokenId === 'bigint' ? tokenId : BigInt(tokenId);
  if (id <= BIOSAMPLE_PARENT_MAX) return 'BIOSAMPLE_PARENT';
  if (id <= DATA_FILE_CHILD_MAX) return 'DATA_FILE_CHILD';
  if (id <= RENT_AGREEMENT_MAX) return 'RENT_AGREEMENT';
  return 'INGEST_TICKET';
}

export interface BioNFTClientConfig {
  rpc?: string;
  chainId?: number;
  vaultAddress?: string;
  credsAddress?: string;
  privateKey?: string;      // optional — reads BIOFS_OWNER_PRIVATE_KEY / GENOBANK_OWNER_PRIVATE_KEY if omitted
  readOnly?: boolean;       // if true, skip signer init
}

function loadAbi(name: string): any[] {
  const candidates = [
    path.resolve(_dirname, `${name}.abi.json`),
    path.resolve(_dirname, `../../lib/bionft/${name}.abi.json`),
    path.resolve(_dirname, `../lib/bionft/${name}.abi.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error(`BioNFT ABI not found: ${name}.abi.json (looked in ${candidates.join(', ')})`);
}

export interface BioNFTClient {
  provider: ethers.JsonRpcProvider;
  signer: ethers.Wallet | null;
  vault: ethers.Contract;
  creds: ethers.Contract;
  address: string | null;
}

export function createBioNFTClient(config: BioNFTClientConfig = {}): BioNFTClient {
  const rpc = config.rpc || process.env.SEQUENTIA_RPC || DEFAULT_RPC;
  const chainId = config.chainId || parseInt(process.env.SEQUENTIA_CHAIN_ID || String(DEFAULT_CHAIN_ID), 10);
  const vaultAddr = config.vaultAddress || process.env.BIOVAULT_VAULT_ADDRESS || DEFAULT_VAULT_ADDR;
  const credsAddr = config.credsAddress || process.env.BIOVAULT_CREDS_ADDRESS || DEFAULT_CREDS_ADDR;

  // Pass a proper Network so ethers doesn't auto-detect at every call. Using
  // the Network.from({...}) form is the v6 idiom; the anonymous-object form
  // ({chainId, name}) triggers a "network changed" error on the second call.
  const network = ethers.Network.from({ chainId, name: 'sequentia' });
  const provider = new ethers.JsonRpcProvider(rpc, network, { staticNetwork: network });

  let signer: ethers.Wallet | null = null;
  if (!config.readOnly) {
    const key = config.privateKey
      || process.env.BIOFS_OWNER_PRIVATE_KEY
      || process.env.GENOBANK_OWNER_PRIVATE_KEY;
    if (key) {
      const normalized = key.startsWith('0x') ? key : '0x' + key;
      signer = new ethers.Wallet(normalized, provider);
    }
  }

  const vaultAbi = loadAbi('BioAssetVault');
  const credsAbi = loadAbi('BioNFTCredentials');
  const vault = new ethers.Contract(vaultAddr, vaultAbi, signer || provider);
  const creds = new ethers.Contract(credsAddr, credsAbi, signer || provider);
  return { provider, signer, vault, creds, address: signer?.address ?? null };
}

// ─── Read helpers (read-only — no signer needed) ────────────────────────────

export async function getRentAgreement(client: BioNFTClient, tokenId: bigint): Promise<any> {
  const r = await client.creds.rentAgreements(tokenId);
  return {
    biosampleTokenId: r[0],
    patient: r[1],
    custodian: r[2],
    metadataURI: r[3],
    issuedAt: r[4],
    expiresAt: r[5],
    active: r[6],
  };
}

export async function getIngestTicket(client: BioNFTClient, tokenId: bigint): Promise<any> {
  const r = await client.creds.ingestTickets(tokenId);
  return {
    rentAgreementTokenId: r[0],
    patient: r[1],
    custodian: r[2],
    fileKind: Number(r[3]),
    expectedSize: r[4],
    sha256Claimed: r[5],
    objectPathHash: r[6],
    actualSize: r[7],
    sha256Computed: r[8],
    dataFileTokenId: r[9],
    metadataURI: r[10],
    issuedAt: r[11],
    finalizedAt: r[12],
    status: INGEST_STATUS[Number(r[13])] ?? `UNKNOWN(${r[13]})`,
    statusCode: Number(r[13]),
  };
}

export async function getChildBioAsset(client: BioNFTClient, tokenId: bigint): Promise<any> {
  const r = await client.vault.children(tokenId);
  return {
    parentTokenId: r[0],
    fileType: Number(r[1]),
    fileSize: r[2],
    referenceGenome: r[3],
    variantCount: r[4],
    annotatorCount: r[5],
    isSomatic: r[6],
    rarityScore: Number(r[7]),
    coverageDepth: r[8],
    contentHash: r[9],
    pipeline: r[10],
    lastRevaluation: r[11],
    active: r[12],
  };
}

export async function getParentBioAsset(client: BioNFTClient, tokenId: bigint): Promise<any> {
  const r = await client.vault.parents(tokenId);
  return {
    biosampleSerial: r[0],
    assetOwner: r[1],
    totalBiodataValue: r[2],
    createdAt: r[3],
    active: r[4],
  };
}

// ─── Write helpers (signer required) ───────────────────────────────────────

async function _sendWrite(
  client: BioNFTClient,
  populated: ethers.ContractTransaction,
  chainId: number,
): Promise<ethers.TransactionReceipt | null> {
  // Explicitly populate chainId + gas fields so the Wallet signs with the
  // correct chainId. ethers v6 sometimes probes chainId lazily which produces
  // a wrong-chainId signed tx against custom RPCs.
  const signer = client.signer!;
  const gasPrice = 20n * 10n ** 9n;
  const req: ethers.TransactionRequest = {
    to: populated.to,
    data: populated.data,
    value: populated.value ?? 0,
    chainId,
    gasPrice,
    gasLimit: 500_000,
    nonce: await client.provider.getTransactionCount(signer.address),
  };
  const signed = await signer.signTransaction(req);
  const tx = await client.provider.broadcastTransaction(signed);
  return await tx.wait();
}

async function _resolveChainId(client: BioNFTClient): Promise<number> {
  // Directly query the RPC for eth_chainId — bypasses ethers' internal cache
  // which has been observed to report a stale 262144 on some Sequentia calls.
  const hex = await client.provider.send('eth_chainId', []);
  return parseInt(String(hex), 16);
}

export async function burnIngestTicket(
  client: BioNFTClient,
  tokenId: bigint,
  reason: string,
): Promise<ethers.TransactionReceipt | null> {
  if (!client.signer) throw new Error('signer required — set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY');
  const chainId = await _resolveChainId(client);
  const populated = await client.creds.burnIngestTicket.populateTransaction(tokenId, reason);
  return await _sendWrite(client, populated, chainId);
}

export async function revokeRentAgreement(
  client: BioNFTClient,
  tokenId: bigint,
  reason: string,
): Promise<ethers.TransactionReceipt | null> {
  if (!client.signer) throw new Error('signer required — set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY');
  const chainId = await _resolveChainId(client);
  const populated = await client.creds.revokeRentAgreement.populateTransaction(tokenId, reason);
  return await _sendWrite(client, populated, chainId);
}
