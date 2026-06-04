#!/usr/bin/env node
/**
 * validate-commands.mjs — the dist-only-commands build guard for biofs-cli.
 *
 * `npm run build` (tsc) can silently strip a command registration from
 * dist/index.js. This has already cost the rrm, cohort, fourier-score, and
 * variants verbs in production: on prod some verbs exist ONLY as compiled
 * artifacts under dist/commands with no source in src/, so a rebuild regenerates
 * dist/index.js WITHOUT their registrations and the verb silently disappears
 * from the CLI.
 *
 * A naive src-vs-dist parity check does NOT catch this, because on prod src is
 * itself incomplete (the import line is gone too), so src and dist agree on the
 * absence. The cure is an ALLOWLIST of known dist-only verbs that must ALWAYS be
 * present in dist/index.js. The guard fails the build (exit 1) if:
 *   - a command registered in src/index.ts is missing from dist/index.js
 *     (tsc dropped a live registration), compared on FULL signatures so a
 *     top-level verb is not masked by a same-named subcommand, or
 *   - an allowlisted dist-only verb is missing from dist/index.js.
 *
 * Keep the allowlist in sync with the documented dist-only verbs. Converges on
 * Campaign E's generated assert-dist-catalog manifest once that lands.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src', 'index.ts');
const DIST = path.join(__dirname, 'dist', 'index.js');

// Verbs known to exist as compiled artifacts under dist/commands with no source
// on some deployment targets (prod). They MUST be present in the built CLI
// surface even when src cannot account for them.
const DIST_ONLY_ALLOWLIST = [
  'variants',
  'fourier-score',
  'cohort-acmg',
  'cohort-fourier-score',
  'myvariant',
  'biowallet',
  'rrm-consensus',
  'rrm-distribution',
  'rrm-train'
];

let failed = false;
const fail = m => { console.error('  ✗ ' + m); failed = true; };
const ok = m => console.log('  ✓ ' + m);
const info = m => console.log('  · ' + m);

// Strip // line comments and block comments so a `.command('x')` inside a comment
// is never tokenized. Length-preserving (keeps newlines).
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

// FULL first-string-arg signature of every command registration. Covers single,
// double, and backtick quotes, and `addCommand(new Command('...'))`. The full
// signature ("mount <mount_point>" vs "mount <biosample_id>") means stripping one
// registration changes the set even when the bare verb name is shared.
function commandSignatures(rawText) {
  const text = stripComments(rawText);
  const sigs = [];
  for (const m of text.matchAll(/\.command\(\s*(['"`])([^'"`]+)\1/g)) sigs.push(m[2].trim());
  for (const m of text.matchAll(/new\s+Command\(\s*(['"`])([^'"`]+)\1/g)) sigs.push(m[2].trim());
  return sigs;
}

// Bare verb name = first token of a signature.
const bareName = sig => sig.split(/\s+/)[0];
const uniq = a => [...new Set(a)];
const diff = (a, b) => a.filter(x => !b.includes(x));

console.log('validate-commands: biofs-cli command registration integrity');

if (!fs.existsSync(DIST)) { fail('dist/index.js not found (did tsc run before this guard?)'); process.exit(1); }
if (!fs.existsSync(SRC)) { fail('src/index.ts not found'); process.exit(1); }

const srcSigs = uniq(commandSignatures(fs.readFileSync(SRC, 'utf8')));
const distSigs = uniq(commandSignatures(fs.readFileSync(DIST, 'utf8')));
const distSigSet = new Set(distSigs);
const distBareSet = new Set(distSigs.map(bareName));

// 1. live source registrations dropped by the compile (full-signature compare)
const strippedFromSrc = srcSigs.filter(s => !distSigSet.has(s));
if (strippedFromSrc.length)
  fail(`commands in src/index.ts MISSING from dist/index.js (compile stripped them): ${strippedFromSrc.map(bareName).join(', ')}`);
else ok(`all ${srcSigs.length} src command signatures present in dist`);

// 2. allowlisted dist-only verbs that vanished from the built surface (bare name)
const allowlistMissing = DIST_ONLY_ALLOWLIST.filter(v => !distBareSet.has(v));
if (allowlistMissing.length)
  fail(`allowlisted dist-only verbs MISSING from dist/index.js (the documented strip): ${allowlistMissing.join(', ')}`);
else ok(`all ${DIST_ONLY_ALLOWLIST.length} allowlisted dist-only verbs present in dist`);

// 3. informational: which allowlisted verbs are dist-only here (no source)
const srcBare = new Set(srcSigs.map(bareName));
const distOnlyHere = DIST_ONLY_ALLOWLIST.filter(v => distBareSet.has(v) && !srcBare.has(v));
if (distOnlyHere.length) info(`dist-only on this target (present, no src — expected on prod): ${distOnlyHere.join(', ')}`);
else info('no dist-only verbs on this target (full source present)');

if (failed) {
  console.error('\nvalidate-commands: FAILED — build blocked. A registered or allowlisted verb is missing from dist/index.js.');
  process.exit(1);
}
console.log('validate-commands: OK');
