# BioFS - GenoBank.io CLI

**BioFS** by GenoBank.io - Command-line interface to manage your BioNFTs and BioFiles from the terminal.

## Features

- 🔐 **Web3 Authentication**: Secure wallet-based authentication
- 📁 **File Discovery**: List all your BioFiles from S3, IPFS, and Story Protocol
- 📥 **Download Files**: Download by BioCID or filename with progress bars
- 📤 **Upload Files**: Upload genomic data with optional NFT tokenization
- 🗂️ **NFS Mount Support**: Mount BioNFT-gated files as true filesystem (NEW in v2.0!)
- 🤖 **BioOS Job Management**: Run research pipelines with natural language prompts
- ⛓️ **Story Protocol Integration**: Track IP asset lineage across workflows
- 🔗 **BioCID Resolution**: Universal file identifier system
- 🎨 **Beautiful Output**: Color-coded, formatted terminal output

## Installation

```bash
# Install globally
npm install -g @genobank/biofs

# Or run locally
cd /home/ubuntu/genobank-cli
npm install
npm run build
npm link
```

## Quick Start

### 1. Authenticate

```bash
biofs login
# Browser opens for Web3 authentication
# ✅ Authenticated as: 0x5f5a...d19a
```

### 2. List Your Files

```bash
biofs files
# 📁 Your BioFiles (12 files)
# Shows all files from S3, IPFS, and Story Protocol
```

### 3. Download a File

```bash
# By filename
biofs download my-genome.vcf

# By BioCID
biofs download biocid://0x5f5a.../vcf/my-genome.vcf

# To specific location
biofs download my-genome.vcf ~/analysis/
```

### 4. Upload a File

```bash
# Simple upload
biofs upload ~/data/sample.vcf

# Upload and mint as NFT
biofs upload ~/data/sample.vcf --tokenize

# Upload with file type
biofs upload ~/data/reads.fastq.gz --type fastq
```

### 5. Mount Files as Filesystem (NEW in v2.0!)

```bash
# Mount all granted files via NFS
biofs mount /mnt/genomics --method nfs

# Mount specific BioCID
biofs mount /mnt/sample --method nfs --biocid biocid://0x.../bioip/0x...

# Use standard bioinformatics tools
bcftools view /mnt/genomics/sample.vcf | head -20
igv /mnt/genomics/sample.vcf

# Unmount when done
biofs umount /mnt/genomics

# Traditional copy method (downloads files)
biofs mount /mnt/genomics --method copy
```

**Requirements for NFS mount:**
- BioNFS server installed: `cd /home/ubuntu/bionfs && make install`
- NFS client: `sudo apt-get install nfs-common`
- Root access for system mount

## Commands

### Authentication

- `biofs login` - Authenticate with Web3 wallet
- `biofs logout` - Clear stored credentials
- `biofs whoami` - Show current authenticated wallet

### File Management

- `biofs files [--filter <type>] [--source <source>]` - List BioFiles
- `biofs download <file> [destination]` - Download file
- `biofs upload <file> [--tokenize]` - Upload file
- `biofs mount <mountpoint> [--method nfs|copy] [--biocid <biocid>]` - Mount files as filesystem
- `biofs umount <mountpoint> [--force]` - Unmount filesystem

### BioOS Job Management

- `biofs job create "<prompt>" <file>` - Create research job from natural language
- `biofs job status <job_id> [--watch]` - Check job execution status
- `biofs job results <job_id>` - Get job results with download URLs
- `biofs job list [--status <status>]` - List all your research jobs
- `biofs job pipelines` - List available pipeline templates

**Quick Example:**
```bash
# List available pipelines
biofs job pipelines

# Create annotation job
biofs job create "Annotate VCF with rare coding variants" sample.vcf --pipeline vcf_annotation

# Watch progress in real-time
biofs job status <job_id> --watch

# Download results
biofs job results <job_id>
```

📚 **Full Documentation**: [BIOOS_JOB_MANAGEMENT.md](BIOOS_JOB_MANAGEMENT.md)

## BioCID Format

BioCID is a universal identifier for genomic files:

```
biocid://<wallet>/<type>/<identifier>

Example:
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/vcf/hereditary-cancer-2024.vcf
```

## Configuration

Configuration is stored in `~/.genobank/`:

- `credentials.json` - Encrypted authentication (0600 permissions)
- `config.json` - User preferences
- `cache/` - Cached file metadata
- `logs/` - Operation logs

## Security

- Credentials are stored with 0600 permissions (owner read/write only)
- Signatures are never logged or displayed
- Auto-expiry after 30 days
- Secure deletion on logout (overwrite before delete)

## Development

```bash
# Clone repository
git clone https://github.com/genobank/genobank-cli.git
cd genobank-cli

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run locally
npm run dev -- login

# Link for global use
npm link
```

## Environment Variables

- `DEBUG=1` - Enable debug logging
- `NO_COLOR=1` - Disable colored output

## Support

- **API Docs**: https://genobank.app/static/Genobank_API_Educational_Guide.html
- **GitHub**: https://github.com/genobank
- **Email**: support@genobank.io

## License

MIT © GenoBank.io
