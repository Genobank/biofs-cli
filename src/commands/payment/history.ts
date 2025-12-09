/**
 * biofs payment history
 *
 * View payment transaction history on Avalanche
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { ethers } from 'ethers';
import * as fs from 'fs-extra';
import * as path from 'path';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import {
  X402Network,
  USDC_ADDRESSES,
  RPC_URLS,
  CHAIN_IDS
} from '../../types/x402';

export interface PaymentHistoryOptions {
  network?: X402Network;
  limit?: number;
  json?: boolean;
}

// Local payment history cache
const CONFIG_DIR = path.join(process.env.HOME || '~', '.biofs');
const HISTORY_PATH = path.join(CONFIG_DIR, 'payment-history.json');

interface PaymentRecord {
  timestamp: number;
  txHash: string;
  amount: string;
  service: string;
  receiver: string;
  network: X402Network;
  status: 'confirmed' | 'pending' | 'failed';
}

interface PaymentHistory {
  payments: PaymentRecord[];
}

async function loadHistory(): Promise<PaymentHistory> {
  try {
    if (await fs.pathExists(HISTORY_PATH)) {
      return await fs.readJson(HISTORY_PATH);
    }
  } catch {
    // Ignore errors
  }
  return { payments: [] };
}

/**
 * Save a new payment to history
 */
export async function recordPayment(record: PaymentRecord): Promise<void> {
  const history = await loadHistory();
  history.payments.unshift(record);  // Add to beginning

  // Keep only last 100 payments
  if (history.payments.length > 100) {
    history.payments = history.payments.slice(0, 100);
  }

  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(HISTORY_PATH, history, { spaces: 2 });
}

export async function paymentHistoryCommand(options: PaymentHistoryOptions = {}): Promise<void> {
  const spinner = ora('Loading payment history...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const network: X402Network = options.network || 'avalanche-fuji';
    const limit = options.limit || 20;

    // Load local history
    const history = await loadHistory();

    // Filter by network
    const payments = history.payments
      .filter(p => p.network === network)
      .slice(0, limit);

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({
        wallet: credentials.wallet_address,
        network,
        totalPayments: payments.length,
        payments
      }, null, 2));
      return;
    }

    console.log(chalk.cyan('\n Payment History'));
    console.log(chalk.gray('━'.repeat(70)));
    console.log(chalk.gray(`Network: ${network} | Wallet: ${credentials.wallet_address.substring(0, 10)}...\n`));

    if (payments.length === 0) {
      console.log(chalk.gray('No payment history found.'));
      console.log(chalk.gray('\nPayments are recorded when you use paid services like:'));
      console.log(chalk.gray('  - biofs annotate submit <biosample>'));
      console.log(chalk.gray('  - biofs job submit-clara <biosample>'));
      console.log('');
      return;
    }

    // Create table
    const table = new Table({
      head: [
        chalk.cyan('Date'),
        chalk.cyan('Amount'),
        chalk.cyan('Service'),
        chalk.cyan('Status'),
        chalk.cyan('Transaction')
      ],
      colWidths: [20, 10, 20, 12, 20]
    });

    for (const payment of payments) {
      const date = new Date(payment.timestamp).toLocaleString();
      const statusColor = payment.status === 'confirmed' ? chalk.green :
                         payment.status === 'pending' ? chalk.yellow :
                         chalk.red;
      const txShort = payment.txHash.substring(0, 10) + '...';

      table.push([
        chalk.gray(date),
        chalk.green(payment.amount),
        chalk.white(payment.service),
        statusColor(payment.status),
        chalk.gray(txShort)
      ]);
    }

    console.log(table.toString());

    // Summary
    const totalSpent = payments
      .filter(p => p.status === 'confirmed')
      .reduce((sum, p) => sum + parseFloat(p.amount.replace('$', '')), 0);

    console.log(chalk.gray('\n--- Summary ---'));
    console.log(`${chalk.cyan('Total Payments:')} ${payments.length}`);
    console.log(`${chalk.cyan('Total Spent:')}    ${chalk.green(`$${totalSpent.toFixed(2)}`)}`);

    console.log(chalk.gray('\n--- Explorer ---'));
    const explorerUrl = network === 'avalanche-fuji'
      ? 'https://testnet.snowtrace.io'
      : 'https://snowtrace.io';
    console.log(`${chalk.cyan('View on Snowtrace:')} ${chalk.blue(`${explorerUrl}/address/${credentials.wallet_address}`)}`);

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('History lookup failed'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}

