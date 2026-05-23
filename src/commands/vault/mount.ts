/**
 * `biofs vault mount` — populate ~/genobank/vault/ with the caller's BioNFT data.
 *
 * For every DATA_FILE_CHILD tokenId in the manifest, download both the raw and
 * the OpenCRAVAT-annotated VCF via htsget and drop them in the token's
 * `raw/` + `annotated/` subdirectories. Idempotent: existing files are skipped
 * unless --refresh. Streams-to-file (no in-memory buffering) so 10 GB WGS VCFs
 * don't blow out the heap.
 */
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialsManager } from '../../lib/auth/credentials';
import { getTicket } from '../../lib/htsget/client';
import { Logger } from '../../lib/utils/logger';

export interface VaultMountOptions {
  path?: string;
  refresh?: boolean;
  categories?: string;  // comma-separated subset: DATA_FILE_CHILD,BIOSAMPLE_PARENT
  skipAnnotated?: boolean;
}

export async function vaultMountCommand(options: VaultMountOptions): Promise<void> {
  const vaultPath = options.path || path.join(os.homedir(), 'genobank', 'vault');
  const manifestFile = path.join(vaultPath, '.manifest.json');
  if (!fs.existsSync(manifestFile)) {
    Logger.error(`vault not scaffolded. Run: biofs vault setup`);
    process.exit(3);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds?.user_signature) {
    Logger.error('Not authenticated. Run: biofs login');
    process.exit(3);
  }

  const categories = options.categories?.split(',').map(s => s.trim()) ?? ['DATA_FILE_CHILD'];
  const todo = manifest.bionfts.filter((b: any) => categories.includes(b.category));
  if (todo.length === 0) {
    console.log(chalk.gray(`no BioNFTs in categories [${categories.join(',')}] to mount`));
    return;
  }

  console.log(chalk.cyan(`mounting ${todo.length} BioNFT${todo.length === 1 ? '' : 's'} into ${vaultPath}`));

  let ok = 0, skipped = 0, failed = 0;
  for (const bionft of todo) {
    const slug = `${bionft.category.toLowerCase()}-${bionft.tokenId}`;
    const dir = path.join(vaultPath, slug);

    // Only DATA_FILE_CHILD has a streamable payload via htsget. Others are
    // metadata-only (view with `biofs bionft view <id>`).
    if (bionft.category !== 'DATA_FILE_CHILD') {
      console.log(chalk.gray(`  #${bionft.tokenId} (${bionft.category}) — metadata-only, skipping file download`));
      skipped++;
      continue;
    }

    for (const [subdir, annotated, label] of [
      ['raw', false, 'raw VCF'],
      ['annotated', true, 'annotated VCF'],
    ] as const) {
      if (annotated && options.skipAnnotated) continue;
      const outPath = path.join(dir, subdir, `${bionft.tokenId}.vcf.gz`);
      if (fs.existsSync(outPath) && !options.refresh) {
        console.log(chalk.gray(`  #${bionft.tokenId} ${label}: exists (${fs.statSync(outPath).size} bytes) — pass --refresh to re-download`));
        skipped++;
        continue;
      }
      process.stdout.write(chalk.gray(`  #${bionft.tokenId} ${label}... `));
      try {
        const ticket = await getTicket(
          'variants',
          bionft.tokenId,
          creds.user_signature,
          { query: annotated ? { annotated: 'true' } : undefined },
        );
        const u = ticket.urls[0]?.url;
        if (!u) throw new Error('no URL in ticket');
        // Use curl with --fail-with-body so a 404 on the annotated path doesn't
        // leave a zero-byte file behind.
        const result = spawnSync(
          'curl',
          ['-sSL', '--fail-with-body', '-o', outPath, '-A', 'biofs/2.9.0', u],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        if (result.status !== 0) {
          // Annotated may not exist for every child — that's fine, continue.
          if (annotated) {
            console.log(chalk.gray('(not available)'));
            skipped++;
            continue;
          }
          throw new Error(`curl exit ${result.status}: ${result.stderr?.toString().slice(0, 120)}`);
        }
        const size = fs.statSync(outPath).size;
        console.log(chalk.green(`✓ ${size.toLocaleString()} bytes`));
        ok++;
      } catch (e: any) {
        console.log(chalk.red(`✗ ${e.message || e}`));
        try { fs.unlinkSync(outPath); } catch {}
        failed++;
      }
    }
  }

  console.log(chalk.gray(`\n${ok} ok · ${skipped} skipped · ${failed} failed`));
  console.log(chalk.cyan(`\n${vaultPath}/ is ready. Pipe with bcftools / samtools / Claude Code.\n`));
  console.log(chalk.gray('  Claude Code can read these files natively once you `biofs mcp install`'));
}
