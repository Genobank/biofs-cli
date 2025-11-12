# BioFS Quick Start Guide

**BioFS by GenoBank.io** - Command-line interface for managing BioFiles and BioNFTs

## 🚀 Quick Commands

### Authentication
```bash
# Login with Web3 wallet (opens browser)
biofs login

# Check who you are
biofs whoami

# Logout
biofs logout
```

### File Management
```bash
# List all your BioFiles
biofs files

# List only VCF files
biofs files --filter vcf

# List files from S3 only
biofs files --source s3

# Get JSON output
biofs files --json

# Force refresh (clear cache)
biofs files --refresh
```

### Download Files
```bash
# Download by filename
biofs download my-genome.vcf

# Download by BioCID
biofs download biocid://0x5f5a.../vcf/my-genome.vcf

# Download to specific location
biofs download my-genome.vcf ~/analysis/

# Download with no progress bar (quiet mode)
biofs download my-genome.vcf --quiet
```

### Upload Files
```bash
# Simple upload
biofs upload ~/data/sample.vcf

# Upload and mint as NFT
biofs upload ~/data/sample.vcf --tokenize

# Upload with file type
biofs upload ~/data/reads.fastq.gz --type fastq

# Upload and share with lab
biofs upload ~/data/report.pdf --share-with 0x1234...5678
```

## 📍 BioCID Format

BioCID is a universal identifier for genomic files:

```
biocid://<wallet>/<type>/<identifier>

Examples:
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/vcf/hereditary-cancer-2024.vcf
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/fastq/sample-001-R1.fastq.gz
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/analysis/alphagenome-job-123
```

## 🔐 Credentials

Your credentials are stored securely at:
```
~/.genobank/credentials.json
```

Permissions: `0600` (owner read/write only)
Expiration: 30 days after authentication

## ⚙️ Configuration

Edit your preferences at:
```
~/.genobank/config.json
```

Available settings:
- `default_download_dir` - Where files are downloaded
- `api_base_url` - GenoBank API URL
- `auth_base_url` - Auth service URL
- `callback_port` - OAuth callback port (default: 44321)
- `auto_open_browser` - Auto-open browser for auth (default: true)
- `show_progress` - Show progress bars (default: true)

## 🆘 Help

Get help for any command:
```bash
biofs --help
biofs login --help
biofs files --help
biofs download --help
biofs upload --help
```

## 🔗 Important URLs

- **Main API**: https://genobank.app
- **Auth Service**: https://auth.genobank.app
- **Documentation**: https://genobank.io
- **Support**: support@genobank.io

## 🛠️ Troubleshooting

### "Not authenticated"
```bash
biofs logout
biofs login
```

### "BioCID not found"
```bash
# Refresh your file list
biofs files --refresh
```

### "Permission denied"
```bash
# Check credentials file permissions
ls -la ~/.genobank/credentials.json

# Should be: -rw------- (0600)
# Fix if needed:
chmod 0600 ~/.genobank/credentials.json
```

### Clear cache
```bash
rm -rf ~/.genobank/cache/
```

## 🎯 Example Workflow

```bash
# 1. Authenticate
biofs login
# ✅ Authenticated as: 0x5f5a...d19a

# 2. List your files
biofs files --filter vcf
# 📁 Your BioFiles (3 VCF files)

# 3. Download a file
biofs download hereditary-cancer-2024.vcf
# 📥 Downloading: hereditary-cancer-2024.vcf
# ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100%
# ✅ Downloaded to: ~/Downloads/genobank/hereditary-cancer-2024.vcf

# 4. Upload a new file as NFT
biofs upload ~/analysis/variants.vcf --tokenize
# 📤 Uploading: variants.vcf
# ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 100%
# 🔗 Minting NFT...
# ✅ NFT minted: 0x789a...bcde
# BioCID: biocid://0x5f5a.../vcf/variants.vcf
```

## 🚨 Important Notes

### Two BioFS Tools
- **`biofs`** - This CLI tool (Node.js) - File management
- **`biofs-mount`** - FUSE filesystem (Go) - Mount genomic data

### Security
- Never share your `user_signature` - treat it like a password
- Credentials auto-expire after 30 days
- File permissions are enforced (0600 for credentials)
- All API calls use HTTPS only

### File Sources
BioFS discovers files from:
- **S3**: GenoBank cloud storage
- **IPFS**: Decentralized storage
- **Story Protocol**: Tokenized NFT assets

---

**Version**: 1.0.0
**Created**: October 4, 2025
**By**: GenoBank.io Team
