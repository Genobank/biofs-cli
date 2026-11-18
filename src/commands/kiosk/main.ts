#!/usr/bin/env node
/**
 * Standalone `kiosk` entry for Stage 1. `biofs kiosk` will reuse registerKiosk once the
 * protocol is cleared for release.
 */

import { Command } from 'commander';
import { registerKiosk } from './cli';

const program = new Command();
program
  .name('kiosk')
  .description('Kiosk: one Claude Code conversation shared by people on different Macs, owned and consent-gated (Stage 1)')
  .version('0.3.0');

registerKiosk(program, { script: __filename, prefix: [] });

program.parseAsync(process.argv).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
