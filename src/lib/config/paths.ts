import * as fs from 'fs-extra';
import * as path from 'path';
import { CONFIG } from './constants';

export class ConfigPaths {
  private static instance: ConfigPaths;

  private configDir: string;
  private credentialsPath: string;
  private configPath: string;
  private cacheDir: string;
  private logsDir: string;

  private constructor() {
    this.configDir = path.join(CONFIG.HOME_DIR, CONFIG.CONFIG_DIR_NAME);
    this.credentialsPath = path.join(this.configDir, CONFIG.CREDENTIALS_FILE);
    this.configPath = path.join(this.configDir, CONFIG.CONFIG_FILE);
    this.cacheDir = path.join(this.configDir, 'cache');
    this.logsDir = path.join(this.configDir, 'logs');
  }

  static getInstance(): ConfigPaths {
    if (!ConfigPaths.instance) {
      ConfigPaths.instance = new ConfigPaths();
    }
    return ConfigPaths.instance;
  }

  async ensureDirectories(): Promise<void> {
    await fs.ensureDir(this.configDir);
    await fs.ensureDir(this.cacheDir);
    await fs.ensureDir(this.logsDir);
  }

  getConfigDir(): string {
    return this.configDir;
  }

  getCredentialsPath(): string {
    return this.credentialsPath;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getCacheFilePath(filename: string): string {
    return path.join(this.cacheDir, filename);
  }

  getLogsDir(): string {
    return this.logsDir;
  }

  getLogFilePath(filename: string): string {
    return path.join(this.logsDir, filename);
  }
}
