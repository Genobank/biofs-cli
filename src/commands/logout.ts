import { CredentialsManager } from '../lib/auth/credentials';
import { Logger } from '../lib/utils/logger';

export async function logoutCommand(): Promise<void> {
  const credManager = CredentialsManager.getInstance();

  const hadCreds = await credManager.hasCredentials();
  await credManager.clearCredentials();

  if (hadCreds) {
    Logger.success('Credentials cleared');
    Logger.info('Removed: ~/.genobank/credentials.json');
  } else {
    Logger.info('No credentials to clear');
  }
}

