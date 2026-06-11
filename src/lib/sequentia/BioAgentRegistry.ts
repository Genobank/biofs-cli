/**
 * BioAgentRegistry — ERC-8004 AI Agent Identity + Reputation Registry (Sequentia)
 *
 * Thin ethers v6 wrapper over the deployed BioAgentRegistry contract
 * (0x24e634E570Ca8aE366aF4ae8861492a1e9B06B6B on Sequentia chain 15132025).
 *
 * The contract implements the ERC-8004 Identity Registry + Reputation Registry
 * and the x402 payment-proof flow:
 *   - register(agentURI, supportedFormats, x402Enabled)  → one agent per wallet
 *   - requestBioAssetAccess(bioipId, paymentMethod)      → initiates x402 access
 *   - submitPaymentProof(bioipId, txHash, chainId, usdc) → records a payment
 *   - getAgent(agentId) / walletToAgent(wallet)          → discovery (read-only)
 *
 * Two modes:
 *   - read-only:  new BioAgentRegistry()            (provider only — getAgent/walletToAgent)
 *   - signing:    new BioAgentRegistry(privateKey)  (register / submitPaymentProof)
 *
 * The deployer/operator is the contract owner (verifyPayment is onlyOwner). Each
 * agent registers ITSELF (register() is msg.sender-bound), so register() must be
 * called from the agent's own wallet key.
 */

import { ethers } from 'ethers';
import * as path from 'path';
import { SEQUENTIA_NETWORK } from '../config/constants';
import { Logger } from '../utils/logger';

// Deployed on Sequentia (biorouter-contracts/deployed-addresses.json, chain 15132025).
export const BIOAGENT_REGISTRY_ADDRESS =
  process.env.BIOAGENT_REGISTRY_ADDRESS || '0x24e634E570Ca8aE366aF4ae8861492a1e9B06B6B';

// Minimal ABI (human-readable). Loaded from src/abi/sequentia so the build step
// copies it into dist alongside the other Sequentia ABIs.
const REGISTRY_ABI: string[] = require(path.join(__dirname, '../../abi/sequentia/BioAgentRegistry.json'));

export interface AgentRecord {
  agentId: number;
  agentURI: string;
  agentWallet: string;
  x402Enabled: boolean;
  totalSpent: string; // BIOIP (18 dec) formatted
  reputationScore: number;
  active: boolean;
}

export interface PaymentProofResult {
  paymentId: number | null;
  bioipId: string;
  paymentTxHash: string;
  chainId: number;
  usdcAmount: string; // 6-dec USDC, formatted
  proofTxHash: string;
}

export class BioAgentRegistry {
  readonly provider: ethers.JsonRpcProvider;
  readonly signer: ethers.Wallet | null;
  readonly contract: ethers.Contract;
  readonly address: string;

  constructor(privateKey?: string) {
    const rpc = process.env.SEQUENTIA_RPC_URL || SEQUENTIA_NETWORK.rpc;
    this.provider = new ethers.JsonRpcProvider(rpc);
    this.address = BIOAGENT_REGISTRY_ADDRESS;
    if (privateKey) {
      const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      this.signer = new ethers.Wallet(pk, this.provider);
      this.contract = new ethers.Contract(this.address, REGISTRY_ABI, this.signer);
    } else {
      this.signer = null;
      this.contract = new ethers.Contract(this.address, REGISTRY_ABI, this.provider);
    }
  }

  get walletAddress(): string | null {
    return this.signer ? this.signer.address : null;
  }

  /** agentId for a wallet (0 = not registered). Read-only. */
  async agentIdOf(wallet: string): Promise<number> {
    const id: bigint = await this.contract.walletToAgent(ethers.getAddress(wallet));
    return Number(id);
  }

  /** Full agent record by id, or null if id is 0 / unregistered. Read-only. */
  async getAgent(agentId: number): Promise<AgentRecord | null> {
    if (!agentId) return null;
    const a = await this.contract.getAgent(agentId);
    return {
      agentId,
      agentURI: a.agentURI,
      agentWallet: a.agentWallet,
      x402Enabled: a.x402Enabled,
      totalSpent: ethers.formatUnits(a.totalSpent, 18),
      reputationScore: Number(a.reputationScore),
      active: a.active,
    };
  }

  /** Convenience: resolve an agent record straight from its wallet. */
  async getAgentByWallet(wallet: string): Promise<AgentRecord | null> {
    const id = await this.agentIdOf(wallet);
    return id ? this.getAgent(id) : null;
  }

  /**
   * Register the signing wallet as an ERC-8004 agent. Idempotent: returns the
   * existing agentId if already registered (the contract reverts on re-register,
   * so we pre-check walletToAgent).
   */
  async register(
    agentURI: string,
    supportedFormats: string[],
    x402Enabled = true,
  ): Promise<{ agentId: number; txHash: string | null; alreadyRegistered: boolean }> {
    if (!this.signer) throw new Error('BioAgentRegistry.register requires a private key (signing mode)');
    const existing = await this.agentIdOf(this.signer.address);
    if (existing > 0) {
      Logger.debug(`agent ${this.signer.address} already registered as #${existing}`);
      return { agentId: existing, txHash: null, alreadyRegistered: true };
    }
    const tx = await this.contract.register(agentURI, supportedFormats, x402Enabled);
    const receipt = await tx.wait();
    const agentId = await this.agentIdOf(this.signer.address);
    return { agentId, txHash: receipt?.hash || tx.hash, alreadyRegistered: false };
  }

  /**
   * Record an x402 payment proof against a BioAsset. msg.sender must be a
   * registered agent (the agent submits proof that it was paid usdcAmount over
   * the dataset identified by bioipId; paymentTxHash is the seqUSDC settlement).
   *
   * bioipId here is the PUBLIC asset identifier keccak256(biocid) — distinct from
   * the salted consent bioipId, which only the BioRouter server can derive.
   */
  async submitPaymentProof(
    bioipId: string,
    paymentTxHash: string,
    chainId: number,
    usdcAmount6dec: bigint,
  ): Promise<PaymentProofResult> {
    if (!this.signer) throw new Error('submitPaymentProof requires a private key (signing mode)');
    const tx = await this.contract.submitPaymentProof(bioipId, paymentTxHash, chainId, usdcAmount6dec);
    const receipt = await tx.wait();
    let paymentId: number | null = null;
    try {
      for (const lg of receipt?.logs || []) {
        const parsed = this.contract.interface.parseLog({ topics: lg.topics as string[], data: lg.data });
        if (parsed?.name === 'PaymentProofSubmitted') {
          paymentId = Number(parsed.args.paymentId);
          break;
        }
      }
    } catch { /* best-effort event parse */ }
    return {
      paymentId,
      bioipId,
      paymentTxHash,
      chainId,
      usdcAmount: ethers.formatUnits(usdcAmount6dec, 6),
      proofTxHash: receipt?.hash || tx.hash,
    };
  }

  /** ERC-8004 access request (emits AccessRequested; checks BioRouter consent). */
  async requestBioAssetAccess(bioipId: string, paymentMethod = 'x402'): Promise<string> {
    if (!this.signer) throw new Error('requestBioAssetAccess requires a private key (signing mode)');
    const tx = await this.contract.requestBioAssetAccess(bioipId, paymentMethod);
    const receipt = await tx.wait();
    return receipt?.hash || tx.hash;
  }

  /** Public asset identifier for a BioCID (NOT the salted consent bioipId). */
  static assetIdForBiocid(biocid: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(biocid));
  }
}

export default BioAgentRegistry;
