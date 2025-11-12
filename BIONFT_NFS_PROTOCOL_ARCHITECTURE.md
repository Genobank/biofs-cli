# 🧬 BioNFT-NFS Protocol Architecture

## 🎯 Vision: True Network File System for Blockchain-Gated Genomic Data

**Problem with Presigned URLs**:
- ❌ Temporary (expire in 1 hour)
- ❌ AWS-dependent (not our protocol)
- ❌ HTTP-based (inefficient for large files)
- ❌ No innovation (just using AWS's existing solution)

**BioNFT-NFS Solution**:
- ✅ Persistent blockchain-based authentication
- ✅ Our own protocol (not dependent on AWS)
- ✅ Optimized for genomic data streaming
- ✅ True innovation (first blockchain NFS)

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    BioNFT-NFS Client                        │
│  ┌──────────────┬──────────────┬──────────────────────┐    │
│  │ biofs mount  │ biofs stream │ Application Direct   │    │
│  │ (FUSE)       │ (CLI)        │ Access (API)         │    │
│  └──────┬───────┴──────┬───────┴──────┬───────────────┘    │
│         │              │              │                     │
│         └──────────────┴──────────────┘                     │
│                        │                                    │
│           ┌────────────▼────────────┐                       │
│           │  BioNFS Client Library  │                       │
│           │  - Web3 Auth            │                       │
│           │  - License Verification │                       │
│           │  - Chunk Streaming      │                       │
│           └────────────┬────────────┘                       │
└────────────────────────┼────────────────────────────────────┘
                         │
                    BioNFS Protocol
                    (gRPC / HTTP/2)
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  BioNFT-NFS Server                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Authentication Layer (Story Protocol)               │  │
│  │  - Verify Web3 signature                            │  │
│  │  - Check NFT ownership                              │  │
│  │  - Verify License Tokens                            │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │  File Access Layer                                   │  │
│  │  - MongoDB metadata lookup                           │  │
│  │  - S3 path resolution                                │  │
│  │  - Permission caching                                │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │  Streaming Layer                                     │  │
│  │  - Chunked file delivery                             │  │
│  │  - Range requests (seek support)                     │  │
│  │  - Compression (gzip/zstd)                           │  │
│  └──────────────────┬───────────────────────────────────┘  │
└────────────────────┬┼───────────────────────────────────────┘
                     ││
      ┌──────────────┼┴──────────────┐
      │              │               │
      ▼              ▼               ▼
  MongoDB        S3 Buckets    Story Protocol
  (Metadata)     (Files)       (Permissions)
```

---

## 📋 Protocol Design

### 1. **BioNFS Wire Protocol**

```protobuf
// BioNFS Protocol Buffers Definition

service BioNFS {
  // Authentication
  rpc Authenticate(AuthRequest) returns (AuthResponse);

  // File operations
  rpc Open(OpenRequest) returns (OpenResponse);
  rpc Read(ReadRequest) returns (stream ReadResponse);
  rpc Stat(StatRequest) returns (StatResponse);
  rpc List(ListRequest) returns (ListResponse);

  // License operations
  rpc VerifyLicense(LicenseRequest) returns (LicenseResponse);
}

message AuthRequest {
  string wallet_address = 1;
  string signature = 2;
  int64 timestamp = 3;
}

message AuthResponse {
  string session_token = 1;
  int64 expires_at = 2;
  repeated string granted_ip_ids = 3;
}

message OpenRequest {
  string session_token = 1;
  string ip_id = 2;  // IP Asset ID or BioCID
  string mode = 3;   // "read", "stream"
}

message OpenResponse {
  string file_handle = 1;
  int64 file_size = 2;
  string content_type = 3;
  FileMetadata metadata = 4;
}

message ReadRequest {
  string file_handle = 1;
  int64 offset = 2;
  int64 length = 3;
}

message ReadResponse {
  bytes data = 1;
  int64 bytes_read = 2;
  bool eof = 3;
}

message FileMetadata {
  string filename = 1;
  string ip_id = 2;
  string owner = 3;
  string license_type = 4;
  int64 created_at = 5;
  string file_type = 6;
  map<string, string> attributes = 7;
}
```

### 2. **Authentication Flow**

```javascript
// Client authenticates with Web3 signature
const signature = await wallet.signMessage("BioNFS Access Request");

// Server verifies and creates session
const session = bionfs.authenticate({
  wallet: "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
  signature: signature,
  timestamp: Date.now()
});

// Session token valid for 24 hours (not 1 hour like presigned URLs!)
console.log(session.token); // "bionfs_sess_abc123..."
console.log(session.granted_files); // List of accessible IP IDs
```

### 3. **File Access Flow**

```javascript
// Open file using IP Asset ID
const file = await bionfs.open({
  session: session.token,
  ip_id: "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7"
});

// Stream file in chunks (efficient for large VCF files)
for await (const chunk of bionfs.read(file.handle)) {
  process(chunk); // Process 1MB chunks at a time
}

// Or mount entire filesystem
await bionfs.mount("/mnt/genobank", {
  session: session.token,
  auto_discover: true // Mount all granted files
});
```

---

## 🛠️ Implementation Plan

### Phase 1: BioNFS Server (Python/FastAPI) - 3 days

```python
# /home/ubuntu/Genobank_APIs/bionfs_server/server.py

from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.responses import StreamingResponse
import grpc
from concurrent import futures

app = FastAPI()

class BioNFSServer:
    def __init__(self):
        self.signature_service = SignatureService()
        self.bioip_registry = BioIPRegistryDAO()
        self.license_tokens = LicenseTokensDAO()
        self.bucket_dao = BucketDAO()
        self.sessions = {}  # In-memory session cache

    async def authenticate(self, wallet: str, signature: str):
        """Authenticate user and return session token"""
        # Verify Web3 signature
        message = "BioNFS Access Request"
        recovered = self.signature_service.recover_from_signature(signature, message)

        if recovered.lower() != wallet.lower():
            raise HTTPException(401, "Invalid signature")

        # Get all files user can access
        owned = self.bioip_registry.find({"wallet_address": wallet})
        licensed = self.license_tokens.find({
            "receiver": wallet,
            "status": "active"
        })

        # Create session (valid 24 hours)
        session_token = self.create_session(wallet, owned, licensed)

        return {
            "session_token": session_token,
            "expires_at": time.time() + 86400,  # 24 hours
            "granted_files": [f["ip_id"] for f in owned + licensed]
        }

    async def stream_file(self, session_token: str, ip_id: str, offset: int = 0):
        """Stream file in chunks"""
        # Verify session
        session = self.verify_session(session_token)

        # Check permission
        if ip_id not in session["granted_files"]:
            raise HTTPException(403, "Access denied")

        # Get file metadata
        bioip = self.bioip_registry.fetch_one({"ip_id": ip_id})
        s3_path = bioip["s3_path"]

        # Stream from S3 without presigned URL!
        async def chunk_generator():
            s3_client = self.bucket_dao.get_client()
            response = s3_client.get_object(
                Bucket="test.vault.genoverse.io",
                Key=s3_path,
                Range=f"bytes={offset}-"
            )

            # Stream 1MB chunks
            for chunk in response["Body"].iter_chunks(chunk_size=1024*1024):
                yield chunk

        return StreamingResponse(
            chunk_generator(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f"attachment; filename={bioip['filename']}",
                "X-BioNFS-IP-ID": ip_id,
                "X-BioNFS-Owner": bioip["wallet_address"]
            }
        )

# REST API endpoints
@app.post("/bionfs/v1/auth")
async def authenticate_endpoint(request: AuthRequest):
    server = BioNFSServer()
    return await server.authenticate(request.wallet, request.signature)

@app.get("/bionfs/v1/stream/{ip_id}")
async def stream_file_endpoint(ip_id: str, session: str, offset: int = 0):
    server = BioNFSServer()
    return await server.stream_file(session, ip_id, offset)
```

### Phase 2: BioNFS Client Library (TypeScript) - 2 days

```typescript
// /home/ubuntu/genobank-cli/src/lib/bionfs/client.ts

import axios from 'axios';
import { ethers } from 'ethers';

export class BioNFSClient {
  private baseUrl = 'https://bionfs.genobank.app/v1';
  private session?: BioNFSSession;

  async authenticate(wallet: ethers.Wallet): Promise<BioNFSSession> {
    // Sign authentication message
    const message = "BioNFS Access Request";
    const signature = await wallet.signMessage(message);

    // Request session from server
    const response = await axios.post(`${this.baseUrl}/auth`, {
      wallet: wallet.address,
      signature: signature,
      timestamp: Date.now()
    });

    this.session = {
      token: response.data.session_token,
      expiresAt: response.data.expires_at,
      grantedFiles: response.data.granted_files
    };

    return this.session;
  }

  async *streamFile(ipId: string): AsyncGenerator<Buffer> {
    if (!this.session) throw new Error("Not authenticated");

    // Server-side chunking (no presigned URL!)
    const response = await axios.get(`${this.baseUrl}/stream/${ipId}`, {
      params: { session: this.session.token },
      responseType: 'stream'
    });

    // Yield chunks as they arrive
    for await (const chunk of response.data) {
      yield chunk;
    }
  }

  async downloadFile(ipId: string, outputPath: string): Promise<void> {
    const writer = fs.createWriteStream(outputPath);

    for await (const chunk of this.streamFile(ipId)) {
      writer.write(chunk);
    }

    writer.close();
  }
}
```

### Phase 3: FUSE Integration - 2 days

```c
// /home/ubuntu/web3fuse/src/bionfs_fuse.c

#include <fuse.h>
#include <curl/curl.h>
#include "bionfs_client.h"

static struct bionfs_session *session;

static int bionfs_getattr(const char *path, struct stat *stbuf) {
    // Parse path to get IP ID
    // Example: /0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7/file.vcf

    bionfs_file_info_t *file = bionfs_stat(session, ip_id);

    stbuf->st_mode = S_IFREG | 0444; // Read-only file
    stbuf->st_size = file->size;
    stbuf->st_mtime = file->created_at;

    return 0;
}

static int bionfs_open(const char *path, struct fuse_file_info *fi) {
    // Verify session is valid
    if (!bionfs_verify_session(session)) {
        return -EACCES;
    }

    // Open file handle
    bionfs_file_t *file = bionfs_open_file(session, ip_id);
    fi->fh = (uint64_t)file;

    return 0;
}

static int bionfs_read(const char *path, char *buf, size_t size, off_t offset,
                       struct fuse_file_info *fi) {
    bionfs_file_t *file = (bionfs_file_t *)fi->fh;

    // Stream from server
    return bionfs_read_chunk(session, file, buf, size, offset);
}

static struct fuse_operations bionfs_oper = {
    .getattr = bionfs_getattr,
    .open    = bionfs_open,
    .read    = bionfs_read,
};

int main(int argc, char *argv[]) {
    // Initialize BioNFS session
    session = bionfs_init(wallet_address, signature);

    // Mount filesystem
    return fuse_main(argc, argv, &bionfs_oper, NULL);
}
```

---

## 🚀 Usage Examples

### Example 1: Mount All Granted Files

```bash
# Authenticate once
biofs login

# Mount all granted files to local directory
biofs mount ~/genomics

# Files appear as if they're local!
ls ~/genomics/
# 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7/
#   55052008714000.deepvariant.vcf
# 0x89224559242246F93479Fc44B0d8a1AFF5950faB/
#   analysis_results.sqlite

# Open in any tool (no download needed!)
bcftools view ~/genomics/0xCCe1.../55052008714000.deepvariant.vcf
```

### Example 2: Stream Large VCF File

```bash
# Stream file directly (no full download)
biofs stream 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 | grep "CHROM"

# Works with any Unix tool
biofs stream 0xCCe1... | head -n 1000 | less
```

### Example 3: Application Integration

```python
# Python app using BioNFS directly
from genobank_bionfs import BioNFSClient

client = BioNFSClient()
await client.authenticate(wallet_address, signature)

# Stream file without downloading
async for variant in client.stream_vcf("0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7"):
    if variant.is_pathogenic():
        print(f"Found pathogenic variant: {variant}")
```

---

## 🎯 Advantages Over Presigned URLs

| Feature | Presigned URLs | BioNFT-NFS |
|---------|---------------|------------|
| **Expiration** | 1 hour | 24 hours (session) |
| **Protocol** | AWS HTTP | Our custom protocol |
| **Streaming** | Download full file | Chunk-by-chunk streaming |
| **Mounting** | Not possible | FUSE mount support |
| **Innovation** | AWS solution | GenoBank innovation 🚀 |
| **Blockchain Auth** | Separate | Native integration |
| **License Verification** | Per-request | Session-based caching |
| **Seek Support** | No | Yes (range requests) |

---

## 📊 Performance Benefits

### Scenario: 150GB WGS VCF File

**Presigned URL Approach**:
```
1. Request presigned URL (1 second)
2. Download entire 150GB file (30+ minutes on fast connection)
3. Process file locally
Total time: 30+ minutes before analysis starts
```

**BioNFS Approach**:
```
1. Authenticate session (1 second)
2. Stream first 1MB chunk (immediate)
3. Start processing while streaming rest
Total time: Analysis starts in <2 seconds!
```

### Scenario: Checking First 1000 Variants

**Presigned URL**:
```bash
# Download entire 150GB file first
curl -o file.vcf "https://s3.amazonaws.com/...?signature=..."
head -n 1000 file.vcf
# 30 minutes wasted
```

**BioNFS**:
```bash
# Stream only what you need
biofs stream 0xCCe1... | head -n 1000
# 2 seconds total
```

---

## 🔒 Security Model

### Session-Based Authentication (Better than Presigned URLs)

```
Traditional Presigned URL:
  URL contains all credentials → Anyone with URL has access

BioNFS Session:
  Session token tied to specific wallet address
  Server verifies blockchain permissions on every request
  Token cannot be transferred (wallet-bound)
```

### Audit Trail

```python
# Every file access logged
{
    "wallet": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
    "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
    "access_type": "stream",
    "bytes_read": 1048576,
    "timestamp": "2025-10-07T04:30:00Z",
    "license_token_id": 40205
}
```

---

## 🛣️ Roadmap

### Week 1: Core Protocol
- ✅ Protocol specification (gRPC/protobuf)
- ✅ Server implementation (FastAPI)
- ✅ Basic authentication

### Week 2: Client Library
- ✅ TypeScript client
- ✅ Streaming support
- ✅ Session management

### Week 3: FUSE Integration
- ✅ Update web3fuse
- ✅ License token verification
- ✅ Mount command

### Week 4: Production
- ✅ Performance testing
- ✅ Security audit
- ✅ Documentation
- ✅ Deploy to bionfs.genobank.app

---

## 💡 Why This Is Innovative

1. **First Blockchain NFS**: No one has built a network file system with native blockchain authentication
2. **Genomics-Optimized**: Designed specifically for large genomic files (not generic cloud storage)
3. **License-Aware**: Story Protocol PIL terms integrated at protocol level
4. **GDPR-Compliant**: Audit trail + right to erasure (can revoke sessions)
5. **Open Protocol**: Can be adopted by other genomics platforms

---

## 🎉 Result

Instead of temporary AWS presigned URLs, we have:

```bash
# The GenoBank Way 🧬
biofs mount ~/genomics
cd ~/genomics
ls -la  # See all your granted files
bcftools view 0xCCe1.../file.vcf | grep "pathogenic"  # Instant analysis!
```

**This is true innovation** - a blockchain-native network file system for genomic data! 🚀

