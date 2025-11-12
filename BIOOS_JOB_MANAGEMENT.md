# BioOS Job Management - CLI Guide

## Overview

BioOS (Bio Operating System) is GenoBank's research pipeline orchestration platform that allows you to run complex bioinformatics workflows using natural language prompts. The BioFS CLI provides comprehensive job management commands to create, monitor, and retrieve results from research jobs.

## Features

- 🤖 **Natural Language Jobs**: Create jobs using plain English prompts
- 📋 **Pipeline Templates**: Pre-configured workflows for common analyses
- 📊 **Real-time Monitoring**: Watch job progress with live status updates
- 📥 **Presigned Downloads**: Secure S3 download URLs for results
- ⛓️ **Story Protocol Lineage**: Track IP asset lineage across pipeline steps
- 🔄 **Flexible File Input**: Support for BioCID, IP IDs, and filenames

## Available Commands

### 1. `biofs job pipelines` - List Pipeline Templates

List all available pipeline templates with detailed step-by-step breakdown.

```bash
# Default formatted output
biofs job pipelines

# JSON output
biofs job pipelines --json
```

**Example Output:**
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

Pipeline Details:

fastq_to_report - FASTQ to Clinical Report
  Process FASTQ → VCF → Annotation → Clinical Report
  Steps:
    1. clara (variant_calling) →
    2. vcf_annotator (annotate)

Usage Examples:

  # FASTQ to Clinical Report
  biofs job create "Process FASTQ → VCF → Annotation → Clinical Report" <file> --pipeline fastq_to_report
```

**Options:**
- `--json` - Output as JSON for programmatic use

---

### 2. `biofs job create` - Create Research Job

Create a research job from a natural language prompt and input file.

```bash
# Using pipeline template
biofs job create "Annotate VCF with rare coding variants" sample.vcf --pipeline vcf_annotation

# Custom natural language prompt
biofs job create "Find pathogenic variants in cancer genes" sample.vcf

# Using BioCID
biofs job create "Analyze trio for autism genes" biocid://story/bioip/abc123/trio.vcf

# Using IP Asset ID
biofs job create "Score variants with AlphaMissense" 0x89224559242246F93479Fc44B0d8a1AFF5950faB

# JSON output
biofs job create "Annotate VCF" sample.vcf --json
```

**File Input Formats:**

1. **Filename**: `sample.vcf` - Searches your uploaded files
2. **BioCID**: `biocid://story/bioip/{registration_id}/file.vcf` - Direct BioIP reference
3. **IP Asset ID**: `0x...` - Story Protocol IP asset

**Options:**
- `--pipeline <template>` - Use predefined pipeline template
- `--json` - Output job details as JSON

**Example Output:**
```
✓ Job created successfully!

Job Details:
  Job ID:  66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12
  Status:  pending
  Prompt:  Annotate VCF with rare coding variants
  File:    sample.vcf (VCF)

Track progress:
  biofs job status 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12

Watch live updates:
  biofs job status 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12 --watch
```

---

### 3. `biofs job status` - Check Job Status

Monitor job execution status with optional real-time watching.

```bash
# Single status check
biofs job status <job_id>

# Watch mode (refresh every 5 seconds)
biofs job status <job_id> --watch

# JSON output
biofs job status <job_id> --json
```

**Example Output:**
```
📊 Job Status: 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12

  Status: ▶️  RUNNING
  Progress: Step 2/3

  Pipeline: [████████████████░░░░░░░░░░░░░░] 67%

  Story Protocol Lineage:
  ├─ 0xC91940118822D247B46d1eBA6B7Ed2A16F3aDC36  (VCF)
  └─ 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269  (Annotation)

  Output Files:
  ┌──────┬────────────────────┬───────────┬─────────────────────────────────────────────┐
  │ Step │ Service            │ File Type │ IP Asset                                    │
  ├──────┼────────────────────┼───────────┼─────────────────────────────────────────────┤
  │ 1    │ vcf_annotator      │ sqlite    │ 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12... │
  └──────┴────────────────────┴───────────┴─────────────────────────────────────────────┘

  Created: 2025-10-07 12:34:56
  Updated: 2025-10-07 12:45:23

  ⏳ Job is still running...
  Watch mode: biofs job status 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12 --watch
```

**Options:**
- `--watch` - Refresh status every 5 seconds until completion
- `--json` - Output as JSON

**Status Types:**
- `⏳ pending` - Job queued, waiting to start
- `▶️  running` - Job actively executing
- `✅ completed` - Job finished successfully
- `❌ failed` - Job encountered an error

