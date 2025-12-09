# BioFS CLI - AI Agent & MCP Server Integration Manual

**Version 2.4.1** | **For AI Agents, LLMs, and MCP Server Implementations**

This manual provides structured information for AI agents to programmatically interact with the BioFS CLI for genomic data management on the Sequentia blockchain.

---

## Overview

BioFS CLI enables:
- **BioNFT-Gated Access**: Blockchain-verified consent for genomic data
- **GDPR Compliance**: Right to access, erasure, and data minimization
- **Decentralized Processing**: GPU-accelerated genomic analysis jobs
- **x402 Payments**: Atomic USDC payments for services

**Sequentia Network Configuration:**
```json
{
  "chainId": 15132025,
  "rpcUrl": "http://52.90.163.112:8545",
  "contracts": {
    "bioCIDRegistry": "0x6Fb51DB12AE422F8360a31a27B3E960f4DC0004b",
    "consentManager": "0x2ff3FB85c71D6cD7F1217A08Ac9a2d68C02219cd",
    "bioPIL": "0x6474485F6fE3c19Ac0cD069D4cBc421656942DA9",
    "openCravatJobs": "0xB384A7531d59cFd45f98f71833aF736b921a5FCB",
    "paymentRouter": "0x4b46D8A0533bc17503349F86a909C2FEcFD04489",
    "labNFT": "0x24f42752F491540e305384A5C947911649C910CF",
    "usdcToken": "0xD837B344e931cc265ec54879A0B388DE6F0015c9"
  }
}
```

---

## MCP Tool Definitions

### Authentication Tools

#### `biofs_login`
Authenticate user with Web3 wallet signature.

```typescript
interface BiofsLoginParams {
  wallet?: string;      // Wallet address for direct auth
  signature?: string;   // Web3 signature for direct auth
  timeout?: number;     // Auth timeout in seconds
  noBrowser?: boolean;  // Skip browser opening
}

interface BiofsLoginResult {
  success: boolean;
  wallet: string;
  expiresAt: number;    // Unix timestamp
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_login",
  "description": "Authenticate with GenoBank.io using Web3 wallet signature",
  "inputSchema": {
    "type": "object",
    "properties": {
      "wallet": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
      "signature": { "type": "string", "pattern": "^0x[a-fA-F0-9]+$" },
      "timeout": { "type": "integer", "minimum": 10, "maximum": 300 }
    }
  }
}
```

**CLI Execution:**
```bash
# Interactive (opens browser)
biofs login

# Direct authentication (for automation)
biofs login --wallet 0x... --signature 0x...
```

#### `biofs_whoami`
Get current authenticated session.

```typescript
interface BiofsWhoamiResult {
  authenticated: boolean;
  wallet: string | null;
  signature: string | null;
  expiresAt: number | null;
}
```

**CLI Execution:**
```bash
biofs whoami --json
```

---

### File Discovery Tools

#### `biofs_list_files`
Discover all BioFiles from GenoBank ecosystem.

```typescript
interface BiofsListFilesParams {
  filter?: "vcf" | "fastq" | "bam" | "pdf" | "sqlite" | "csv";
  source?: "story" | "avalanche" | "s3" | "biofs";
  update?: boolean;     // Force refresh from blockchain
}

interface BioFile {
  filename: string;
  biocid: string;       // biocid://OWNER/bioip/IP_ID
  format: string;       // vcf, fastq, bam, etc.
  size: number;         // bytes
  source: string;       // story, avalanche, s3, biofs
  ipId?: string;        // Story Protocol IP ID
  owner: string;        // Wallet address
  createdAt: string;    // ISO 8601
  s3Path?: string;      // S3 storage path
  fingerprint?: string; // Bloom filter fingerprint (hex)
}

interface BiofsListFilesResult {
  files: BioFile[];
  totalCount: number;
  sources: {
    story: number;
    avalanche: number;
    s3: number;
    biofs: number;
  };
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_list_files",
  "description": "List all BioFiles accessible to the authenticated user",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filter": {
        "type": "string",
        "enum": ["vcf", "fastq", "bam", "pdf", "sqlite", "csv"]
      },
      "source": {
        "type": "string",
        "enum": ["story", "avalanche", "s3", "biofs"]
      },
      "update": { "type": "boolean", "default": false }
    }
  }
}
```

