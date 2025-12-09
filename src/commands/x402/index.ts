import { Command } from 'commander';
import { createPayCommand } from './pay';
import { createListServicesCommand } from './list-services';

export function createX402Command(): Command {
  const command = new Command('x402')
    .description('x402 micropayment commands for genomic services on Sequentia')
    .addCommand(createPayCommand())
    .addCommand(createListServicesCommand());

  return command;
}

export default createX402Command;

