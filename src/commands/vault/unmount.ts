/** `biofs vault unmount` — remove local cache directory. Manifest preserved
 *  unless --purge is passed; `biofs vault mount` re-populates from it. */
import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inquirer from 'inquirer';

export async function vaultUnmountCommand(options: { path?: string; purge?: boolean; force?: boolean }): Promise<void> {
  const vaultPath = options.path || path.join(os.homedir(), 'genobank', 'vault');
  const manifestFile = path.join(vaultPath, '.manifest.json');
  if (!fs.existsSync(vaultPath)) {
    console.log(chalk.gray(`no vault at ${vaultPath}`));
    return;
  }

  if (!options.force) {
    const { go } = await inquirer.prompt([{
      type: 'confirm', name: 'go', default: false,
      message: options.purge
        ? `Delete ${vaultPath} entirely (manifest + all downloaded files)?`
        : `Remove local cache at ${vaultPath}/<*>/{raw,annotated,reports}/ but keep the manifest?`,
    }]);
    if (!go) return;
  }

  if (options.purge) {
    fs.rmSync(vaultPath, { recursive: true, force: true });
    console.log(chalk.green(`✓ removed ${vaultPath}`));
    return;
  }

  if (!fs.existsSync(manifestFile)) {
    console.log(chalk.yellow(`no manifest at ${manifestFile} — nothing to selectively unmount; pass --purge to delete the whole dir`));
    return;
  }
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  let removed = 0;
  for (const b of m.bionfts) {
    const slug = `${b.category.toLowerCase()}-${b.tokenId}`;
    const dir = path.join(vaultPath, slug);
    for (const sub of ['raw', 'annotated', 'reports']) {
      const p = path.join(dir, sub);
      if (!fs.existsSync(p)) continue;
      for (const f of fs.readdirSync(p)) {
        fs.unlinkSync(path.join(p, f));
        removed++;
      }
    }
  }
  console.log(chalk.green(`✓ removed ${removed} cached files (manifest preserved)`));
}
