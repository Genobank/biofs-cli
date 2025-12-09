# BioFS CLI User Manual

**Version 2.4.1** | **GenoBank.io**

BioFS is a command-line interface for managing BioNFT-gated genomic data on the Sequentia blockchain. It enables GDPR-compliant file sharing, consent management, and decentralized genomic processing.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [Authentication](#authentication)
4. [File Management](#file-management)
5. [Tokenization](#tokenization)
6. [Access Control](#access-control)
7. [Data Sharing](#data-sharing)
8. [Research Jobs](#research-jobs)
9. [GDPR Compliance](#gdpr-compliance)
10. [Troubleshooting](#troubleshooting)

---

## Installation

### Prerequisites
- Node.js 18.0.0 or higher
- A Web3 wallet (MetaMask recommended)

### Install from npm
```bash
npm install -g @genobank/biofs
```

### Verify Installation
```bash
biofs --version
# Output: 2.4.1
```

---

## Quick Start

### 1. Authenticate
```bash
biofs login
```
This opens your browser for Web3 wallet signature. Your credentials are stored locally in `~/.biofs/`.

### 2. View Your Files
```bash
biofs biofiles
```

### 3. Download a File
```bash
biofs download sample.vcf ./local-copy.vcf
```

### 4. Share with a Lab
```bash
biofs share sample.vcf --lab 0x1234...5678
```

---

## Authentication

### Login (Web3 Wallet)
```bash
biofs login
```
Opens browser for MetaMask signature. Use `--no-browser` for headless environments.

**Options:**
| Option | Description |
|--------|-------------|
| `--port <number>` | Callback server port |
| `--no-browser` | Don't auto-open browser |
| `--timeout <seconds>` | Auth timeout |
| `--wallet <address>` | Direct auth with wallet |
| `--signature <sig>` | Direct auth with signature |

**Direct Authentication (for scripts):**
```bash
biofs login --wallet 0xYourWallet --signature 0xYourSignature
```

### Logout
```bash
biofs logout
```
Clears stored credentials from `~/.biofs/credentials.json`.

### Check Current Session
```bash
biofs whoami
```

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--verify` | Verify signature validity |
| `--check <wallet>` | Verify against specific wallet |

---

## File Management

### List Your BioFiles
```bash
biofs biofiles
```
Discovers files from all sources: Sequentia blockchain, Story Protocol, S3 storage, and BioIP registry.

**Aliases:** `biofs files`, `biofs ls`

**Options:**
| Option | Description |
|--------|-------------|
| `--filter <type>` | Filter by type: vcf, fastq, bam, pdf |
| `--source <source>` | Filter by source: story, avalanche, s3, biofs |
| `--json` | Output as JSON |
| `--update` | Force refresh from blockchain |
| `--verbose` | Show debug information |

**Example:**
```bash
# List only VCF files
biofs biofiles --filter vcf

# JSON output for scripting
biofs biofiles --json
```

### Download Files
```bash
biofs download <biocid_or_filename> [destination]
```

**Alias:** `biofs get`

**Options:**
| Option | Description |
|--------|-------------|
| `--output <path>` | Output file path |
| `--stream` | Stream large files (>100MB) |
| `--quiet` | No progress bar |
| `--skip-consent` | Skip GDPR consent prompt |

**Examples:**
```bash
# Download by filename
biofs download sample.vcf ./downloads/

# Download by BioCID
biofs download biocid://0x123.../bioip/456 ./my-file.vcf

# Stream large file
biofs download genome.bam --stream --output ./genome.bam
```

### Upload Files
```bash
biofs upload <file>
```

**Alias:** `biofs put`

**Options:**
| Option | Description |
|--------|-------------|
| `--type <type>` | File type: vcf, fastq, bam, pdf |
| `--tokenize` | Mint as NFT after upload |
| `--share-with <lab>` | Share with lab after upload |
| `--public` | Make publicly discoverable |
| `--quiet` | No progress output |

**Example:**
```bash
biofs upload ./my-genome.vcf --tokenize --share-with 0xLabWallet
```

### Mount as Filesystem
```bash
biofs mount <mount_point>
```
Mounts your BioFiles as a local filesystem.

**Options:**
| Option | Description |
|--------|-------------|
| `--method <type>` | `nfs` (filesystem) or `copy` (download) |
| `--biocid <biocid>` | Mount specific BioCID only |
| `--port <number>` | NFS server port (default: 2049) |
| `--read-only` | Mount as read-only |
| `--skip-consent` | Skip GDPR consent |

**Examples:**
```bash
# Mount all granted files
biofs mount /mnt/biofiles

# Mount specific biosample on remote GPU agent
biofs mount-remote 55052008714000
```

### Unmount
```bash
biofs umount <mount_point>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--force` | Force unmount even if busy |

---

## Tokenization

Tokenize genomic data as BioNFT on the Sequentia Network for consent-gated access.

### Tokenize Local File
```bash
biofs tokenize file <file>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--title <string>` | Custom NFT title |
| `--description <string>` | Custom description (AI-generated if omitted) |
| `--license <type>` | `commercial` or `non-commercial` |
| `--collection <address>` | Manual collection address |
| `--no-ai` | Skip AI classification |
| `--yes` | Auto-confirm prompts |

**Example:**
```bash
biofs tokenize file ./exome.vcf --license non-commercial --yes
```

### Tokenize FASTQ Files from S3
```bash
biofs tokenize fastqs <biosample_serial>
```
Creates a BioNFT consent record for existing FASTQ files in S3.

**Options:**
| Option | Description |
|--------|-------------|
| `--recipient <wallet>` | Grant access to wallet |
| `--license <type>` | License type |
| `--yes` | Auto-confirm prompts |

**Example:**
```bash
biofs tokenize fastqs 55052008714000 --recipient 0xLabWallet
```

---

## Access Control

Manage who can access your BioNFT-gated genomic data.

### Request Access
```bash
biofs access request <biocid_or_ip_id>
```
Request access to someone else's BioNFT asset.

**Options:**
| Option | Description |
|--------|-------------|
| `--message <string>` | Message to asset owner |

### Grant Access (Owner Only)
```bash
biofs access grant <biocid_or_ip_id> <wallet_address>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--expires-in <duration>` | Expiry duration (e.g., `30d`, `90d`) |

**Example:**
```bash
biofs access grant biocid://0x123.../bioip/456 0xResearcher --expires-in 90d
```

### Revoke Access (Owner Only)
```bash
biofs access revoke <biocid_or_ip_id> <wallet_address>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--yes` | Skip confirmation |

### List Permissions
```bash
biofs access list [biocid_or_ip_id]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--mine` | List assets you have access to |
| `--status <status>` | Filter: active, pending, revoked |
| `--json` | Output as JSON |

**Examples:**
```bash
# List who has access to your asset
biofs access list biocid://0x123.../bioip/456

# List assets you can access
biofs access list --mine
```

### Check Your Access
```bash
biofs access check <biocid_or_ip_id>
```

### Revoke Your Consent (GDPR Right to Withdraw)
```bash
biofs access revoke-consent [ip_id]
```
Withdraw your consent for genomic data access.

**Options:**
| Option | Description |
|--------|-------------|
| `--all` | Revoke all consents |
| `--force` | Skip confirmation |

---

## Data Sharing

### Share with a Lab
```bash
biofs share <biocid_or_filename> --lab <wallet_address>
```
Shares your file with an approved research lab using dual NFT minting.

**Options:**
| Option | Description |
|--------|-------------|
| `--lab <wallet>` | **Required.** Lab wallet address |
| `--license <type>` | `non-commercial`, `commercial`, `commercial-remix` |
| `--verbose` | Show detailed progress |

**Example:**
```bash
# Share VCF with cancer research lab
biofs share my-exome.vcf --lab 0xCancerLabWallet --license non-commercial
```

### View Permission Graph
```bash
biofs shares
```
Shows files shared with you and by you.

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--graphql` | Show GraphQL schema |

### List Approved Labs
```bash
biofs labnfts
```

**Alias:** `biofs labs`

**Options:**
| Option | Description |
|--------|-------------|
| `--filter <specialization>` | Filter by specialization |
| `--location <location>` | Filter by location |
| `--json` | Output as JSON |

---

## Research Jobs

Submit genomic analysis jobs to the BioOS distributed processing network.

### Create a Job
```bash
biofs job create "<prompt>" <file>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--pipeline <template>` | Use predefined pipeline |
| `--json` | Output as JSON |

**Example:**
```bash
biofs job create "Find pathogenic variants in BRCA genes" my-exome.vcf
```

### Check Job Status
```bash
biofs job status <job_id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--watch` | Refresh every 5 seconds |

### Get Job Results
```bash
biofs job results <job_id>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--step <number>` | Download specific step |

### List All Jobs
```bash
biofs job list
```

**Options:**
| Option | Description |
|--------|-------------|
| `--status <status>` | Filter: pending, running, completed, failed |
| `--limit <number>` | Limit results |
| `--json` | Output as JSON |

### List Pipeline Templates
```bash
biofs job pipelines
```

### Submit Clara Parabricks Job
```bash
biofs job submit-clara <biosample_id> [fastq_r1] [fastq_r2]
```
Submit GPU-accelerated variant calling (FASTQ → VCF).

**Options:**
| Option | Description |
|--------|-------------|
| `--job-id <id>` | Custom job ID |
| `--reference <genome>` | Reference genome (default: hg38) |
| `--capture-kit <kit>` | Capture kit (default: agilent_v8) |
| `--sequencing-type <type>` | WES or WGS |
| `--interval-file <path>` | BED file for targeted sequencing |

**Example:**
```bash
biofs job submit-clara 55052008714000 --sequencing-type WES
```

### Check Agent Health
```bash
biofs agent-health
```
Verify the GPU processing agent is ready.

---

## GDPR Compliance

BioFS is designed for GDPR-compliant genomic data management.

### Verify File Integrity
```bash
biofs verify <biocid_or_filename> <local_file>
```
Uses DNA fingerprinting (Bloom filter) to verify file integrity.

### Extract Phenotype-Specific SNPs (Data Minimization)
```bash
biofs dissect "<phenotype_query>" <source_file>
```
AI-powered extraction of phenotype-specific SNP subsets.

**Options:**
| Option | Description |
|--------|-------------|
| `--share <wallet>` | Share derivative with wallet |
| `--license <type>` | License type |
| `--min-snps <number>` | Minimum SNPs to discover |
| `--output <path>` | Save locally |

**Example:**
```bash
biofs dissect "cardiovascular risk variants" my-exome.vcf --share 0xResearcher
```

### View File Content (Right to Access)
```bash
biofs view <biocid_or_filename>
```

**Options:**
| Option | Description |
|--------|-------------|
| `--lines <number>` | Lines to display |
| `--format <type>` | raw, pretty, json |

---

## Troubleshooting

### Diagnostic Report
```bash
biofs report
```
Generates health check report for troubleshooting.

**Options:**
| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--verbose` | Show verbose debug info |

### Enable Debug Mode
```bash
biofs --debug <command>
```

### Common Issues

**Authentication Failed**
```bash
# Clear credentials and re-login
biofs logout
biofs login
```

**Connection Timeout**
```bash
# Check network and retry with longer timeout
biofs login --timeout 120
```

**File Not Found**
```bash
# Force refresh file list
biofs biofiles --update
```

**Permission Denied**
```bash
# Check your access level
biofs access check <biocid>

# Request access if needed
biofs access request <biocid>
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BIOFS_NODE_URL` | BioFS-Node server URL |
| `DEBUG` | Enable debug output |

---

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| Credentials | `~/.biofs/credentials.json` | Stored wallet + signature |
| Config | `~/.biofs/config.json` | User preferences |

---

## Support

- **Documentation:** https://docs.genobank.io/biofs
- **GitHub Issues:** https://github.com/Genobank/biofs-cli/issues
- **Email:** support@genobank.io

---

*BioFS CLI is part of the GenoBank.io ecosystem for decentralized genomic data management.*


