# BioFS CLI v1.6.0 - Programmatic Authentication Enhancement

## Overview

BioFS v1.6.0 introduces programmatic authentication via command-line parameters, enabling server-side and CI/CD workflows while maintaining full NFT-gated security.

## New Features

### Direct Authentication with Wallet & Signature

Previously, `biofs login` required interactive browser authentication. Now you can authenticate directly:

```bash
biofs login --wallet <WALLET_ADDRESS> --signature <SIGNATURE>
```

### Use Cases

1. **Server-Side Scripts**: Authenticate BioFS in production APIs without browser interaction
2. **CI/CD Pipelines**: Automated genomic data processing workflows
3. **Batch Processing**: Process multiple BioFiles programmatically
4. **API Integration**: Integrate BioFS with backend services

## Installation

```bash
npm install -g @genobank/biofs@1.6.0
```

## Usage

### Method 1: Direct Authentication (New in v1.6.0)

```bash
# Authenticate with wallet and signature
biofs login --wallet 0x5f5a60eaef242c0d51a21c703f520347b96ed19a \
            --signature 0xa5141ae955bba91ad46a940aefc3b05120489b8b776a180668e5b849f16254d44982fb867724390b388ea3bbc606ab4128e264c7b4d3de4082aeb63c3144af501c

# Verify authentication
biofs whoami

# List your BioFiles (NFT-gated)
biofs files

# Download a specific file
biofs download <biocid> ./output.vcf
```

### Method 2: Browser Authentication (Still Supported)

```bash
# Traditional browser-based flow
biofs login  # Opens auth.genobank.app in browser
```

## Environment Variable Pattern

For production deployments, store credentials in environment variables:

```bash
# .env file
BIOFS_WALLET=0x5f5a60eaef242c0d51a21c703f520347b96ed19a
BIOFS_SIGNATURE=0xa5141ae955bba91ad46a940aefc3b05120489b8b776a180668e5b849f16254d44982fb867724390b388ea3bbc606ab4128e264c7b4d3de4082aeb63c3144af501c

# Script usage
biofs login --wallet $BIOFS_WALLET --signature $BIOFS_SIGNATURE
```

## Integration Example: Claude AI API with BioFS

```python
# api_claude_ia_researcher_web3.py
import os
import subprocess

class ClaudeGenomicAPI:
    def __init__(self):
        self.wallet = os.environ['BIOFS_WALLET']
        self.signature = os.environ['BIOFS_SIGNATURE']
        self._authenticate()
    
    def _authenticate(self):
        """Authenticate BioFS with wallet/signature"""
        subprocess.run([
            'biofs', 'login', 
            '--wallet', self.wallet,
            '--signature', self.signature
        ], check=True)
    
    def load_sqlite_from_biofs(self, biocid):
        """Download SQLite DB from BioFS (NFT-gated)"""
        output_path = f'/tmp/{biocid}.sqlite'
        subprocess.run([
            'biofs', 'download', biocid, output_path
        ], check=True)
        return output_path
    
    def analyze_variants(self, biocid):
        """Analyze variants from BioFS-gated SQLite"""
        sqlite_path = self.load_sqlite_from_biofs(biocid)
        # Load into SQLite and query variants
        # Send to Claude AI for analysis
        # Return insights
        pass
```

## Security Considerations

### NFT-Gated Access Control
- Direct authentication maintains the same BioNFT permission model
- Only files owned by the authenticated wallet are accessible
- All access is logged on-chain via Story Protocol

### Credential Validation
- Wallet address: Validated as 40-character hex Ethereum address
- Signature: Validated as 130-character hex (65-byte) signature
- Invalid credentials are rejected before any API calls

### Credential Storage
- Stored in `~/.genobank/credentials.json`
- File permissions: Read/write for owner only
- 30-day expiration by default

## Migration Guide

### From v1.5.2 to v1.6.0

No code changes required! The enhancement is fully backward compatible.

**Option A: Keep Using Browser Auth**
```bash
biofs login  # Works exactly as before
```

**Option B: Upgrade to Programmatic Auth**
```bash
# Generate signature once via browser
biofs login  # Opens browser, sign with MetaMask

# Extract credentials for reuse
cat ~/.genobank/credentials.json

# Use extracted credentials in scripts
biofs login --wallet <WALLET> --signature <SIGNATURE>
```

## Troubleshooting

### Invalid Wallet Format
```
Error: Invalid wallet address format. Expected Ethereum address (0x...)
```
**Solution**: Ensure wallet starts with `0x` and contains exactly 40 hexadecimal characters

### Invalid Signature Format
```
Error: Invalid signature format. Expected 65-byte signature (0x...)
```
**Solution**: Ensure signature starts with `0x` and contains exactly 130 hexadecimal characters (65 bytes)

### NFT Access Denied
```
Error: Access denied. BioNFT ownership verification failed.
```
**Solution**: Verify you own the BioNFT for the requested file. Check ownership on Story Protocol.

## Technical Implementation

### Modified Files
1. **src/commands/login.ts**
   - Added `wallet` and `signature` to `LoginOptions` interface
   - Implemented direct authentication flow
   - Added validation logic for wallet/signature formats

2. **src/index.ts**
   - Registered `--wallet` and `--signature` CLI options
   - Updated command description

3. **package.json**
   - Version bump: 1.5.2 → 1.6.0

### Code Flow

```
biofs login --wallet 0x... --signature 0x...
  ↓
LoginOptions interface validates parameters
  ↓
Wallet format validation (^0x[a-fA-F0-9]{40}$)
  ↓
Signature format validation (^0x[a-fA-F0-9]{130}$)
  ↓
CredentialsManager.saveCredentials()
  ↓
Credentials stored in ~/.genobank/credentials.json
  ↓
Success message with available commands
```

## Version History

- **v1.6.0** (2025-10-16): Programmatic authentication via `--wallet` and `--signature`
- **v1.5.2** (Previous): Browser-based authentication only

## Support

- GitHub Issues: https://github.com/genobank/biofs-cli/issues
- Documentation: https://docs.genobank.io/biofs
- Email: tech@genobank.io

## License

MIT License - See LICENSE file for details

---

**Built with ❤️ by GenoBank.io**  
*Empowering genomic data ownership through blockchain technology*
