import { ethers } from 'ethers';
import { Logger } from '../utils/logger';
import { CredentialsManager } from '../auth/credentials';
import { CONFIG } from '../config/constants';
import { createHash } from 'crypto';
import { calculateSnpFingerprint } from '../biofiles/fingerprint';
import { existsSync } from 'fs';

const BIOROUTES_ADDRESS = '0xF758e2b3c4774F0f7e7D95eAa4c265b258d14bAD';
const SEQUENTIA_RPC = 'https://seqrpc.genobank.app';
const CHAIN_ID = 15132025;

const BIOROUTES_ABI = [
  'function getRouteCount(bytes32 biocidKey) view returns (uint256)',
  'function routesFor(bytes32, uint256) view returns (bytes32 contentHash, string storageURI, uint8 tier, address registeredBy, uint64 registeredAt, uint64 lastVerifiedAt, uint8 status)',
  'function isStale(bytes32 biocidKey, uint256 idx) view returns (bool)',
  'function getRoute(bytes32 biocidKey, uint256 idx) view returns (tuple(bytes32 contentHash, string storageURI, uint8 tier, address registeredBy, uint64 registeredAt, uint64 lastVerifiedAt, uint8 status))',
  'function verifyRoute(bytes32 biocidKey, uint256 routeIndex, bytes32 observedHash)',
  'function disputeRoute(bytes32 biocidKey, uint256 routeIndex, tuple(string storageURI, bytes32 claimedHash, bytes32 observedHash, uint256 byteRangeStart, uint256 byteRangeEnd, bytes32 sampleHash) proof) returns (uint256)',
  'function registerRoute(bytes32 biocidKey, string storageURI, uint8 tier, bytes32 contentHash) returns (uint256)',
  'function migrateRoute(bytes32 biocidKey, uint256 oldRouteIndex, string newStorageURI, bytes32 contentHash) returns (uint256)',
  'function decommissionRoute(bytes32 biocidKey, uint256 routeIndex, string reason)',
  'event RouteRegistered(bytes32 indexed biocidKey, uint256 routeIndex, string storageURI, uint8 tier, bytes32 contentHash, address registeredBy)',
  'event RouteMigrated(bytes32 indexed biocidKey, uint256 oldRouteIndex, uint256 newRouteIndex, string fromURI, string toURI, bytes32 contentHash)',
  'event RouteVerified(bytes32 indexed biocidKey, uint256 routeIndex, bytes32 observedHash)',
  'event RouteDisputed(bytes32 indexed biocidKey, uint256 routeIndex, uint256 disputeId, address disputer, bytes32 observedHash, bytes32 sampleHash)',
  'event RouteDecommissioned(bytes32 indexed biocidKey, uint256 routeIndex, string reason)',
];

export enum RouteTier {
  PRIMARY = 0,
  SECONDARY = 1,
  ARCHIVE = 2,
  MIRROR = 3,
}

export enum RouteStatus {
  ACTIVE = 0,
  STALE = 1,
  DISPUTED = 2,
  UNREACHABLE = 3,
  DECOMMISSIONED = 4,
}

const TIER_LABELS: Record<number, string> = {
  0: 'PRIMARY',
  1: 'SECONDARY',
  2: 'ARCHIVE',
  3: 'MIRROR',
};

const STATUS_LABELS: Record<number, string> = {
  0: 'ACTIVE',
  1: 'STALE',
  2: 'DISPUTED',
  3: 'UNREACHABLE',
  4: 'DECOMMISSIONED',
};

export interface OnChainRoute {
  contentHash: string;
  storageURI: string;
  tier: number;
  tierLabel: string;
  registeredBy: string;
  registeredAt: number;
  lastVerifiedAt: number;
  status: number;
  statusLabel: string;
  index: number;
}

export interface ResolveResult {
  biocidKey: string;
  routeCount: number;
  routes: OnChainRoute[];
  primary: OnChainRoute | null;
  contentHash: string | null;
  lastVerifiedAt: number | null;
}

export function biocidToKey(biocid: string): string {
  return '0x' + createHash('sha256').update(biocid).digest('hex');
}

function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(SEQUENTIA_RPC, CHAIN_ID, {
    staticNetwork: true,
  });
}

function getContract(signerOrProvider?: ethers.Signer | ethers.Provider): ethers.Contract {
  const p = signerOrProvider || getProvider();
  return new ethers.Contract(BIOROUTES_ADDRESS, BIOROUTES_ABI, p);
}

export interface MismatchProof {
  storageURI: string;
  claimedHash: string;
  observedHash: string;
  byteRangeStart: number;
  byteRangeEnd: number;
  sampleHash: string;
}

export interface VerifyLocalResult {
  match: boolean;
  onChainHash: string;
  localFingerprint: string;
  biocidKey: string;
}

export interface DisputeResult {
  txHash: string;
  disputeId: number;
  biocidKey: string;
  routeIndex: number;
}

export class BioRoutesClient {
  private contract: ethers.Contract;
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet | null;

