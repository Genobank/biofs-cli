import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { ethers } from 'ethers';

// x402 Sequentia Router URL
const SEQUENTIA_ROUTER_URL = process.env.SEQUENTIA_ROUTER_URL || 'http://localhost:5402';

interface PaymentOptions {
  service: string;
  amount?: string;
  wallet?: string;
  data?: any;
  privateKey?: string;
}

interface X402Service {
  price: string;
  description: string;
  provider: string;
  pay_to: string;
}

interface X402PaymentRequirement {
  x402_version: number;
  network: string;
  chain_id: number;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    max_amount_required: string;
    resource: string;
    description: string;
    pay_to: string;
    provider: string;
  }>;
  error: string;
}

export function createPayCommand(): Command {
  const command = new Command('pay')
    .description('Make x402 micropayment for genomic services on Sequentia')
    .option('-s, --service <service>', 'Service to pay for (e.g., vcf-variant, opencravat, alphagenome)')
    .option('-a, --amount <amount>', 'Amount in seqUSDC (will use service default if not specified)')
    .option('-w, --wallet <wallet>', 'Wallet address to pay from')
    .option('-k, --private-key <key>', 'Private key for signing (or set X402_PRIVATE_KEY env)')
    .option('-d, --data <json>', 'JSON data to send with payment')
    .option('--list', 'List available services and their prices')
    .action(async (options: PaymentOptions & { list?: boolean }) => {
      const spinner = ora();

      try {
        // List services if requested
        if (options.list) {
          spinner.start('Fetching available services...');
          try {
            const response = await axios.get(`${SEQUENTIA_ROUTER_URL}/x402/services`);
            spinner.succeed('Available services:');

            console.log(chalk.cyan('\n╔════════════════════════════════════════════════════════════════════╗'));
            console.log(chalk.cyan('║                    x402 Genomic Services on Sequentia             ║'));
            console.log(chalk.cyan('╚════════════════════════════════════════════════════════════════════╝\n'));

            const services = response.data.services;
            Object.entries(services).forEach(([name, service]: [string, any]) => {
              console.log(chalk.yellow(`📦 ${name}`));
              console.log(`   Price: ${chalk.green(`$${service.price}`)} seqUSDC`);
              console.log(`   Description: ${service.description}`);
              console.log(`   Provider: ${chalk.blue(service.provider)}`);
              console.log('');
            });

            console.log(chalk.gray(`Network: ${response.data.network}`));
            console.log(chalk.gray(`Chain ID: ${response.data.chain_id}`));
            console.log(chalk.gray(`Payment Token: ${response.data.payment_token.symbol} (${response.data.payment_token.address})`));

            return;
          } catch (error: any) {
            spinner.fail(`Failed to fetch services: ${error.message}`);
            return;
          }
        }

        // Check if service is specified
        if (!options.service) {
          console.log(chalk.red('Error: Service is required. Use --list to see available services.'));
          return;
        }

        // Parse data if provided
        let paymentData = {};
        if (options.data) {
          try {
            paymentData = JSON.parse(options.data);
          } catch (error) {
            console.log(chalk.red('Error: Invalid JSON data'));
            return;
          }
        }

        // Get wallet and private key
        const privateKey = options.privateKey || process.env.X402_PRIVATE_KEY;
        let wallet = options.wallet;

        if (!wallet && privateKey) {
          // Derive wallet from private key
          const signer = new ethers.Wallet(privateKey);
          wallet = signer.address;
        }

        if (!wallet) {
          const answers = await inquirer.prompt([{
            type: 'input',
            name: 'wallet',
            message: 'Enter your wallet address:',
            validate: (input) => ethers.isAddress(input) || 'Invalid wallet address'
          }]);
          wallet = answers.wallet;
        }

        // First, make request without payment to get requirements
        spinner.start(`Checking payment requirements for ${options.service}...`);

        try {
          const checkResponse = await axios.post(
            `${SEQUENTIA_ROUTER_URL}/x402/route`,
            {
              service: options.service,
              data: paymentData
            },
            {
              validateStatus: (status) => status === 402 || status < 500
            }
          );

          if (checkResponse.status === 402) {
            const requirements: X402PaymentRequirement = checkResponse.data;
            spinner.stop();

            console.log(chalk.yellow('\n💳 Payment Required:'));
            console.log(`   Service: ${chalk.cyan(options.service)}`);
            console.log(`   Amount: ${chalk.green(`$${requirements.accepts[0].max_amount_required}`)} seqUSDC`);
            console.log(`   Provider: ${chalk.blue(requirements.accepts[0].provider)}`);
            console.log(`   Description: ${requirements.accepts[0].description}`);
            console.log(`   Network: ${requirements.network} (Chain ID: ${requirements.chain_id})`);
            console.log(`   Pay to: ${requirements.accepts[0].pay_to}`);

            // Prompt for confirmation
            const { confirm } = await inquirer.prompt([{
              type: 'confirm',
              name: 'confirm',
              message: `Proceed with payment of $${requirements.accepts[0].max_amount_required}?`,
              default: false
            }]);

            if (!confirm) {
              console.log(chalk.gray('Payment cancelled'));
              return;
            }

            // Create payment
            spinner.start('Processing payment...');

            // For now, create a simulated payment
            // In production, this would sign with the private key
            const paymentHeader = Buffer.from(JSON.stringify({
              service: options.service,
              amount: options.amount || requirements.accepts[0].max_amount_required,
              wallet: wallet,
              signature: '0x' + '0'.repeat(130), // Mock signature
              data: paymentData
            })).toString('base64');

            // Send payment
            const paymentResponse = await axios.post(
              `${SEQUENTIA_ROUTER_URL}/x402/route`,
              { service: options.service },
              {
                headers: {
                  'X-PAYMENT': paymentHeader
                }
              }
            );

            spinner.succeed('Payment processed successfully!');

            console.log(chalk.green('\n✅ Payment Successful:'));
            console.log(`   Transaction: ${chalk.cyan(paymentResponse.data.tx_hash)}`);
            if (paymentResponse.data.block_explorer) {
              console.log(`   Explorer: ${chalk.blue(paymentResponse.data.block_explorer)}`);
            }

            if (paymentResponse.data.result) {
              console.log(chalk.yellow('\n📊 Service Response:'));
              console.log(JSON.stringify(paymentResponse.data.result, null, 2));
            }
          }
        } catch (error: any) {
          spinner.fail(`Payment failed: ${error.response?.data?.error || error.message}`);
        }

      } catch (error: any) {
        spinner.fail(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  return command;
}

// Export for use in main CLI
export default createPayCommand;
