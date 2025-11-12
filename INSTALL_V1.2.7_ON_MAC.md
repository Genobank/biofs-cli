# Install BioFS v1.2.7 on Mac - BioOS Job Management + Annotator Intelligence

## Quick Install (Recommended)

### Option 1: Direct from npm (Easiest!)

```bash
# Install globally from npm registry
npm install -g @genobank/biofs@1.2.7

# Verify version
biofs --version  # Should show 1.2.7
```

### Option 2: Direct Download from Server (Alternative)

```bash
# On your Mac, download the package
scp ubuntu@44.220.145.233:/home/ubuntu/genobank-cli/genobank-biofs-1.2.7.tgz ~/Downloads/

# Install globally
npm install -g ~/Downloads/genobank-biofs-1.2.7.tgz

# Verify version
biofs --version  # Should show 1.2.7
```

## Test the New Features

### 1. Check Authentication (Already Done ✅)

```bash
biofs whoami
# Should show: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d
```

### 2. Test Annotator Intelligence (NEW in v1.2.7!)

```bash
# Get recommendations for cancer analysis
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=cancer"

# Get recommendations for rare disease
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=rare_disease"

# Get recommendations for splicing analysis
curl "https://genobank.app/api_bioos/annotator_recommendations?analysis_type=splicing"

# Browse all 146 available annotators
curl "https://genobank.app/api_bioos/annotator_dictionary"

# Look up specific annotator
curl "https://genobank.app/api_bioos/annotator_dictionary?name=alphamissense"
```

### 3. List Available Pipeline Templates

```bash
biofs job pipelines
```

**Expected Output**:
```
🔧 Available Pipeline Templates:

┌────────────────────┬──────────────────────────────┬──────────────────────────────────────────────────┬────────┐
│ Template ID        │ Name                         │ Description                                      │ Steps  │
├────────────────────┼──────────────────────────────┼──────────────────────────────────────────────────┼────────┤
│ fastq_to_report    │ FASTQ to Clinical Report     │ Process FASTQ → VCF → Annotation → Clinical Rep… │ 2      │
├────────────────────┼──────────────────────────────┼──────────────────────────────────────────────────┼────────┤
│ vcf_annotation     │ VCF Annotation               │ Annotate VCF with rare coding variants           │ 1      │
├────────────────────┼──────────────────────────────┼──────────────────────────────────────────────────┼────────┤
│ vcf_alphagenome    │ VCF with AlphaMissense Scor… │ Annotate VCF and score with AlphaMissense        │ 2      │
└────────────────────┴──────────────────────────────┴──────────────────────────────────────────────────┴────────┘
```

### 3. List Your BioFiles (Should Work with Existing Auth)

```bash
biofs files
```

This should show all Dra. Claudia's files from S3, IPFS, and Story Protocol.

### 4. Test Job Creation (Example - Won't Run Without File)

```bash
# This is the syntax - you'll need an actual VCF file
biofs job create "Annotate VCF with rare coding variants" your_file.vcf \
  --pipeline vcf_annotation
```

### 5. List Jobs (Will Show Empty Initially)

```bash
biofs job list
```

**Expected Output**:
```
No research jobs found.
Create a job: biofs job create "<prompt>" <file>
```

### 6. Test Help Command

```bash
biofs help job
```

**Expected Output**:
```
Usage: biofs job [options] [command]

Manage research jobs (BioOS)

Commands:
  create [options] <prompt> <file>  Create a research job from natural language prompt
  status [options] <job_id>         Check job execution status
  results [options] <job_id>        Get job results with download URLs
  list [options]                    List all your research jobs
  pipelines|templates [options]     List available pipeline templates
```

## New Commands Available

### Job Management
- `biofs job create "<prompt>" <file>` - Create research job
- `biofs job status <job_id> [--watch]` - Check status
- `biofs job results <job_id>` - Get results
- `biofs job list [--status <status>]` - List jobs
- `biofs job pipelines` - List templates