**CLI Execution:**
```bash
biofs biofiles --json
biofs biofiles --filter vcf --json
biofs biofiles --source s3 --update --json
```

---

### File Operations Tools

#### `biofs_download`
Download a file with GDPR consent verification.

```typescript
interface BiofsDownloadParams {
  biocidOrFilename: string;  // BioCID URL or filename
  destination?: string;       // Local path
  stream?: boolean;           // Stream large files
  skipConsent?: boolean;      // Skip GDPR consent (automation)
}

interface BiofsDownloadResult {
  success: boolean;
  localPath: string;
  size: number;
  fingerprint: string;
  consentVerified: boolean;
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_download",
  "description": "Download a genomic file with GDPR consent verification",
  "inputSchema": {
    "type": "object",
    "required": ["biocidOrFilename"],
    "properties": {
      "biocidOrFilename": { "type": "string" },
      "destination": { "type": "string" },
      "stream": { "type": "boolean", "default": false },
      "skipConsent": { "type": "boolean", "default": false }
    }
  }
}
```

**CLI Execution:**
```bash
biofs download sample.vcf ./output/ --skip-consent --quiet
biofs download biocid://0x.../bioip/123 --stream --output ./large-file.bam
```

#### `biofs_upload`
Upload a file to GenoBank S3 storage.

```typescript
interface BiofsUploadParams {
  filePath: string;
  type?: "vcf" | "fastq" | "bam" | "pdf";
  tokenize?: boolean;        // Mint as NFT after upload
  shareWith?: string;        // Lab wallet to share with
  public?: boolean;          // Make publicly discoverable
}

interface BiofsUploadResult {
  success: boolean;
  s3Path: string;
  biocid?: string;           // If tokenized
  ipId?: string;             // If tokenized
  sharedWith?: string;       // If shared
}
```

**CLI Execution:**
```bash
biofs upload ./genome.vcf --type vcf --tokenize --quiet
```

---

### Tokenization Tools

#### `biofs_tokenize_file`
Tokenize a genomic file as BioNFT on Sequentia.

```typescript
interface BiofsTokenizeParams {
  filePath: string;
  title?: string;
  description?: string;      // AI-generated if omitted
  license?: "commercial" | "non-commercial";
  collection?: string;       // Collection address override
  noAi?: boolean;            // Skip AI classification
  yes?: boolean;             // Auto-confirm
}

interface BiofsTokenizeResult {
  success: boolean;
  biocid: string;            // biocid://OWNER/bioip/IP_ID
  ipId: string;              // Story Protocol IP ID
  nftAddress: string;        // NFT contract address
  tokenId: string;           // NFT token ID
  txHash: string;            // Blockchain transaction hash
  fingerprint: string;       // Bloom filter fingerprint
  collection: string;        // Collection address
  license: string;
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_tokenize_file",
  "description": "Tokenize a genomic file as BioNFT with AI classification",
  "inputSchema": {
    "type": "object",
    "required": ["filePath"],
    "properties": {
      "filePath": { "type": "string" },
      "title": { "type": "string", "maxLength": 100 },
      "description": { "type": "string", "maxLength": 500 },
      "license": { "type": "string", "enum": ["commercial", "non-commercial"] },
      "collection": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" }
    }
  }
}
```

**CLI Execution:**
```bash
biofs tokenize file ./exome.vcf --license non-commercial --yes
```

#### `biofs_tokenize_fastqs`
Create BioNFT consent for existing FASTQ files.

```typescript
interface BiofsTokenizeFastqsParams {
  biosampleSerial: string;   // e.g., "55052008714000"
  recipient?: string;        // Wallet to grant access
  license?: string;
  yes?: boolean;
}

interface BiofsTokenizeFastqsResult {
  success: boolean;
  biosampleSerial: string;
  biocid: string;
  txHash: string;
  filesIncluded: string[];   // List of FASTQ files
  accessGrantedTo?: string;
}
```

**CLI Execution:**
```bash
biofs tokenize fastqs 55052008714000 --recipient 0xLabWallet --yes
```

