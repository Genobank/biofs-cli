/**
 * biofs payment balance
 *
 * Check USDC balance on Avalanche for x402 payments
 */

import chalk from 'chalk';
import ora from 'ora';
import { ethers } from 'ethers';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import {
  X402Network,
  USDC_ADDRESSES,
  RPC_URLS,
  CHAIN_IDS
} from '../../types/x402';

export interface PaymentBalanceOptions {
  network?: X402Network;
  json?: boolean;
}

// USDC ABI (minimal)
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

export async function paymentBalanceCommand(options: PaymentBalanceOptions = {}): Promise<void> {
  const network: X402Network = options.network || 'avalanche-fuji';
  const spinner = ora('Checking USDC balance...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const walletAddress = credentials.wallet_address;

    // Connect to Avalanche
    const provider = new ethers.JsonRpcProvider(RPC_URLS[network]);
    const usdcContract = new ethers.Contract(
      USDC_ADDRESSES[network],
      USDC_ABI,
      provider
    );

    // Get balances
    const [usdcBalance, decimals, symbol, avaxBalance] = await Promise.all([
      usdcContract.balanceOf(walletAddress),
      usdcContract.decimals(),
      usdcContract.symbol(),
      provider.getBalance(walletAddress)
    ]);

    // Format balances
    const usdcFormatted = Number(usdcBalance) / (10 ** Number(decimals));
    const avaxFormatted = Number(avaxBalance) / 1e18;

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({
        wallet: walletAddress,
        network,
        chainId: CHAIN_IDS[network],
        balances: {
          usdc: {
            raw: usdcBalance.toString(),
            formatted: usdcFormatted.toFixed(2),
            symbol
          },
          avax: {
            raw: avaxBalance.toString(),
            formatted: avaxFormatted.toFixed(6)
          }
        },
        contracts: {
          usdc: USDC_ADDRESSES[network]
        }
      }, null, 2));
      return;
    }

    // Display balance
    console.log(chalk.cyan('\n x402 Payment Balance'));
    console.log(chalk.gray('━'.repeat(50)));

    console.log(`\n${chalk.cyan('Wallet:')}     ${chalk.white(walletAddress)}`);
    console.log(`${chalk.cyan('Network:')}    ${chalk.white(network)} (Chain ID: ${CHAIN_IDS[network]})`);

    console.log(chalk.gray('\n--- Balances ---'));

    // USDC balance with color based on amount
    const usdcColor = usdcFormatted >= 10 ? chalk.green : usdcFormatted >= 1 ? chalk.yellow : chalk.red;
    console.log(`${chalk.cyan('USDC:')}       ${usdcColor(`$${usdcFormatted.toFixed(2)}`)}`);

    // AVAX balance (for gas)
    const avaxColor = avaxFormatted >= 0.1 ? chalk.green : avaxFormatted >= 0.01 ? chalk.yellow : chalk.red;
    console.log(`${chalk.cyan('AVAX:')}       ${avaxColor(`${avaxFormatted.toFixed(6)} AVAX`)} (for gas)`);

    // Warnings
    if (usdcFormatted < 1) {
      console.log(chalk.yellow('\n Low USDC balance. Get testnet USDC from:'));
      console.log(chalk.gray('   https://core.app/tools/testnet-faucet/'));
    }

    if (avaxFormatted < 0.01) {
      console.log(chalk.yellow('\n Low AVAX for gas. Get testnet AVAX from:'));
      console.log(chalk.gray('   https://core.app/tools/testnet-faucet/'));
    }

    console.log(chalk.gray('\n--- Contract Addresses ---'));
    console.log(`${chalk.cyan('USDC:')}  ${chalk.gray(USDC_ADDRESSES[network])}`);

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Balance check failed'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}
