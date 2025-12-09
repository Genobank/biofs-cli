/**
 * biofs payment pricing
 *
 * Show current x402 pricing for BioFS services
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { Logger } from '../../lib/utils/logger';
import { BIOFS_PRICING, X402Network } from '../../types/x402';

export interface PaymentPricingOptions {
  network?: X402Network;
  json?: boolean;
}

export async function paymentPricingCommand(options: PaymentPricingOptions = {}): Promise<void> {
  const network: X402Network = options.network || 'avalanche-fuji';

  if (options.json) {
    console.log(JSON.stringify({
      network,
      currency: 'USDC',
      pricing: BIOFS_PRICING
    }, null, 2));
    return;
  }

  console.log(chalk.cyan('\n BioFS Service Pricing (x402 Protocol)'));
  console.log(chalk.gray('━'.repeat(60)));
  console.log(chalk.gray(`Network: ${network} | Currency: USDC\n`));

  // Create pricing table
  const table = new Table({
    head: [
      chalk.cyan('Service'),
      chalk.cyan('Price'),
      chalk.cyan('Description')
    ],
    colWidths: [25, 10, 40],
    wordWrap: true
  });

  // Add rows
  for (const [route, config] of Object.entries(BIOFS_PRICING)) {
    table.push([
      chalk.white(route.replace('/', '')),
      chalk.green(config.price),
      chalk.gray(config.description || '-')
    ]);
  }

  console.log(table.toString());

  console.log(chalk.gray('\n--- Additional Pricing ---'));
  console.log(`${chalk.cyan('Free Tier:')}      Files < 100MB download free`);
  console.log(`${chalk.cyan('Data Storage:')}  $0.01/GB/month (tokenized files)`);
  console.log(`${chalk.cyan('API Calls:')}     First 1000/day free, then $0.001/call`);

  console.log(chalk.gray('\n--- Payment Method ---'));
  console.log(`${chalk.cyan('Protocol:')}      x402 (HTTP 402 Payment Required)`);
  console.log(`${chalk.cyan('Token:')}         USDC on Avalanche C-Chain`);
  console.log(`${chalk.cyan('Network:')}       ${network === 'avalanche-fuji' ? 'Fuji Testnet' : 'Mainnet'}`);
  console.log(`${chalk.cyan('Settlement:')}    Instant (EIP-712 signatures)`);

  console.log(chalk.gray('\n--- How It Works ---'));
  console.log('1. Request a paid service (e.g., biofs annotate submit)');
  console.log('2. Receive 402 Payment Required response');
  console.log('3. BioFS CLI auto-signs payment with your wallet');
  console.log('4. Payment settled on Avalanche, service proceeds');

  console.log(chalk.gray('\n--- Get Testnet USDC ---'));
  console.log(`   ${chalk.blue('https://core.app/tools/testnet-faucet/')}`);

  console.log('');
}