---

### Access Control Tools

#### `biofs_access_grant`
Grant access to a BioNFT asset.

```typescript
interface BiofsAccessGrantParams {
  biocidOrIpId: string;
  walletAddress: string;
  expiresIn?: string;        // e.g., "30d", "90d", "1y"
}

interface BiofsAccessGrantResult {
  success: boolean;
  biocid: string;
  grantedTo: string;
  expiresAt: number;         // Unix timestamp (0 = never)
  txHash: string;
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_access_grant",
  "description": "Grant access to a BioNFT asset (owner only)",
  "inputSchema": {
    "type": "object",
    "required": ["biocidOrIpId", "walletAddress"],
    "properties": {
      "biocidOrIpId": { "type": "string" },
      "walletAddress": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
      "expiresIn": { "type": "string", "pattern": "^\\d+[dmy]$" }
    }
  }
}
```

**CLI Execution:**
```bash
biofs access grant biocid://0x.../bioip/123 0xResearcher --expires-in 90d
```

#### `biofs_access_revoke`
Revoke access from a wallet.

```typescript
interface BiofsAccessRevokeParams {
  biocidOrIpId: string;
  walletAddress: string;
  yes?: boolean;             // Skip confirmation
}
```

**CLI Execution:**
```bash
biofs access revoke biocid://0x.../bioip/123 0xResearcher --yes
```

#### `biofs_access_list`
List permissions for an asset or accessible assets.

```typescript
interface BiofsAccessListParams {
  biocidOrIpId?: string;     // Optional: specific asset
  mine?: boolean;            // List assets I can access
  status?: "active" | "pending" | "revoked";
}

interface AccessPermission {
  biocid: string;
  wallet: string;
  role: "owner" | "permittee";
  status: "active" | "pending" | "revoked";
  grantedAt: string;
  expiresAt: string | null;
}

interface BiofsAccessListResult {
  permissions: AccessPermission[];
}
```

**CLI Execution:**
```bash
biofs access list biocid://0x.../bioip/123 --json
biofs access list --mine --status active --json
```

#### `biofs_access_check`
Check access level to a specific asset.

```typescript
interface BiofsAccessCheckParams {
  biocidOrIpId: string;
}

interface BiofsAccessCheckResult {
  hasAccess: boolean;
  accessLevel: "none" | "read" | "analyze" | "download" | "owner";
  expiresAt: string | null;
  operations: string[];      // ["read", "analyze", "download", "share"]
}
```

**CLI Execution:**
```bash
biofs access check biocid://0x.../bioip/123
```

---

### Data Sharing Tools

#### `biofs_share`
Share a file with an approved lab.

```typescript
interface BiofsShareParams {
  biocidOrFilename: string;
  lab: string;               // Lab wallet address (required)
  license?: "non-commercial" | "commercial" | "commercial-remix";
}

interface BiofsShareResult {
  success: boolean;
  biocid: string;
  sharedWith: string;
  licenseType: string;
  txHash: string;
  labName?: string;
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_share",
  "description": "Share genomic file with approved research lab",
  "inputSchema": {
    "type": "object",
    "required": ["biocidOrFilename", "lab"],
    "properties": {
      "biocidOrFilename": { "type": "string" },
      "lab": { "type": "string", "pattern": "^0x[a-fA-F0-9]{40}$" },
      "license": {
        "type": "string",
        "enum": ["non-commercial", "commercial", "commercial-remix"],
        "default": "non-commercial"
      }
    }
  }
}
```

**CLI Execution:**
```bash
biofs share sample.vcf --lab 0xLabWallet --license non-commercial
```

#### `biofs_list_labs`
List approved research labs.

```typescript
interface BiofsListLabsParams {
  filter?: string;           // Specialization filter
  location?: string;
}

interface Lab {
  wallet: string;
  name: string;
  specialization: string;
  location: string;
  website?: string;
  email?: string;
  accessLevel: "RESEARCH_ONLY" | "CLINICAL_NON_CRITICAL" | "CLINICAL_CRITICAL" | "COMMERCIAL";
  ga4ghLevel: "NONE" | "BASIC" | "LITE" | "FULL";
  reputation: number;        // 0-100
}

interface BiofsListLabsResult {
  labs: Lab[];
}
```

