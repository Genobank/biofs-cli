/**
 * biofs payment faucet
 *
 * Get testnet USDC and AVAX for x402 payments on Avalanche Fuji
 */

import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';
import {
  X402Network,
  USDC_ADDRESSES,
  CHAIN_IDS
} from '../../types/x402';

export interface PaymentFaucetOptions {
  noBrowser?: boolean;
  json?: boolean;
}

// Testnet faucets
const FAUCETS = {
  'avalanche-fuji': {
    avax: 'https://core.app/tools/testnet-faucet/?subnet=c&token=c',
    usdc: 'https://faucet.circle.com/',  // Circle USDC testnet faucet
    chainlinkUsdc: 'https://faucets.chain.link/fuji'  // Alternative
  }
};

export async function paymentFaucetCommand(options: PaymentFaucetOptions = {}): Promise<void> {
  const spinner = ora('Getting faucet information...').start();

  try {
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const walletAddress = credentials.wallet_address;
    const network: X402Network = 'avalanche-fuji';  // Only testnet has faucets
    const faucetUrls = FAUCETS[network];

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify({
        wallet: walletAddress,
        network,
        chainId: CHAIN_IDS[network],
        faucets: faucetUrls,
        instructions: {
          step1: 'Visit AVAX faucet and request testnet AVAX',
          step2: 'Visit USDC faucet and request testnet USDC',
          step3: 'Run "biofs payment balance" to verify'
        }
      }, null, 2));
      return;
    }

    console.log(chalk.cyan('\n Testnet Faucet - Avalanche Fuji'));
    console.log(chalk.gray('━'.repeat(50)));

    console.log(`\n${chalk.cyan('Your Wallet:')} ${chalk.white(walletAddress)}`);
    console.log(`${chalk.cyan('Network:')}     ${chalk.white('Avalanche Fuji Testnet')}`);
    console.log(`${chalk.cyan('Chain ID:')}    ${chalk.white(CHAIN_IDS[network])}`);

    console.log(chalk.gray('\n--- Step 1: Get Testnet AVAX (for gas) ---'));
    console.log(`${chalk.cyan('URL:')} ${chalk.blue(faucetUrls.avax)}`);
    console.log(chalk.gray('1. Connect your wallet'));
    console.log(chalk.gray('2. Select "Avalanche C-Chain"'));
    console.log(chalk.gray('3. Request 2 AVAX'));

    console.log(chalk.gray('\n--- Step 2: Get Testnet USDC (for payments) ---'));
    console.log(`${chalk.cyan('Circle Faucet:')} ${chalk.blue(faucetUrls.usdc)}`);
    console.log(chalk.gray('1. Connect wallet and verify'));
    console.log(chalk.gray('2. Select Avalanche Fuji'));
    console.log(chalk.gray('3. Request USDC'));
    console.log('');
    console.log(`${chalk.cyan('Alternative:')} ${chalk.blue(faucetUrls.chainlinkUsdc)}`);

    console.log(chalk.gray('\n--- USDC Contract (Fuji) ---'));
    console.log(`${chalk.cyan('Address:')} ${chalk.gray(USDC_ADDRESSES[network])}`);

    console.log(chalk.gray('\n--- After Getting Tokens ---'));
    console.log('1. Check balance: biofs payment balance');
    console.log('2. View pricing: biofs payment pricing');
    console.log('3. Try a paid service: biofs annotate submit <biosample>');

    // Open browser if not disabled
    if (!options.noBrowser) {
      console.log(chalk.yellow('\n Opening AVAX faucet in browser...'));
      try {
        await open(faucetUrls.avax);
      } catch {
        Logger.warn('Could not open browser. Please visit the URLs manually.');
      }
    }

    console.log('');

  } catch (error: any) {
    spinner.fail(chalk.red('Faucet command failed'));
    Logger.error(`Error: ${error.message}`);
    throw error;
  }
}