---

### 4. `biofs job results` - Download Job Results

Get job results with presigned S3 download URLs and file verification hashes.

```bash
# Get all results
biofs job results <job_id>

# Get specific step only
biofs job results <job_id> --step 2

# JSON output
biofs job results <job_id> --json
```

**Example Output:**
```
📥 Job Results: 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12

Story Protocol Lineage:
├─ 0xC91940118822D247B46d1eBA6B7Ed2A16F3aDC36
├─ 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269
└─ 0x495B1E8C54b572d78B16982BFb97908823C9358A

Output Files (2):

┌──────┬───────────┬─────────────────────────────────────────────┬──────────┐
│ Step │ File Type │ IP Asset ID                                 │ Download │
├──────┼───────────┼─────────────────────────────────────────────┼──────────┤
│ 1    │ sqlite    │ 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269  │ [1]      │
├──────┼───────────┼─────────────────────────────────────────────┼──────────┤
│ 2    │ csv       │ 0x495B1E8C54b572d78B16982BFb97908823C9358A  │ [2]      │
└──────┴───────────┴─────────────────────────────────────────────┴──────────┘

Download Instructions:

  [1] Step 1 - sqlite:
      curl -o output_step1.sqlite "https://s3.amazonaws.com/presigned-url-1..."

  [2] Step 2 - csv:
      curl -o output_step2.csv "https://s3.amazonaws.com/presigned-url-2..."

File Verification (SHA256):

  Step 1: a5b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890
  Step 2: 1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd

💡 Tip: URLs expire in 1 hour. Use them promptly or re-run this command.
```

**Options:**
- `--step <number>` - Download specific step only
- `--json` - Output as JSON

**Response Fields:**
- **IP Lineage**: Story Protocol IP asset chain
- **Output Files**: Generated files from each pipeline step
- **Download URLs**: Presigned S3 URLs (1-hour expiry)
- **File Hashes**: SHA256 checksums for verification

---

### 5. `biofs job list` - List All Jobs

List all your research jobs with filtering and status summary.

```bash
# List all jobs
biofs job list

# Filter by status
biofs job list --status completed
biofs job list --status running

# Limit results
biofs job list --limit 10

# JSON output
biofs job list --json
```

**Example Output:**
```
🔬 Your Research Jobs (5):

┌────────────────────┬──────────────────────────────────────────┬────────────┬──────────┬──────────────────┐
│ Job ID             │ Prompt                                   │ Status     │ Progress │ Created          │
├────────────────────┼──────────────────────────────────────────┼────────────┼──────────┼──────────────────┤
│ 66f9e300-8b0e-4... │ Annotate VCF with rare coding variants   │ ✅ completed│ 3/3      │ 2025-10-07       │
├────────────────────┼──────────────────────────────────────────┼────────────┼──────────┼──────────────────┤
│ 77g8f411-9c1f-5... │ Process FASTQ to clinical report         │ ▶️  running │ 1/2      │ 2025-10-07       │
├────────────────────┼──────────────────────────────────────────┼────────────┼──────────┼──────────────────┤
│ 88h9g522-0d2g-6... │ Find autism genes in trio                │ ⏳ pending  │ N/A      │ 2025-10-06       │
└────────────────────┴──────────────────────────────────────────┴────────────┴──────────┴──────────────────┘

Summary:
  ⏳ Pending: 1
  ▶️  Running: 1
  ✅ Completed: 3

Active Jobs:
  • 77g8f411-9c... - biofs job status 77g8f411-9c1f-5d3e-a7b4-6c8d9e1f2a3b

Download Results:
  • 66f9e300-8b... - biofs job results 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12
```

**Options:**
- `--status <status>` - Filter by: `pending`, `running`, `completed`, `failed`
- `--limit <number>` - Limit number of results
- `--json` - Output as JSON

---

## Common Workflows

### Workflow 1: VCF Annotation Pipeline

```bash
# 1. Check available pipelines
biofs job pipelines

# 2. Create annotation job
biofs job create "Annotate VCF with rare coding variants" sample.vcf \
  --pipeline vcf_annotation

# Output: Job ID: 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12

# 3. Watch progress
biofs job status 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12 --watch

# 4. Download results when complete
biofs job results 66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12
```

### Workflow 2: FASTQ to Clinical Report

```bash
# 1. Create full pipeline job
biofs job create "Process FASTQ to VCF to clinical report" reads_R1.fastq.gz \
  --pipeline fastq_to_report

# 2. Monitor with JSON output for automation
biofs job status <job_id> --json | jq '.status'

# 3. Download specific step results
biofs job results <job_id> --step 2
```

