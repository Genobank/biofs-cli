#!/usr/bin/env node
"use strict";
/**
 * Standalone `kiosk` entry for Stage 1. `biofs kiosk` will reuse registerKiosk once the
 * protocol is cleared for release.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const cli_1 = require("./cli");
const program = new commander_1.Command();
program
    .name('kiosk')
    .description('Kiosk: one Claude Code conversation shared by people on different Macs, owned and consent-gated (Stage 1)')
    .version('0.3.0');
(0, cli_1.registerKiosk)(program, { script: __filename, prefix: [] });
program.parseAsync(process.argv).catch((e) => {
    console.error(e.message);
    process.exit(1);
});
