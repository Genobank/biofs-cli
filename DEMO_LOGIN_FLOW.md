# GenoBank CLI Login Flow Demonstration

## How Authentication Works

When a user runs `genobank login`, the following happens:

### 1. Start Local Callback Server
- CLI starts an HTTP server on `http://localhost:44321`
- Generates a unique session ID for CSRF protection
- Listens for the authentication callback

### 2. Open Browser for Web3 Authentication
```
🌐 Opening browser for authentication...
⏳ Waiting for authentication (timeout: 5 minutes)...
```

Browser opens to:
```
https://auth.genobank.app?returnUrl=http://localhost:44321/callback&sessionId=UNIQUE_ID&cli=true
```

### 3. User Authenticates in Browser
- User connects their Web3 wallet (MetaMask, WalletConnect, Magic.link, etc.)
- User signs the message: "I want to proceed"
- auth.genobank.app validates the signature

### 4. Callback to Local Server
auth.genobank.app redirects to:
```
http://localhost:44321/callback?wallet=0x5f5a...&signature=0xa514...&sessionId=UNIQUE_ID
```

### 5. CLI Receives Credentials
- Local server validates session ID matches
- Extracts wallet address and signature
- Shows success page in browser
- Browser auto-closes after 3 seconds

### 6. Credentials Stored Securely
```json
~/.genobank/credentials.json (chmod 0600)
{
  "wallet_address": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
  "user_signature": "0xa5141ae955bba91ad46a940aefc3b05120489b8b776a180668e5b849f16254d44982fb867724390b388ea3bbc606ab4128e264c7b4d3de4082aeb63c3144af501c",
  "created_at": "2025-10-04T18:00:00.000Z",
  "expires_at": "2025-11-03T18:00:00.000Z"
}
```

### 7. Success Message
```
╔═══════════════════════════════════════════════════════╗
║                 Authentication Successful              ║
╟─────────────────────────────────────────────────────── ║
║ Wallet: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a    ║
║                                                        ║
║ You can now use:                                      ║
║   genobank files      - List your BioFiles            ║
║   genobank download   - Download files                ║
║   genobank upload     - Upload files                  ║
║   genobank whoami     - Show current wallet           ║
╚═══════════════════════════════════════════════════════╝

✅ Credentials saved to: ~/.genobank/credentials.json
```

## Security Features

1. **Session ID Validation**: Prevents CSRF attacks
2. **0600 Permissions**: Only owner can read/write credentials
3. **Auto-Expiry**: Credentials expire after 30 days
4. **Secure Deletion**: File overwritten before deletion on logout
5. **No Signature Logging**: Signatures never displayed or logged

## Testing Without Browser

For CI/CD or programmatic testing, you can manually set credentials:

```bash
mkdir -p ~/.genobank
cat > ~/.genobank/credentials.json << 'EOF'
{
  "wallet_address": "YOUR_WALLET",
  "user_signature": "YOUR_SIGNATURE",
  "created_at": "2025-10-04T18:00:00.000Z",
  "expires_at": "2025-11-03T18:00:00.000Z"
}
EOF
chmod 0600 ~/.genobank/credentials.json
```

## Implementation Details

The authentication flow is implemented across several modules:

- `src/lib/auth/server.ts` - Local callback HTTP server
- `src/lib/auth/browser.ts` - Browser launching logic
- `src/lib/auth/credentials.ts` - Secure credential storage
- `src/commands/login.ts` - Login command orchestration

This design mimics Claude Code's OAuth flow but uses Web3 signatures instead of OAuth2 tokens, providing blockchain-native authentication for the GenoBank ecosystem.