  constructor(signerOrKey?: ethers.Signer | string) {
    this.provider = getProvider();

    if (typeof signerOrKey === 'string') {
      const normalized = signerOrKey.startsWith('0x') ? signerOrKey : '0x' + signerOrKey;
      this.signer = new ethers.Wallet(normalized, this.provider);
    } else if (signerOrKey) {
      this.signer = null;
      this.contract = getContract(signerOrKey);
      return;
    } else {
      const key = process.env.BIOFS_OWNER_PRIVATE_KEY || process.env.GENOBANK_OWNER_PRIVATE_KEY;
      this.signer = key ? new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key, this.provider) : null;
    }

    this.contract = getContract(this.signer || this.provider);
  }

  get signerAddress(): string | null {
    return this.signer?.address ?? null;
  }

  hasSigner(): boolean {
    return this.signer !== null;
  }

  async resolveBiocid(biocid: string): Promise<ResolveResult> {
    const biocidKey = biocidToKey(biocid);
    const count: bigint = await this.contract.getRouteCount(biocidKey);
    const routeCount = Number(count);

    const routes: OnChainRoute[] = [];
    for (let i = 0; i < routeCount; i++) {
      const r = await this.contract.routesFor(biocidKey, i);
      routes.push({
        contentHash: r[0],
        storageURI: r[1],
        tier: Number(r[2]),
        tierLabel: TIER_LABELS[Number(r[2])] || `UNKNOWN(${r[2]})`,
        registeredBy: r[3],
        registeredAt: Number(r[4]),
        lastVerifiedAt: Number(r[5]),
        status: Number(r[6]),
        statusLabel: STATUS_LABELS[Number(r[6])] || `UNKNOWN(${r[6]})`,
        index: i,
      });
    }

    // Sort: ACTIVE first, then by tier (PRIMARY first), then by freshness
    routes.sort((a, b) => {
      if (a.status !== b.status) return a.status - b.status;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.registeredAt - a.registeredAt;
    });

    const primary = routes.find(r => r.status === RouteStatus.ACTIVE) || null;

    return {
      biocidKey,
      routeCount,
      routes,
      primary,
      contentHash: primary?.contentHash || null,
      lastVerifiedAt: primary?.lastVerifiedAt || null,
    };
  }

  async resolveByKey(biocidKeyHex: string): Promise<ResolveResult> {
    const biocidKey = biocidKeyHex.startsWith('0x') ? biocidKeyHex : '0x' + biocidKeyHex;
    const count: bigint = await this.contract.getRouteCount(biocidKey);
    const routeCount = Number(count);

    const routes: OnChainRoute[] = [];
    for (let i = 0; i < routeCount; i++) {
      const r = await this.contract.routesFor(biocidKey, i);
      routes.push({
        contentHash: r[0],
        storageURI: r[1],
        tier: Number(r[2]),
        tierLabel: TIER_LABELS[Number(r[2])] || `UNKNOWN(${r[2]})`,
        registeredBy: r[3],
        registeredAt: Number(r[4]),
        lastVerifiedAt: Number(r[5]),
        status: Number(r[6]),
        statusLabel: STATUS_LABELS[Number(r[6])] || `UNKNOWN(${r[6]})`,
        index: i,
      });
    }

    routes.sort((a, b) => {
      if (a.status !== b.status) return a.status - b.status;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return b.registeredAt - a.registeredAt;
    });

    const primary = routes.find(r => r.status === RouteStatus.ACTIVE) || null;

    return {
      biocidKey,
      routeCount,
      routes,
      primary,
      contentHash: primary?.contentHash || null,
      lastVerifiedAt: primary?.lastVerifiedAt || null,
    };
  }

  async resolveByFingerprint(contentHashHex: string): Promise<ResolveResult | null> {
    const apiBase = CONFIG.API_BASE_URL;
    const creds = await CredentialsManager.getInstance().loadCredentials();
    if (!creds) return null;

    try {
      const axios = (await import('axios')).default;
      const resp = await axios.get(`${apiBase}/api_bioroutes/resolve`, {
        params: {
          content_hash: contentHashHex,
          user_signature: creds.user_signature,
        },
        timeout: 15000,
      });
      if (resp.data?.biocid_key) {
        return this.resolveByKey(resp.data.biocid_key);
      }
    } catch {
      Logger.debug('api_bioroutes/resolve fingerprint lookup failed, falling back to chain scan');
    }
    return null;
  }

  async getPresignedUrl(storageURI: string): Promise<string | null> {
    const apiBase = CONFIG.API_BASE_URL;
    const creds = await CredentialsManager.getInstance().loadCredentials();
    if (!creds) return null;

    try {
      const axios = (await import('axios')).default;

      if (storageURI.startsWith('gs://')) {
        const parts = storageURI.replace('gs://', '').split('/');
        const bucket = parts[0];
        const objectName = parts.slice(1).join('/');
        const resp = await axios.get(`${apiBase}/api_bioip/get_presigned_link`, {
          params: {
            user_signature: creds.user_signature,
            bucket,
            file_path: objectName,
          },
          timeout: 15000,
        });
        if (resp.data?.presigned_url) return resp.data.presigned_url;
        if (resp.data?.url) return resp.data.url;
      }

      const resp = await axios.get(
        `${apiBase}/api_vcf_annotator/stream_s3_file`,
        {
          params: {
            user_signature: creds.user_signature,
            file_path: storageURI,
          },
          timeout: 15000,
          maxRedirects: 0,
          validateStatus: (s: number) => s < 400,
        }
      );
      return resp.request?.res?.responseUrl || resp.config.url || null;
    } catch {
      return null;
    }
  }

  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  async verifyLocalFile(biocid: string, localFilePath: string): Promise<VerifyLocalResult> {
    if (!existsSync(localFilePath)) {
      throw new Error(`Local file not found: ${localFilePath}`);
    }

    const result = await this.resolveBiocid(biocid);
    if (!result.primary) {
      throw new Error(`No active route found for: ${biocid}`);
    }

    const onChainHash = result.primary.contentHash;
    const { fingerprint } = await calculateSnpFingerprint(localFilePath);
    const localHash = '0x' + fingerprint;

    return {
      match: onChainHash.toLowerCase() === localHash.toLowerCase(),
      onChainHash,
      localFingerprint: localHash,
      biocidKey: result.biocidKey,
    };
  }

  async verifyRoute(biocidKey: string, routeIndex: number, observedHash: string): Promise<string> {
    if (!this.signer) {
      throw new Error(
        'On-chain verifyRoute requires a signer. Set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY.'
      );
    }
    const key = biocidKey.startsWith('0x') ? biocidKey : '0x' + biocidKey;
    const hash = observedHash.startsWith('0x') ? observedHash : '0x' + observedHash;
    const tx = await this.contract.verifyRoute(key, routeIndex, hash);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async disputeRoute(biocidKey: string, routeIndex: number, proof: MismatchProof): Promise<DisputeResult> {
    if (!this.signer) {
      throw new Error(
        'On-chain disputeRoute requires a signer. Set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY.'
      );
    }
    const key = biocidKey.startsWith('0x') ? biocidKey : '0x' + biocidKey;
    const proofTuple = {
      storageURI: proof.storageURI,
      claimedHash: proof.claimedHash.startsWith('0x') ? proof.claimedHash : '0x' + proof.claimedHash,
      observedHash: proof.observedHash.startsWith('0x') ? proof.observedHash : '0x' + proof.observedHash,
      byteRangeStart: proof.byteRangeStart,
      byteRangeEnd: proof.byteRangeEnd,
      sampleHash: proof.sampleHash.startsWith('0x') ? proof.sampleHash : '0x' + proof.sampleHash,
    };
    const tx = await this.contract.disputeRoute(key, routeIndex, proofTuple);
    const receipt = await tx.wait();

    const disputeEvent = receipt.logs.find((log: any) => {
      try {
        const parsed = this.contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
        return parsed?.name === 'RouteDisputed';
      } catch { return false; }
    });

    let disputeId = 0;
    if (disputeEvent) {
      const parsed = this.contract.interface.parseLog({ topics: disputeEvent.topics as string[], data: disputeEvent.data });
      disputeId = Number(parsed!.args[2]);
    }

    return { txHash: receipt.hash, disputeId, biocidKey: key, routeIndex };
  }

  async registerRoute(biocidKey: string, storageURI: string, tier: RouteTier, contentHash: string): Promise<string> {
    if (!this.signer) {
      throw new Error(
        'On-chain registerRoute requires a signer. Set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY.'
      );
    }
    const key = biocidKey.startsWith('0x') ? biocidKey : '0x' + biocidKey;
    const hash = contentHash.startsWith('0x') ? contentHash : '0x' + contentHash;
    const tx = await this.contract.registerRoute(key, storageURI, tier, hash);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async migrateRoute(biocidKey: string, oldRouteIndex: number, newStorageURI: string, contentHash: string): Promise<string> {
    if (!this.signer) {
      throw new Error(
        'On-chain migrateRoute requires a signer. Set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY.'
      );
    }
    const key = biocidKey.startsWith('0x') ? biocidKey : '0x' + biocidKey;
    const hash = contentHash.startsWith('0x') ? contentHash : '0x' + contentHash;
    const tx = await this.contract.migrateRoute(key, oldRouteIndex, newStorageURI, hash);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async decommissionRoute(biocidKey: string, routeIndex: number, reason: string): Promise<string> {
    if (!this.signer) {
      throw new Error(
        'On-chain decommissionRoute requires a signer. Set BIOFS_OWNER_PRIVATE_KEY or GENOBANK_OWNER_PRIVATE_KEY.'
      );
    }
    const key = biocidKey.startsWith('0x') ? biocidKey : '0x' + biocidKey;
    const tx = await this.contract.decommissionRoute(key, routeIndex, reason);
    const receipt = await tx.wait();
    return receipt.hash;
  }
}
