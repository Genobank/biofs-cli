/**
 * biofs x402 verify-payment <paymentId...>
 *
 * The oracle/owner side of the x402 flow: confirm one or more ERC-8004 payment
 * proofs on the Sequentia BioAgentRegistry. verifyPayment is onlyOwner — it
 * marks each proof verified and credits the serving agent's on-chain totalSpent
 * with the BIOIP-equivalent (1 USDC = 10 BIOIP). This is the verb-native form of
 * the owner-verify step that closes the x402 economic loop:
 *   x402 submit (agent settles + submitPaymentProof) -> x402 verify-payment (owner).
 *
 *   biofs x402 verify-payment 1 2 3
 *   biofs x402 verify-payment --all          verify every unverified proof
 *   biofs x402 verify-payment 1 --dry-run    preview without broadcasting
 *
 * The owner key is read from REGISTRY_OWNER_PRIVATE_KEY / SEQUENTIA_DEPLOYER_PRIVATE_KEY
 * / X402_PRIVATE_KEY (env). --dry-run needs no key.
 */

import chalk from 'chalk';
import ora from 'ora';
import { BioAgentRegistry, BIOAGENT_REGISTRY_ADDRESS } from '../../lib/sequentia/BioAgentRegistry';
import { SEQUENTIA_NETWORK } from '../../lib/config/constants';
import { Logger } from '../../lib/utils/logger';

export interface X402VerifyPaymentOptions {
  all?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

function ownerKeyFromEnv(): string | null {
  const k = process.env.REGISTRY_OWNER_PRIVATE_KEY
    || process.env.SEQUENTIA_DEPLOYER_PRIVATE_KEY
    || process.env.X402_PRIVATE_KEY
    || null;
  if (!k) return null;
  return k.startsWith('0x') ? k : `0x${k}`;
}

interface VerifyOutcome {
  paymentId: number;
  agentId: number | null;
  usdcAmount: string | null;
  bioipEquivalent: string | null;
  alreadyVerified: boolean;
  verified: boolean;
  txHash: string | null;
  error?: string;
}

export async function x402VerifyPaymentCommand(
  paymentIds: string[],
  options: X402VerifyPaymentOptions = {},
): Promise<void> {
  const dryRun = !!options.dryRun;
  const ownerKey = ownerKeyFromEnv();

  // Read-only registry to enumerate / inspect; signing registry only if verifying.
  const readReg = new BioAgentRegistry();

  // Resolve the target payment ids.
  let ids: number[];
  if (options.all) {
    const count = await readReg.paymentCount();
    ids = Array.from({ length: count }, (_, i) => i + 1);
  } else {
    ids = paymentIds.map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (ids.length === 0) {
    Logger.error('Provide one or more paymentId(s), or --all.');
    process.exit(2);
  }

  const signReg = (!dryRun && ownerKey) ? new BioAgentRegistry(ownerKey) : null;
  if (!dryRun && !ownerKey) {
    Logger.error('Owner key required. Set REGISTRY_OWNER_PRIVATE_KEY / SEQUENTIA_DEPLOYER_PRIVATE_KEY, or use --dry-run.');
    process.exit(1);
  }

  const spinner = options.json ? null
    : ora(`${dryRun ? 'Previewing' : 'Verifying'} ${ids.length} payment proof(s) on BioAgentRegistry…`).start();

  const outcomes: VerifyOutcome[] = [];
  for (const pid of ids) {
    const rec = await readReg.getPayment(pid);
    if (!rec) {
      outcomes.push({ paymentId: pid, agentId: null, usdcAmount: null, bioipEquivalent: null, alreadyVerified: false, verified: false, txHash: null, error: 'no such payment' });
      continue;
    }
    const base: VerifyOutcome = {
      paymentId: pid, agentId: rec.agentId, usdcAmount: rec.usdcAmount, bioipEquivalent: rec.bioipEquivalent,
      alreadyVerified: rec.verified, verified: rec.verified, txHash: null,
    };
    if (rec.verified || dryRun) { outcomes.push(base); continue; }
    try {
      if (spinner) spinner.text = `verifying payment #${pid} (agent ${rec.agentId})…`;
      const tx = await signReg!.verifyPayment(pid);
      outcomes.push({ ...base, verified: true, txHash: tx });
    } catch (e: any) {
      outcomes.push({ ...base, error: e?.message || String(e) });
    }
  }
  spinner?.stop();

  if (options.json) {
    console.log(JSON.stringify({ registry: BIOAGENT_REGISTRY_ADDRESS, network: SEQUENTIA_NETWORK.name, dryRun, payments: outcomes }, null, 2));
    return;
  }

  console.log(chalk.cyan('\n💳 x402 Payment Verification — BioAgentRegistry'));
  console.log(chalk.gray('━'.repeat(60)));
  console.log(`${chalk.cyan('Registry:')} ${BIOAGENT_REGISTRY_ADDRESS}  ${chalk.gray('(' + SEQUENTIA_NETWORK.name + ')')}`);
  if (dryRun) console.log(chalk.yellow('Mode:     DRY-RUN (no chain writes)'));
  console.log('');
  for (const o of outcomes) {
    const status = o.error ? chalk.red(`✗ ${o.error}`)
      : o.alreadyVerified ? chalk.gray('• already verified')
      : dryRun ? chalk.yellow('… would verify')
      : o.verified ? chalk.green('✓ verified')
      : chalk.red('✗ not verified');
    console.log(`${chalk.white.bold('payment #' + o.paymentId)}  ${status}`);
    if (o.agentId !== null) {
      console.log(`  ${chalk.gray('agent:')} #${o.agentId}   ${chalk.gray('amount:')} ${o.usdcAmount} USDC -> ${o.bioipEquivalent} BIOIP`);
    }
    if (o.txHash) console.log(`  ${chalk.gray('tx:')} ${o.txHash}`);
  }
}
