/**
 * Sequentia seqUSDC settlement helpers for the x402 Cancer Twin pipeline.
 *
 * Two settlement shapes, both faithful to the x402 BioData Router whitepaper:
 *   - payAgentDirect:  patient → single agent seqUSDC transfer (per-step x402)
 *   - payAgentsAtomic: patient → N agents via the Sequentia PaymentRouter in one
 *     all-or-nothing route (the whitepaper's "Maria pays 499 USDC, atomic split")
 *
 * Every function has a deterministic simulation path used by --dry-run, so the
 * full traceable flow (amounts, recipients, tx hashes) can be demonstrated with
 * no key, gas, or live RPC.
 *
 * The patient payment key comes from X402_PRIVATE_KEY / SEQUENTIA_MINTER_KEY /
 * PATIENT_PRIVATE_KEY (env). The operator is the patient in the demo, so the
 * operator's own key signs the settlement.
 */

import { ethers } from 'ethers';
import * as path from 'path';
import { SEQUENTIA_NETWORK, CONFIG } from '../config/constants';

// seqUSDC paired with the deployed Sequentia PaymentRouter (PaymentRouter.ts).
// Override with SEQ_USDC_ADDRESS if a different seqUSDC deployment is in use.
export const SEQ_USDC_ADDRESS =
  process.env.SEQ_USDC_ADDRESS || '0xD837B344e931cc265ec54879A0B388DE6F0015c9';
export const PAYMENT_ROUTER_ADDRESS =
  process.env.PAYMENT_ROUTER_ADDRESS || '0x4b46D8A0533bc17503349F86a909C2FEcFD04489';

const USDC_DECIMALS = 6;

export interface PayRecipient {
  recipient: string;
  amountUsdc: number;
  description: string;
}

export interface SettlementResult {
  simulated: boolean;
  scheme: 'direct' | 'atomic-router';
  token: string;
  totalUsdc: number;
  recipients: PayRecipient[];
  txHash: string;
  blockNumber?: number;
  payer: string;
}

export function usdcToUnits(amountUsdc: number): bigint {
  return BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
}

/** Resolve the patient/payer private key from env, or null if unavailable. */
export function patientKeyFromEnv(): string | null {
  const k = process.env.X402_PRIVATE_KEY
    || process.env.SEQUENTIA_MINTER_KEY
    || process.env.PATIENT_PRIVATE_KEY
    || null;
  if (!k) return null;
  return k.startsWith('0x') ? k : `0x${k}`;
}

/** Deterministic simulated settlement tx hash (stable for a given input). */
function simTxHash(payer: string, recipients: PayRecipient[], scheme: string): string {
  const seed = `${scheme}|${payer}|` + recipients.map((r) => `${r.recipient}:${r.amountUsdc}`).join(',');
  return ethers.keccak256(ethers.toUtf8Bytes(seed));
}

function patientAddress(payerKey: string): string {
  return new ethers.Wallet(payerKey).address;
}

/**
 * Single-agent direct seqUSDC transfer. Returns the settlement tx hash.
 * In dry-run / no-key mode returns a deterministic simulated result.
 */
export async function payAgentDirect(
  recipient: PayRecipient,
  payerKey: string | null,
  dryRun: boolean,
): Promise<SettlementResult> {
  const recipients = [recipient];
  if (dryRun || !payerKey) {
    const payer = payerKey ? patientAddress(payerKey) : CONFIG.HOME_DIR ? '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a' : '0x0';
    return {
      simulated: true,
      scheme: 'direct',
      token: SEQ_USDC_ADDRESS,
      totalUsdc: recipient.amountUsdc,
      recipients,
      txHash: simTxHash(payer, recipients, 'direct'),
      payer,
    };
  }
  const provider = new ethers.JsonRpcProvider(process.env.SEQUENTIA_RPC_URL || SEQUENTIA_NETWORK.rpc);
  const wallet = new ethers.Wallet(payerKey, provider);
  const usdcAbi = ['function transfer(address to, uint256 amount) returns (bool)'];
  const usdc = new ethers.Contract(SEQ_USDC_ADDRESS, usdcAbi, wallet);
  const tx = await usdc.transfer(ethers.getAddress(recipient.recipient), usdcToUnits(recipient.amountUsdc));
  const receipt = await tx.wait();
  return {
    simulated: false,
    scheme: 'direct',
    token: SEQ_USDC_ADDRESS,
    totalUsdc: recipient.amountUsdc,
    recipients,
    txHash: receipt?.hash || tx.hash,
    blockNumber: receipt?.blockNumber,
    payer: wallet.address,
  };
}

/**
 * Atomic multi-recipient settlement via the Sequentia PaymentRouter — the
 * whitepaper's all-or-nothing split. Returns the executeRoute tx hash.
 */
export async function payAgentsAtomic(
  jobId: string,
  recipients: PayRecipient[],
  payerKey: string | null,
  dryRun: boolean,
): Promise<SettlementResult> {
  const total = recipients.reduce((s, r) => s + r.amountUsdc, 0);
  if (dryRun || !payerKey) {
    const payer = payerKey ? patientAddress(payerKey) : '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
    return {
      simulated: true,
      scheme: 'atomic-router',
      token: SEQ_USDC_ADDRESS,
      totalUsdc: total,
      recipients,
      txHash: simTxHash(payer, recipients, 'atomic-router:' + jobId),
      payer,
    };
  }
  const provider = new ethers.JsonRpcProvider(process.env.SEQUENTIA_RPC_URL || SEQUENTIA_NETWORK.rpc);
  const wallet = new ethers.Wallet(payerKey, provider);
  const routerAbi = require(path.join(__dirname, '../../abi/sequentia/PaymentRouter.json'));
  const usdcAbi = require(path.join(__dirname, '../../abi/USDC.json'));
  const router = new ethers.Contract(PAYMENT_ROUTER_ADDRESS, routerAbi, wallet);
  const usdc = new ethers.Contract(SEQ_USDC_ADDRESS, usdcAbi, wallet);

  const totalUnits = usdcToUnits(total);
  const recipientsUnits = recipients.map((r) => ({
    recipient: ethers.getAddress(r.recipient),
    amount: usdcToUnits(r.amountUsdc),
    description: r.description,
  }));

  const approveTx = await usdc.approve(PAYMENT_ROUTER_ADDRESS, totalUnits);
  await approveTx.wait();
  const createTx = await router.createRoute(jobId, totalUnits, recipientsUnits);
  await createTx.wait();
  const execTx = await router.executeRoute(jobId);
  const receipt = await execTx.wait();

  return {
    simulated: false,
    scheme: 'atomic-router',
    token: SEQ_USDC_ADDRESS,
    totalUsdc: total,
    recipients,
    txHash: receipt?.hash || execTx.hash,
    blockNumber: receipt?.blockNumber,
    payer: wallet.address,
  };
}
