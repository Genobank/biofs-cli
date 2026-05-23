/** `biofs vault status` — show mount state + freshness. */
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export async function vaultStatusCommand(options: { path?: string }): Promise<void> {
  const vaultPath = options.path || path.join(os.homedir(), 'genobank', 'vault');
  const manifestFile = path.join(vaultPath, '.manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.log(chalk.yellow(`⚠  no vault at ${vaultPath}. Run: biofs vault setup`));
    return;
  }
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  console.log(chalk.cyan('═'.repeat(70)));
  console.log(chalk.bold(`  genobank vault · ${vaultPath}`));
  console.log(chalk.cyan('═'.repeat(70)));
  console.log(chalk.gray(`  wallet:          ${m.wallet}`));
  console.log(chalk.gray(`  scaffolded:      ${m.created_at}`));
  console.log(chalk.gray(`  chain:           Sequentia (${m.contracts?.chain_id})`));
  console.log(chalk.gray(`  BioAssetVault:   ${m.contracts?.bioAssetVault}`));
  console.log(chalk.gray(`  BioNFTCredentials: ${m.contracts?.bioNFTCredentials}`));
  console.log();

  for (const category of ['BIOSAMPLE_PARENT', 'DATA_FILE_CHILD', 'RENT_AGREEMENT', 'INGEST_TICKET']) {
    const rows = m.bionfts.filter((b: any) => b.category === category);
    if (rows.length === 0) continue;
    console.log(chalk.bold(`  ${category}  (${rows.length})`));
    for (const b of rows) {
      const slug = `${b.category.toLowerCase()}-${b.tokenId}`;
      const d = path.join(vaultPath, slug);
      let bytes = 0, files = 0;
      for (const sub of ['raw', 'annotated']) {
        const p = path.join(d, sub);
        if (fs.existsSync(p)) {
          for (const f of fs.readdirSync(p)) {
            const fp = path.join(p, f);
            if (fs.statSync(fp).isFile()) { bytes += fs.statSync(fp).size; files++; }
          }
        }
      }
      console.log(chalk.gray(`    #${b.tokenId}  ${files > 0 ? chalk.green(`${files} files, ${formatBytes(bytes)}`) : chalk.gray('empty')}`));
    }
  }
  console.log();
}

function formatBytes(n: number): string {
  if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(2) + ' MB';
  if (n > 1e3) return (n / 1e3).toFixed(2) + ' KB';
  return n + ' B';
}