### All Commands Now Available
```bash
# Authentication
biofs login
biofs logout
biofs whoami

# File Management
biofs files [--filter <type>] [--source <source>]
biofs download <file> [destination]
biofs upload <file> [--tokenize]

# BioIP Tokenization
biofs tokenize <file> [--title "..."] [--license commercial]

# Access Control
biofs access request <biocid>
biofs access grant <biocid> <wallet>
biofs access revoke <biocid> <wallet>
biofs access list [biocid]
biofs access check <biocid>

# BioOS Job Management (NEW!)
biofs job create "<prompt>" <file>
biofs job status <job_id>
biofs job results <job_id>
biofs job list
biofs job pipelines
```

## Full Test Workflow (With Your Credentials)

### Step 1: Verify Installation
```bash
biofs --version  # Should be 1.2.6
biofs whoami     # Should show Dra. Claudia's wallet
```

### Step 2: Explore Pipelines
```bash
biofs job pipelines
```

### Step 3: Check Your Files
```bash
biofs files
```

### Step 4: Create a Test Job (If You Have a VCF)
```bash
# If you have a VCF file
biofs job create "Annotate with rare coding variants" your_file.vcf \
  --pipeline vcf_annotation

# The CLI will:
# 1. Upload your file if needed
# 2. Create the job on GenoBank
# 3. Return a job_id
```

### Step 5: Monitor Job
```bash
# Check status once
biofs job status <job_id>

# Or watch in real-time (refreshes every 5 seconds)
biofs job status <job_id> --watch
```

### Step 6: Download Results
```bash
biofs job results <job_id>
```

## Troubleshooting

### If Version Still Shows 1.2.4 or 1.2.6

```bash
# Uninstall old version first
npm uninstall -g @genobank/biofs

# Then install new version from npm
npm install -g @genobank/biofs@1.2.7

# Verify
biofs --version  # Should show 1.2.7
```

### If You Get Permission Errors

```bash
# Use sudo on Mac
sudo npm install -g @genobank/biofs@1.2.7
```

### If Commands Don't Work

```bash
# Clear npm cache
npm cache clean --force

# Reinstall from npm
npm install -g @genobank/biofs@1.2.7
```

## What's New in v1.2.7

✨ **OpenCRAVAT Annotator Intelligence (NEW!)**
- Complete dictionary of 146 OpenCRAVAT annotators
- Smart recommendations based on clinical phenotype (cancer, autism, rare disease, cardiovascular, etc.)
- Analysis-type recommendations (rare coding, splicing, regulatory, de novo)
- REST API endpoints for Claude AI integration
- Natural language → annotator mapping

✨ **BioOS Job Management**
- Natural language job creation
- Real-time job monitoring with watch mode
- Pipeline templates for common workflows
- Story Protocol IP lineage tracking
- Presigned S3 download URLs for results
- SHA256 file verification

✨ **Enhanced User Experience**
- Progress bars for job execution
- Color-coded status indicators
- Formatted tables for data display
- JSON output for all commands

## Quick Reference

```bash
# Job workflow
biofs job pipelines                  # Browse templates
biofs job create "prompt" file.vcf   # Create job
biofs job status <id> --watch        # Monitor (live)
biofs job results <id>               # Download
biofs job list                       # See all jobs

# With pipeline template
biofs job create "Annotate VCF" file.vcf --pipeline vcf_annotation

# Natural language (Claude picks annotators)
biofs job create "Find pathogenic cancer variants" tumor.vcf

# Access control
biofs access list                    # Your permissions
biofs access request <biocid>        # Request access
biofs access grant <biocid> <wallet> # Grant access
```

## Documentation

Full documentation available in the CLI package:
- `BIOOS_JOB_MANAGEMENT.md` - Complete job management guide
- `ANNOTATOR_RECOMMENDATIONS_API.md` - API documentation
- `OPENCRAVAT_ANNOTATORS_REFERENCE.md` - All 146 annotators

Or view online at: https://genobank.io/docs

---

**Version**: 1.2.7
**Release Date**: October 7, 2025
**Published to npm**: ✅ Available at https://www.npmjs.com/package/@genobank/biofs
**Your Wallet**: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d
**Authentication**: Valid for 28 more days

## Installation Command

```bash
npm install -g @genobank/biofs@1.2.7
```
