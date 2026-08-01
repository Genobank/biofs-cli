import * as fs from 'fs-extra';
import * as path from 'path';
import { CONFIG } from './constants';

/**
 * Resolve ~/.biofs (or a named profile under ~/.biofs/profiles/<name>).
 *
 * Dual-role E2E (patient vault vs researcher):
 *   BIOFS_PROFILE=patient     → ~/.biofs/profiles/patient/
 *   BIOFS_PROFILE=researcher  → ~/.biofs/profiles/researcher/
 *   BIOFS_HOME=/custom/path   → overrides everything (absolute profile root)
 *
 * Default (no env) stays ~/.biofs for backward compatibility.
 */
function resolveConfigDir(): string {
  if (process.env.BIOFS_HOME && process.env.BIOFS_HOME.trim()) {
    return path.resolve(process.env.BIOFS_HOME.trim());
  }
  const base = path.join(CONFIG.HOME_DIR, CONFIG.CONFIG_DIR_NAME);
  const profile = (process.env.BIOFS_PROFILE || '').trim();
  if (profile) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) {
      throw new Error(
        `Invalid BIOFS_PROFILE "${profile}". Use letters, digits, _ or - only.`
      );
    }
    return path.join(base, 'profiles', profile);
  }
  return base;
}

export function getActiveProfileName(): string {
  if (process.env.BIOFS_HOME && process.env.BIOFS_HOME.trim()) {
    return `home:${path.resolve(process.env.BIOFS_HOME.trim())}`;
  }
  const profile = (process.env.BIOFS_PROFILE || '').trim();
  return profile || 'default';
}

export class ConfigPaths {
  private static instance: ConfigPaths;

  static getInstance(): ConfigPaths {
    if (!ConfigPaths.instance) {
      ConfigPaths.instance = new ConfigPaths();
    }
    return ConfigPaths.instance;
  }

  /** Force re-bind after BIOFS_PROFILE changes in-process (rare; mostly for tests). */
  static resetInstance(): void {
    ConfigPaths.instance = new ConfigPaths();
  }

  async ensureDirectories(): Promise<void> {
    const configDir = this.getConfigDir();
    await fs.ensureDir(configDir);
    await fs.ensureDir(this.getCacheDir());
    await fs.ensureDir(this.getLogsDir());
  }

  getConfigDir(): string {
    return resolveConfigDir();
  }

  getCredentialsPath(): string {
    return path.join(this.getConfigDir(), CONFIG.CREDENTIALS_FILE);
  }

  getConfigPath(): string {
    return path.join(this.getConfigDir(), CONFIG.CONFIG_FILE);
  }

  getCacheDir(): string {
    return path.join(this.getConfigDir(), 'cache');
  }

  getCacheFilePath(filename: string): string {
    return path.join(this.getCacheDir(), filename);
  }

  getLogsDir(): string {
    return path.join(this.getConfigDir(), 'logs');
  }

  getLogFilePath(filename: string): string {
    return path.join(this.getLogsDir(), filename);
  }

  getRoomSessionPath(): string {
    return path.join(this.getConfigDir(), 'active_room.json');
  }

  getResearcherProfilePath(): string {
    return path.join(this.getConfigDir(), 'researcher.json');
  }

  getProfilesRoot(): string {
    return path.join(CONFIG.HOME_DIR, CONFIG.CONFIG_DIR_NAME, 'profiles');
  }
}
