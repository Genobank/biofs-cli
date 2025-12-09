import axios from 'axios';
import os from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';

interface ErrorReport {
    biofs_version: string;
    command: string;
    error_message: string;
    error_stack?: string;
    wallet_address?: string;
    system_info: {
        platform: string;
        arch: string;
        node_version: string;
        os_version: string;
    };
    timestamp: string;
}

export class ErrorReporter {
    private static TELEMETRY_ENDPOINT = 'https://genobank.app/api_biofs_telemetry';
    private static enabled = true; // Can be disabled via env var

    /**
     * Report an error to GenoBank.io telemetry endpoint
     * This helps us fix bugs and improve BioFS remotely
     */
    static async report(
        command: string,
        error: Error,
        walletAddress?: string,
        additionalContext?: Record<string, any>
    ): Promise<void> {
        // Check if telemetry is disabled
        if (process.env.BIOFS_TELEMETRY === 'false') {
            return;
        }

        if (!this.enabled) {
            return;
        }

        try {
            // Get BioFS version from package.json
            const packageJsonPath = join(__dirname, '../../package.json');
            let version = '2.0.2';
            try {
                const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
                version = packageJson.version;
            } catch (e) {
                // Fallback to hardcoded version
            }

            const report: ErrorReport = {
                biofs_version: version,
                command: command,
                error_message: error.message,
                error_stack: error.stack,
                wallet_address: walletAddress,
                system_info: {
                    platform: os.platform(),
                    arch: os.arch(),
                    node_version: process.version,
                    os_version: os.release()
                },
                timestamp: new Date().toISOString()
            };

            // Add any additional context (sanitized)
            if (additionalContext) {
                (report as any).context = this.sanitizeContext(additionalContext);
            }

            // Send to telemetry endpoint (fire and forget, with timeout)
            await axios.post(this.TELEMETRY_ENDPOINT, report, {
                timeout: 3000, // 3 second timeout
                headers: {
                    'Content-Type': 'application/json'
                }
            });
        } catch (telemetryError) {
            // Silently fail - don't interrupt user's workflow
            // Telemetry should never cause issues for the user
        }
    }

    /**
     * Sanitize context data to remove sensitive information
     */
    private static sanitizeContext(context: Record<string, any>): Record<string, any> {
        const sanitized: Record<string, any> = {};

        for (const [key, value] of Object.entries(context)) {
            // Skip sensitive keys
            if (this.isSensitiveKey(key)) {
                sanitized[key] = '[REDACTED]';
                continue;
            }

            // Sanitize string values that might contain paths
            if (typeof value === 'string') {
                sanitized[key] = this.sanitizePath(value);
            } else if (typeof value === 'object' && value !== null) {
                // Recursively sanitize objects
                sanitized[key] = this.sanitizeContext(value);
            } else {
                sanitized[key] = value;
            }
        }

        return sanitized;
    }

    /**
     * Check if a key name suggests sensitive data
     */
    private static isSensitiveKey(key: string): boolean {
        const sensitivePatterns = [
            'password', 'secret', 'token', 'key', 'private',
            'credential', 'auth', 'signature', 'wallet_key'
        ];
        const lowerKey = key.toLowerCase();
        return sensitivePatterns.some(pattern => lowerKey.includes(pattern));
    }

    /**
     * Sanitize file paths to remove username information
     */
    private static sanitizePath(path: string): string {
        // Replace home directory paths
        const homeDir = os.homedir();
        if (path.includes(homeDir)) {
            return path.replace(homeDir, '~');
        }

        // Replace /Users/username or /home/username patterns
        return path.replace(/\/(Users|home)\/[^\/]+/g, '/~');
    }

    /**
     * Wrap a command execution with automatic error reporting
     */
    static async wrapCommand<T>(
        commandName: string,
        walletAddress: string | undefined,
        fn: () => Promise<T>,
        context?: Record<string, any>
    ): Promise<T> {
        try {
            return await fn();
        } catch (error) {
            // Report the error
            await this.report(commandName, error as Error, walletAddress, context);

            // Re-throw so normal error handling continues
            throw error;
        }
    }

    /**
     * Disable telemetry (can be called by user preference)
     */
    static disable(): void {
        this.enabled = false;
    }

    /**
     * Enable telemetry
     */
    static enable(): void {
        this.enabled = true;
    }
}

