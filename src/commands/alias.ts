/**
 * `biofs alias` — manage local aliases for ip_ids / BioCIDs.
 *
 *   biofs alias                    # list (default)
 *   biofs alias my-wes 0xCCe14315…
 *   biofs alias --remove my-wes
 */
import { Logger } from '../lib/utils/logger';
import { loadAliases, saveAliases, aliasFilePath } from '../lib/aliases/store';

export interface AliasOptions {
  name?: string;
  target?: string;
  remove?: string;
  list?: boolean;
  json?: boolean;
}

export async function aliasCommand(opts: AliasOptions = {}): Promise<void> {
  const aliases = loadAliases();

  // List mode — default when no args OR --list
  if (opts.list || (!opts.name && !opts.remove)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(aliases, null, 2) + '\n');
      return;
    }
    if (Object.keys(aliases).length === 0) {
      Logger.info(`no aliases defined (${aliasFilePath()})`);
      return;
    }
    const maxName = Math.max(...Object.keys(aliases).map((k) => k.length), 5);
    console.log(`${'ALIAS'.padEnd(maxName)}  TARGET`);
    for (const k of Object.keys(aliases).sort()) {
      console.log(`${k.padEnd(maxName)}  ${aliases[k]}`);
    }
    return;
  }

  // Remove mode
  if (opts.remove) {
    if (!(opts.remove in aliases)) {
      Logger.error(`no such alias: ${opts.remove}`);
      process.exit(1);
    }
    delete aliases[opts.remove];
    saveAliases(aliases);
    Logger.info(`removed alias '${opts.remove}'`);
    return;
  }

  // Add mode — require both name and target
  if (!opts.target) {
    Logger.error('usage: biofs alias <name> <ip_id_or_biocid>');
    process.exit(2);
  }
  if (opts.name!.startsWith('0x') || opts.name!.startsWith('biocid://')) {
    Logger.error(`alias name '${opts.name}' looks like an id — pick something human-friendly`);
    process.exit(2);
  }
  aliases[opts.name!] = opts.target;
  saveAliases(aliases);
  Logger.info(`alias '${opts.name}' → ${opts.target}  (${aliasFilePath()})`);
}