**CLI Execution:**
```bash
biofs labnfts --json
biofs labnfts --filter cancer --json
```

---

### Research Job Tools

#### `biofs_job_create`
Create a genomic analysis job.

```typescript
interface BiofsJobCreateParams {
  prompt: string;            // Natural language description
  fileRef: string;           // BioCID or filename
  pipeline?: string;         // Pipeline template name
}

interface BiofsJobCreateResult {
  success: boolean;
  jobId: string;
  status: "pending";
  pipeline: string;
  estimatedCost: number;     // USDC
  estimatedTime: string;     // e.g., "30 minutes"
}
```

**MCP Tool Schema:**
```json
{
  "name": "biofs_job_create",
  "description": "Create genomic analysis job from natural language prompt",
  "inputSchema": {
    "type": "object",
    "required": ["prompt", "fileRef"],
    "properties": {
      "prompt": { "type": "string", "minLength": 10 },
      "fileRef": { "type": "string" },
      "pipeline": { "type": "string" }
    }
  }
}
```

**CLI Execution:**
```bash
biofs job create "Find pathogenic BRCA variants" exome.vcf --json
```

#### `biofs_job_status`
Check job execution status.

```typescript
interface BiofsJobStatusParams {
  jobId: string;
}

interface BiofsJobStatusResult {
  jobId: string;
  status: "pending" | "assigned" | "in_progress" | "completed" | "failed";
  progress: number;          // 0-100
  currentStep?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  assignedLab?: string;
}
```

**CLI Execution:**
```bash
biofs job status abc123 --json
```

#### `biofs_job_results`
Get job results and download URLs.

```typescript
interface BiofsJobResultsParams {
  jobId: string;
  step?: number;             // Specific step
}

interface JobResult {
  step: number;
  name: string;
  status: "completed" | "failed";
  outputFiles: {
    filename: string;
    biocid?: string;
    downloadUrl: string;
    size: number;
  }[];
}

interface BiofsJobResultsResult {
  jobId: string;
  status: "completed";
  results: JobResult[];
  totalCost: number;         // USDC charged
}
```

**CLI Execution:**
```bash
biofs job results abc123 --json
```

#### `biofs_job_submit_clara`
Submit Clara Parabricks GPU job (FASTQ → VCF).

```typescript
interface BiofsJobSubmitClaraParams {
  biosampleId: string;
  fastqR1?: string;          // Auto-discovered if omitted
  fastqR2?: string;
  jobId?: string;            // Custom job ID
  reference?: string;        // Default: "hg38"
  captureKit?: string;       // Default: "agilent_v8"
  sequencingType?: "WES" | "WGS";
  intervalFile?: string;     // BED file path
}

interface BiofsJobSubmitClaraResult {
  success: boolean;
  jobId: string;
  biosampleId: string;
  fastqFiles: string[];
  reference: string;
  estimatedTime: string;
  txHash?: string;
}
```

**CLI Execution:**
```bash
biofs job submit-clara 55052008714000 --sequencing-type WES --json
```

---

### GDPR Compliance Tools

#### `biofs_verify`
Verify file integrity using DNA fingerprint.

```typescript
interface BiofsVerifyParams {
  biocidOrFilename: string;
  localFile: string;
}

interface BiofsVerifyResult {
  match: boolean;
  storedFingerprint: string;
  computedFingerprint: string;
  similarity: number;        // 0-100
}
```

**CLI Execution:**
```bash
biofs verify biocid://0x.../bioip/123 ./local-copy.vcf --json
```

#### `biofs_dissect`
Extract phenotype-specific SNP subset (data minimization).

```typescript
interface BiofsDissectParams {
  phenotypeQuery: string;    // e.g., "cardiovascular risk"
  sourceFile: string;
  share?: string;            // Wallet to share derivative
  license?: string;
  minSnps?: number;          // Default: 10
  output?: string;           // Local output path
}

interface BiofsDissectResult {
  success: boolean;
  sourceFile: string;
  derivativeFile: string;
  snpsExtracted: number;
  phenotypes: string[];
  biocid?: string;           // If tokenized
  sharedWith?: string;
}
```

