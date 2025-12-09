/**
 * Admin Commands Index
 *
 * Admin operations for BioFS including lab registration and verification
 *
 * @author GenoBank.io
 */

import { Command } from 'commander';
import { createRegisterLabCommand } from './register-lab';
import { createVerifyLabCommand } from './verify-lab';

/**
 * Create the admin command group
 */
export function createAdminCommand(): Command {
  const admin = new Command('admin')
    .description('Admin operations (requires admin privileges)');

  // Add subcommands
  admin.addCommand(createRegisterLabCommand());
  admin.addCommand(createVerifyLabCommand());

  return admin;
}