### Workflow 3: AlphaMissense Variant Scoring

```bash
# 1. Create scoring job
biofs job create "Score variants with AlphaMissense" annotated.vcf \
  --pipeline vcf_alphagenome

# 2. Check all jobs
biofs job list --status running

# 3. Download final scored results
biofs job results <job_id>
```

### Workflow 4: Custom Natural Language Job

```bash
# No template needed - BioOS interprets the prompt
biofs job create "Find pathogenic variants in BRCA1 and BRCA2 genes" sample.vcf

# Watch execution
biofs job status <job_id> --watch
```

---

## Pipeline Templates

### Available Templates

#### 1. `fastq_to_report` - FASTQ to Clinical Report
**Description**: Complete pipeline from raw sequencing to clinical report
**Steps**:
1. **Clara**: Variant calling (FASTQ → VCF)
2. **VCF Annotator**: Annotation and clinical interpretation

**Use Case**: Whole genome/exome sequencing analysis

```bash
biofs job create "Process FASTQ to clinical report" sample_R1.fastq.gz \
  --pipeline fastq_to_report
```

#### 2. `vcf_annotation` - VCF Annotation
**Description**: Annotate VCF with rare coding variants
**Steps**:
1. **VCF Annotator**: OpenCRAVAT annotation with rare coding package

**Use Case**: Annotating pre-called VCF files

```bash
biofs job create "Annotate VCF with rare coding variants" sample.vcf \
  --pipeline vcf_annotation
```

#### 3. `vcf_alphagenome` - VCF with AlphaMissense Scoring
**Description**: Annotate VCF and score with AlphaMissense AI
**Steps**:
1. **VCF Annotator**: OpenCRAVAT annotation
2. **AlphaGenome**: AlphaMissense pathogenicity scoring

**Use Case**: AI-powered variant pathogenicity prediction

```bash
biofs job create "Annotate and score variants with AlphaMissense" sample.vcf \
  --pipeline vcf_alphagenome
```

---

## Story Protocol Integration

### IP Asset Lineage

BioOS automatically creates Story Protocol IP assets for each pipeline step, establishing a parent-child relationship:

```
VCF File (Parent IP)
  └─ Annotated SQLite (Child IP)
      └─ Clinical Report CSV (Grandchild IP)
```

Each IP asset:
- Inherits PIL license terms from parent
- Generates royalties for parent owners
- Is tokenized as NFT on Story Protocol
- Has immutable metadata on IPFS

### Viewing IP Lineage

```bash
# View full lineage in job status
biofs job status <job_id>

# View lineage in results
biofs job results <job_id>
```

**Example Lineage Output:**
```
Story Protocol Lineage:
├─ 0xC91940118822D247B46d1eBA6B7Ed2A16F3aDC36  (VCF)
├─ 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269  (SQLite)
└─ 0x495B1E8C54b572d78B16982BFb97908823C9358A  (CSV)
```

---

## File Input Reference

### 1. Filename
```bash
biofs job create "Annotate VCF" sample.vcf
```
Searches your uploaded files for matching filename.

### 2. BioCID (Bio Content Identifier)
```bash
biofs job create "Annotate VCF" biocid://story/bioip/abc123/sample.vcf
```
Direct reference to BioIP-registered file.

**Format**: `biocid://story/bioip/{registration_id}/{filename}`

### 3. IP Asset ID
```bash
biofs job create "Score variants" 0x89224559242246F93479Fc44B0d8a1AFF5950faB
```
Reference file by Story Protocol IP asset ID.

---

## JSON Output Format

All commands support `--json` flag for programmatic use:

### Job Create Response
```json
{
  "job_id": "66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12",
  "status": "pending",
  "message": "Job created successfully",
  "prompt": "Annotate VCF with rare coding variants",
  "input_files": [{
    "name": "sample.vcf",
    "type": "vcf",
    "path": "s3://bucket/path/sample.vcf"
  }]
}
```

### Job Status Response
```json
{
  "job_id": "66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12",
  "status": "running",
  "current_step": 1,
  "total_steps": 3,
  "ip_lineage": [
    "0xC91940118822D247B46d1eBA6B7Ed2A16F3aDC36",
    "0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269"
  ],
  "output_files": [{
    "step": 1,
    "service": "vcf_annotator",
    "file_type": "sqlite",
    "ip_id": "0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269"
  }],
  "created_at": "2025-10-07T12:34:56Z",
  "updated_at": "2025-10-07T12:45:23Z"
}
```

