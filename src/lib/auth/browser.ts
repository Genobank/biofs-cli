import open from 'open';

export class BrowserLauncher {
  static async openAuthUrl(authUrl: string): Promise<void> {
    try {
      await open(authUrl);
    } catch (error) {
      console.error('Failed to open browser automatically.');
      console.log('Please open the following URL in your browser:');
      console.log(authUrl);
    }
  }

  static generateAuthUrl(
    authBaseUrl: string,
    callbackUrl: string,
    sessionId: string
  ): string {
    const params = new URLSearchParams({
      returnUrl: callbackUrl,
      sessionId: sessionId,
      cli: 'true'
    });

    return `${authBaseUrl}?${params.toString()}`;
  }
}