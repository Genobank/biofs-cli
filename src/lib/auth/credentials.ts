import * as fs from 'fs-extra';
import * as path from 'path';
import { Credentials, UserConfig } from '../../types/credentials';
import { ConfigPaths } from '../config/paths';
import { CONFIG } from '../config/constants';

export class CredentialsManager {
  private static instance: CredentialsManager;
  private paths: ConfigPaths;

  private constructor() {
    this.paths = ConfigPaths.getInstance();
  }

  static getInstance(): CredentialsManager {
    if (!CredentialsManager.instance) {
      CredentialsManager.instance = new CredentialsManager();
    }
    return CredentialsManager.instance;
  }

  async saveCredentials(wallet: string, signature: string): Promise<void> {
    await this.paths.ensureDirectories();

    const now = new Date();
    const expires = new Date();
    expires.setDate(expires.getDate() + CONFIG.CREDENTIAL_EXPIRY_DAYS);

    const credentials: Credentials = {
      wallet_address: wallet,
      user_signature: signature,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      last_used: now.toISOString()
    };

    const credPath = this.paths.getCredentialsPath();
    await fs.writeJson(credPath, credentials, { spaces: 2 });

    // Set file permissions to 0600 (owner read/write only)
    await fs.chmod(credPath, 0o600);
  }

  async loadCredentials(): Promise<Credentials | null> {
    const credPath = this.paths.getCredentialsPath();

    try {
      if (!await fs.pathExists(credPath)) {
        return null;
      }

      const credentials: Credentials = await fs.readJson(credPath);

      // Check if expired
      const expires = new Date(credentials.expires_at);
      if (expires < new Date()) {
        await this.clearCredentials();
        return null;
      }

      // Update last_used timestamp
      credentials.last_used = new Date().toISOString();
      await fs.writeJson(credPath, credentials, { spaces: 2 });

      return credentials;
    } catch (error) {
      return null;
    }
  }

  async clearCredentials(): Promise<void> {
    const credPath = this.paths.getCredentialsPath();

    if (await fs.pathExists(credPath)) {
      // Overwrite file content before deleting for security
      const size = (await fs.stat(credPath)).size;
      await fs.writeFile(credPath, Buffer.alloc(size));
      await fs.remove(credPath);
    }
  }

  async hasCredentials(): Promise<boolean> {
    const creds = await this.loadCredentials();
    return creds !== null;
  }

  async saveConfig(config: UserConfig): Promise<void> {
    await this.paths.ensureDirectories();
    const configPath = this.paths.getConfigPath();

    const defaultConfig: UserConfig = {
      default_download_dir: path.join(CONFIG.HOME_DIR, 'Downloads', 'genobank'),
      api_base_url: CONFIG.API_BASE_URL,
      auth_base_url: CONFIG.AUTH_BASE_URL,
      callback_port: CONFIG.CALLBACK_PORT,
      auto_open_browser: true,
      show_progress: true,
      cache_duration_ms: CONFIG.CACHE_DURATION_MS
    };

    const finalConfig = { ...defaultConfig, ...config };
    await fs.writeJson(configPath, finalConfig, { spaces: 2 });
  }

  async loadConfig(): Promise<UserConfig> {
    const configPath = this.paths.getConfigPath();

    const defaultConfig: UserConfig = {
      default_download_dir: path.join(CONFIG.HOME_DIR, 'Downloads', 'genobank'),
      api_base_url: CONFIG.API_BASE_URL,
      auth_base_url: CONFIG.AUTH_BASE_URL,
      callback_port: CONFIG.CALLBACK_PORT,
      auto_open_browser: true,
      show_progress: true,
      cache_duration_ms: CONFIG.CACHE_DURATION_MS
    };

    try {
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJson(configPath);
        return { ...defaultConfig, ...config };
      }
    } catch (error) {
      // Use defaults on error
    }

    // Save default config if it doesn't exist
    await this.saveConfig(defaultConfig);
    return defaultConfig;
  }
}

// Export convenience function for getting credentials
export async function getCredentials(): Promise<Credentials | null> {
  return CredentialsManager.getInstance().loadCredentials();
}