### Job Results Response
```json
{
  "job_id": "66f9e300-8b0e-4ce8-9b6c-5a7b9d4c8e12",
  "status": "completed",
  "ip_lineage": [
    "0xC91940118822D247B46d1eBA6B7Ed2A16F3aDC36",
    "0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269",
    "0x495B1E8C54b572d78B16982BFb97908823C9358A"
  ],
  "results": [{
    "step": 1,
    "file_type": "sqlite",
    "ip_id": "0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269",
    "download_url": "https://s3.amazonaws.com/...",
    "file_hash": "a5b3c4d5e6f7890abcdef1234567890..."
  }]
}
```

---

## Troubleshooting

### Job Creation Fails

**Error**: `File not found`
```bash
# Solution: List your files first
biofs files

# Then use exact filename
biofs job create "Annotate VCF" exact-filename.vcf
```

**Error**: `Invalid pipeline template`
```bash
# Solution: List available pipelines
biofs job pipelines

# Use correct template ID
biofs job create "..." file.vcf --pipeline vcf_annotation
```

### Job Status Not Updating

```bash
# Solution: Check with JSON output for raw data
biofs job status <job_id> --json

# Or watch mode for live updates
biofs job status <job_id> --watch
```

### Download URLs Expired

**Error**: `403 Forbidden` when downloading
```bash
# Solution: Re-generate presigned URLs (1-hour expiry)
biofs job results <job_id>
```

### Job Stuck in Pending

```bash
# Check all jobs to see system status
biofs job list

# Contact support if stuck >10 minutes
# Include job ID: support@genobank.io
```

---

## Advanced Usage

### Automation with Shell Scripts

```bash
#!/bin/bash
# automated_pipeline.sh

# Create job and extract job ID
JOB_ID=$(biofs job create "Annotate VCF" sample.vcf --json | jq -r '.job_id')

echo "Created job: $JOB_ID"

# Poll until complete
while true; do
  STATUS=$(biofs job status $JOB_ID --json | jq -r '.status')
  echo "Status: $STATUS"

  if [ "$STATUS" = "completed" ]; then
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "Job failed!"
    exit 1
  fi

  sleep 30
done

# Download results
biofs job results $JOB_ID --json | jq -r '.results[].download_url' | while read URL; do
  curl -O "$URL"
done

echo "Pipeline complete!"
```

### Parallel Job Processing

```bash
# Submit multiple jobs
for vcf in *.vcf; do
  biofs job create "Annotate VCF" "$vcf" --pipeline vcf_annotation --json
done

# Monitor all jobs
biofs job list --status running --json | jq -r '.jobs[].job_id' | while read JOB; do
  biofs job status $JOB
done
```

### Integration with CI/CD

```yaml
# .github/workflows/genomic-analysis.yml
name: Genomic Analysis
on: [push]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Install BioFS
        run: npm install -g @genobank/biofs

      - name: Authenticate
        run: |
          echo "$GENOBANK_CREDENTIALS" > ~/.genobank/credentials.json

      - name: Run Analysis
        run: |
          JOB_ID=$(biofs job create "Annotate VCF" sample.vcf --json | jq -r '.job_id')

          # Wait for completion
          while [ "$(biofs job status $JOB_ID --json | jq -r '.status')" != "completed" ]; do
            sleep 60
          done

          # Download results
          biofs job results $JOB_ID
```

---

## API Integration

The BioOS CLI communicates with these API endpoints:

- `POST /api_bioos/create_job` - Create new job
- `GET /api_bioos/job_status?job_id=<id>` - Get status
- `GET /api_bioos/job_results?job_id=<id>` - Get results
- `GET /api_bioos/pipeline_list` - List templates
- `GET /api_bioos/user_jobs` - List user jobs

All endpoints require `user_signature` authentication.

---

## Support

- **Interactive API Guide**: https://genobank.app/static/Genobank_API_Educational_Guide.html
- **GitHub Issues**: https://github.com/genobank/genobank-cli/issues
- **Email**: support@genobank.io
- **Documentation**: https://docs.genobank.io

---

## Version History

### v1.2.6 - BioOS Job Management
- Added `biofs job create` command
- Added `biofs job status` with watch mode
- Added `biofs job results` with presigned URLs
- Added `biofs job list` with filtering
- Added `biofs job pipelines` template listing
- Story Protocol lineage tracking
- Support for BioCID, IP IDs, and filenames
- JSON output for all commands
