import { Command } from 'commander';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

// x402 Sequentia Router URL
const SEQUENTIA_ROUTER_URL = process.env.SEQUENTIA_ROUTER_URL || 'http://localhost:5402';

export function createListServicesCommand(): Command {
  const command = new Command('list-services')
    .alias('services')
    .description('List all available x402 genomic services on Sequentia')
    .option('--json', 'Output in JSON format')
    .option('--check-balance <wallet>', 'Check wallet balance for payments')
    .action(async (options: { json?: boolean; checkBalance?: string }) => {
      const spinner = ora();

      try {
        // Fetch services
        spinner.start('Fetching available x402 services...');
        const response = await axios.get(`${SEQUENTIA_ROUTER_URL}/x402/services`);
        spinner.succeed();

        const { services, network, chain_id, payment_token } = response.data;

        if (options.json) {
          console.log(JSON.stringify(response.data, null, 2));
          return;
        }

        // Display header
        console.log(chalk.cyan('\n╔══════════════════════════════════════════════════════════════════════════╗'));
        console.log(chalk.cyan('║              🧬 x402 Genomic Services on Sequentia Network              ║'));
        console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════════════════╝\n'));

        // Network info
        console.log(chalk.gray(`Network: ${network} | Chain ID: ${chain_id}`));
        console.log(chalk.gray(`Payment Token: ${payment_token.symbol} (${payment_token.address})\n`));

        // Create table for services
        const table = new Table({
          head: [
            chalk.cyan('Service'),
            chalk.cyan('Price (USD)'),
            chalk.cyan('Description'),
            chalk.cyan('Provider')
          ],
          style: {
            head: [],
            border: ['gray']
          }
        });

        // Group services by price range
        const microServices: any[] = [];  // < $0.01
        const lowCostServices: any[] = []; // $0.01 - $1
        const mediumCostServices: any[] = []; // $1 - $10
        const highCostServices: any[] = []; // > $10

        Object.entries(services).forEach(([name, service]: [string, any]) => {
          const price = parseFloat(service.price);
          const entry = [name, service];

          if (price < 0.01) microServices.push(entry);
          else if (price <= 1) lowCostServices.push(entry);
          else if (price <= 10) mediumCostServices.push(entry);
          else highCostServices.push(entry);
        });

        // Add services to table by category
        const addServicesToTable = (serviceList: any[], emoji: string) => {
          serviceList.forEach(([name, service]) => {
            table.push([
              `${emoji} ${chalk.yellow(name)}`,
              chalk.green(`$${service.price}`),
              service.description,
              chalk.blue(service.provider)
            ]);
          });
        };

        // Add micro-payment services
        if (microServices.length > 0) {
          table.push([{ colSpan: 4, content: chalk.magenta('⚡ Micro-payments (< $0.01)') }]);
          addServicesToTable(microServices, '⚡');
        }

        // Add low-cost services
        if (lowCostServices.length > 0) {
          table.push([{ colSpan: 4, content: chalk.green('💰 Low-cost services ($0.01 - $1)') }]);
          addServicesToTable(lowCostServices, '💰');
        }

        // Add medium-cost services
        if (mediumCostServices.length > 0) {
          table.push([{ colSpan: 4, content: chalk.yellow('🔬 Medium-cost services ($1 - $10)') }]);
          addServicesToTable(mediumCostServices, '🔬');
        }

        // Add high-cost services
        if (highCostServices.length > 0) {
          table.push([{ colSpan: 4, content: chalk.red('🏥 High-cost services (> $10)') }]);
          addServicesToTable(highCostServices, '🏥');
        }

        console.log(table.toString());

        // Check balance if requested
        if (options.checkBalance) {
          spinner.start(`Checking balance for wallet ${options.checkBalance}...`);
          try {
            const balanceResponse = await axios.get(
              `${SEQUENTIA_ROUTER_URL}/x402/balance/${options.checkBalance}`
            );
            spinner.succeed();

            console.log(chalk.cyan('\n💳 Wallet Balance:'));
            console.log(`   Wallet: ${balanceResponse.data.wallet}`);
            console.log(`   SEQ Balance: ${chalk.yellow(balanceResponse.data.seq_balance)} SEQ`);
            console.log(`   seqUSDC Balance: ${chalk.green(`$${balanceResponse.data.sequsdc_balance}`)}`);

            // Calculate what services can be afforded
            const usdcBalance = parseFloat(balanceResponse.data.sequsdc_balance);
            const affordableServices = Object.entries(services)
              .filter(([_, service]: [string, any]) => parseFloat(service.price) <= usdcBalance)
              .map(([name]) => name);

            if (affordableServices.length > 0) {
              console.log(chalk.gray(`\n   Can afford ${affordableServices.length} services:`));
              affordableServices.forEach(name => {
                console.log(chalk.gray(`   • ${name}`));
              });
            } else {
              console.log(chalk.red('\n   ⚠️  Insufficient balance for any services'));
            }
          } catch (error: any) {
            spinner.fail(`Failed to check balance: ${error.response?.data?.error || error.message}`);
          }
        }

        // Show usage examples
        console.log(chalk.gray('\n📝 Usage Examples:'));
        console.log(chalk.gray('   biofs pay --service vcf-variant --data \'{"chr": "1", "pos": 12345}\''));
        console.log(chalk.gray('   biofs pay --service opencravat --list'));
        console.log(chalk.gray('   biofs pay --service alphagenome --wallet 0x...'));

      } catch (error: any) {
        spinner.fail(`Error fetching services: ${error.message}`);
        process.exit(1);
      }
    });

  return command;
}

// Export for use in main CLI
export default createListServicesCommand;