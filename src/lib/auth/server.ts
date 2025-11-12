import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../config/constants';

export interface AuthCallbackResult {
  wallet: string;
  signature: string;
  sessionId: string;
}

export class CallbackServer {
  private app: Express;
  private server: Server | null = null;
  private sessionId: string;
  private resolveAuth: ((result: AuthCallbackResult) => void) | null = null;
  private rejectAuth: ((error: Error) => void) | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.sessionId = uuidv4();
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get(CONFIG.CALLBACK_PATH, (req: Request, res: Response) => {
      // Support multiple parameter formats:
      // 1. BioFS format: wallet, signature, sessionId
      // 2. Auth service format: user_wallet, user_signature, fromAuth
      // 3. Short format: wallet, sig, fromAuth
      let { wallet, signature, sessionId, sig } = req.query;
      const { user_wallet, user_signature, fromAuth } = req.query;

      // Map auth service parameters to BioFS format
      if (user_wallet && user_signature) {
        wallet = user_wallet;
        signature = user_signature;
        // If fromAuth=true, skip sessionId validation (auth service doesn't send it)
        if (fromAuth === 'true') {
          sessionId = this.sessionId; // Use current session
        }
      }

      // Support 'sig' as alias for 'signature'
      if (!signature && sig) {
        signature = sig as string;
        if (fromAuth === 'true') {
          sessionId = this.sessionId;
        }
      }

      // Validate session (only if sessionId was provided or not from auth service)
      if (!fromAuth && sessionId !== this.sessionId) {
        res.status(400).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Authentication Error</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #d32f2f; font-size: 24px; margin: 20px; }
              </style>
            </head>
            <body>
              <div class="error">❌ Invalid session. Please try again.</div>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
        return;
      }

      // Validate parameters
      if (!wallet || !signature) {
        res.status(400).send(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>Authentication Error</title>
              <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #d32f2f; font-size: 24px; margin: 20px; }
              </style>
            </head>
            <body>
              <div class="error">❌ Authentication failed - missing parameters</div>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
        return;
      }

      // Success response
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Authentication Successful</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
              .success { color: #4caf50; font-size: 48px; margin: 20px; }
              .wallet { font-family: monospace; background: #fff; padding: 10px; border-radius: 5px; margin: 20px auto; max-width: 600px; word-break: break-all; }
              .message { font-size: 18px; color: #666; margin: 20px; }
              .close-hint { color: #999; margin-top: 30px; }
            </style>
            <script>
              setTimeout(() => {
                window.close();
              }, 3000);
            </script>
          </head>
          <body>
            <div class="success">✅</div>
            <h1>Authentication Successful!</h1>
            <div class="wallet">Wallet: ${wallet}</div>
            <div class="message">You can now return to the CLI</div>
            <div class="close-hint">This window will close automatically in 3 seconds...</div>
          </body>
        </html>
      `);

      // Resolve the authentication promise
      if (this.resolveAuth) {
        this.resolveAuth({
          wallet: wallet as string,
          signature: signature as string,
          sessionId: sessionId as string
        });
      }

      // Close server after successful auth
      setTimeout(() => this.stop(), 1000);
    });

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', sessionId: this.sessionId });
    });
  }

  async start(port: number = CONFIG.CALLBACK_PORT): Promise<AuthCallbackResult> {
    return new Promise((resolve, reject) => {
      this.resolveAuth = resolve;
      this.rejectAuth = reject;

      // Try to start server
      this.server = this.app.listen(port, () => {
        console.log(`🔐 Callback server listening on http://localhost:${port}`);
      });

      this.server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          // Try alternative port
          const altPort = port + Math.floor(Math.random() * 1000);
          console.log(`⚠️  Port ${port} in use, trying ${altPort}...`);
          this.server = this.app.listen(altPort, () => {
            console.log(`🔐 Callback server listening on http://localhost:${altPort}`);
          });
        } else {
          reject(error);
        }
      });

      // Set timeout
      this.timeoutHandle = setTimeout(() => {
        this.stop();
        reject(new Error('Authentication timeout'));
      }, CONFIG.AUTH_TIMEOUT_MS);
    });
  }

  stop(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getCallbackUrl(port: number = CONFIG.CALLBACK_PORT): string {
    return `http://localhost:${port}${CONFIG.CALLBACK_PATH}`;
  }
}