**CLI Execution:**
```bash
biofs dissect "cardiovascular variants" exome.vcf --share 0xResearcher --json
```

#### `biofs_revoke_consent`
Revoke consent for data access (GDPR Right to Withdraw).

```typescript
interface BiofsRevokeConsentParams {
  ipId?: string;             // Specific asset
  all?: boolean;             // Revoke all consents
  force?: boolean;           // Skip confirmation
}

interface BiofsRevokeConsentResult {
  success: boolean;
  revokedAssets: string[];
  txHashes: string[];
}
```

**CLI Execution:**
```bash
biofs access revoke-consent --all --force
```

---

### Utility Tools

#### `biofs_report`
Generate diagnostic health check.

```typescript
interface BiofsReportResult {
  authentication: {
    authenticated: boolean;
    wallet: string | null;
  };
  network: {
    sequentiaConnected: boolean;
    rpcUrl: string;
    blockNumber: number;
  };
  storage: {
    s3Connected: boolean;
    bucket: string;
  };
  agent: {
    available: boolean;
    url: string;
    gpuStatus?: string;
  };
}
```

**CLI Execution:**
```bash
biofs report --json
```

#### `biofs_agent_health`
Check GPU processing agent status.

```typescript
interface BiofsAgentHealthResult {
  available: boolean;
  url: string;
  gpuModel?: string;
  gpuMemory?: number;
  queueLength: number;
  estimatedWait: string;
}
```

**CLI Execution:**
```bash
biofs agent-health --json
```

---

## Error Handling

All tools return structured errors:

```typescript
interface BiofsError {
  success: false;
  error: {
    code: string;           // e.g., "AUTH_REQUIRED", "ACCESS_DENIED"
    message: string;
    details?: any;
  };
}
```

**Common Error Codes:**

| Code | Description | Resolution |
|------|-------------|------------|
| `AUTH_REQUIRED` | Not authenticated | Call `biofs_login` |
| `AUTH_EXPIRED` | Session expired | Call `biofs_login` |
| `ACCESS_DENIED` | No permission for asset | Request access or check ownership |
| `FILE_NOT_FOUND` | File doesn't exist | Verify BioCID or filename |
| `CONSENT_REQUIRED` | GDPR consent needed | User must provide consent |
| `CONSENT_REVOKED` | Consent was revoked | Contact data owner |
| `NETWORK_ERROR` | Blockchain connection failed | Check RPC URL |
| `INSUFFICIENT_FUNDS` | Not enough USDC | Top up wallet |
| `JOB_FAILED` | Analysis job failed | Check job logs |

---

## Workflow Examples

### Workflow 1: Download and Analyze VCF

```typescript
// 1. Check authentication
const session = await biofs_whoami();
if (!session.authenticated) {
  await biofs_login({ wallet: userWallet, signature: userSig });
}

// 2. List available VCF files
const files = await biofs_list_files({ filter: "vcf" });

// 3. Download file
const download = await biofs_download({
  biocidOrFilename: files.files[0].biocid,
  destination: "/tmp/analysis/",
  skipConsent: true  // For automation
});

// 4. Submit analysis job
const job = await biofs_job_create({
  prompt: "Find pathogenic variants in cancer genes",
  fileRef: download.localPath
});

// 5. Poll for completion
let status;
do {
  status = await biofs_job_status({ jobId: job.jobId });
  await sleep(5000);
} while (status.status !== "completed" && status.status !== "failed");

// 6. Get results
const results = await biofs_job_results({ jobId: job.jobId });
```

### Workflow 2: Tokenize and Share FASTQ

```typescript
// 1. Tokenize existing FASTQ files
const tokenized = await biofs_tokenize_fastqs({
  biosampleSerial: "55052008714000",
  license: "non-commercial",
  yes: true
});

// 2. Find approved labs
const labs = await biofs_list_labs({ filter: "cancer" });

// 3. Grant access to lab
const access = await biofs_access_grant({
  biocidOrIpId: tokenized.biocid,
  walletAddress: labs.labs[0].wallet,
  expiresIn: "90d"
});

// 4. Submit Clara job
const job = await biofs_job_submit_clara({
  biosampleId: "55052008714000",
  sequencingType: "WES"
});
```

### Workflow 3: GDPR Data Subject Request

```typescript
// 1. List all user's data
const files = await biofs_list_files({ update: true });

// 2. List all access permissions
const access = await biofs_access_list({ mine: true });

// 3. Export data (Right to Access)
for (const file of files.files) {
  await biofs_download({
    biocidOrFilename: file.biocid,
    destination: "/export/"
  });
}

// 4. Revoke all consents (Right to Withdraw)
await biofs_revoke_consent({ all: true, force: true });
```

---

## MCP Server Implementation

### Server Configuration

```json
{
  "name": "biofs-mcp-server",
  "version": "1.0.0",
  "description": "MCP server for BioFS genomic data management",
  "tools": [
    "biofs_login",
    "biofs_whoami",
    "biofs_list_files",
    "biofs_download",
    "biofs_upload",
    "biofs_tokenize_file",
    "biofs_tokenize_fastqs",
    "biofs_access_grant",
    "biofs_access_revoke",
    "biofs_access_list",
    "biofs_access_check",
    "biofs_share",
    "biofs_list_labs",
    "biofs_job_create",
    "biofs_job_status",
    "biofs_job_results",
    "biofs_job_submit_clara",
    "biofs_verify",
    "biofs_dissect",
    "biofs_revoke_consent",
    "biofs_report",
    "biofs_agent_health"
  ]
}
```

### Tool Execution Pattern

```typescript
async function executeBiofsTool(
  toolName: string,
  params: Record<string, any>
): Promise<any> {
  // Build CLI command
  const args = buildCLIArgs(toolName, params);

  // Execute with JSON output
  const result = await exec(`biofs ${args} --json`);

  // Parse and return
  return JSON.parse(result.stdout);
}

function buildCLIArgs(toolName: string, params: Record<string, any>): string {
  const toolToCommand: Record<string, string> = {
    "biofs_login": "login",
    "biofs_whoami": "whoami",
    "biofs_list_files": "biofiles",
    "biofs_download": "download",
    "biofs_upload": "upload",
    "biofs_tokenize_file": "tokenize file",
    "biofs_tokenize_fastqs": "tokenize fastqs",
    "biofs_access_grant": "access grant",
    "biofs_access_revoke": "access revoke",
    "biofs_access_list": "access list",
    "biofs_access_check": "access check",
    "biofs_share": "share",
    "biofs_list_labs": "labnfts",
    "biofs_job_create": "job create",
    "biofs_job_status": "job status",
    "biofs_job_results": "job results",
    "biofs_job_submit_clara": "job submit-clara",
    "biofs_verify": "verify",
    "biofs_dissect": "dissect",
    "biofs_revoke_consent": "access revoke-consent",
    "biofs_report": "report",
    "biofs_agent_health": "agent-health"
  };

  let cmd = toolToCommand[toolName];

  // Add positional arguments
  // Add options with --flag format
  // ...

  return cmd;
}
```

---

## Rate Limits & Best Practices

### Rate Limits
| Operation | Limit |
|-----------|-------|
| Authentication | 10/minute |
| File listing | 60/minute |
| Downloads | 100/hour |
| Uploads | 50/hour |
| Tokenization | 20/hour |
| Job submission | 10/hour |

### Best Practices for AI Agents

1. **Cache authentication**: Store session credentials, don't re-authenticate per request
2. **Use JSON output**: Always add `--json` for structured parsing
3. **Handle consent**: For automation, use `--skip-consent` only when user has pre-approved
4. **Poll with backoff**: When checking job status, use exponential backoff
5. **Verify before processing**: Use `biofs_verify` before analyzing downloaded files
6. **Respect GDPR**: Always provide data minimization options to users

---

## Support

- **API Documentation**: https://docs.genobank.io/biofs/api
- **MCP Server Source**: https://github.com/Genobank/biofs-mcp-server
- **Issues**: https://github.com/Genobank/biofs-cli/issues

---

*BioFS CLI v2.4.1 - GenoBank.io Sequentia Protocol*

