# 🧬 BioNFS Protocol Specification v1.0

**Based on IETF NFS v4 Standards** (draft-ietf-nfsv4-internationalization-13)

---

## 1. Protocol Overview

**BioNFS** (Biological Network File System) is a blockchain-authenticated network file system protocol designed specifically for genomic data. It extends traditional NFS concepts with:

- ✅ **Blockchain-native authentication** (Web3 signatures, Story Protocol License Tokens)
- ✅ **Genomics-optimized streaming** (chunk-based delivery for large VCF/BAM/FASTQ files)
- ✅ **License-aware access control** (PIL terms enforcement at protocol level)
- ✅ **GDPR compliance** (audit trail, revocable access)

### Key Differences from NFS v4:

| Feature | NFS v4 | BioNFS |
|---------|--------|--------|
| **Authentication** | Kerberos, GSS-API | Web3 signatures (EIP-191) |
| **File Handles** | Opaque server-generated | IP Asset ID (blockchain address) |
| **Access Control** | POSIX ACLs | Story Protocol License Tokens |
| **String Encoding** | UTF-8 (RFC 3629) | UTF-8 + Ethereum addresses |
| **Session Management** | State management | Blockchain-verified sessions |
| **Internationalization** | Full Unicode support | UTF-8 + hex addresses (0x...) |

---

## 2. Protocol Architecture

### 2.1 Protocol Stack

```
┌─────────────────────────────────────────┐
│   Application Layer (biofs CLI/API)    │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   BioNFS Client Library                 │
│   - Session management                  │
│   - Web3 signature generation           │
│   - Chunk streaming                     │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   Transport Layer                       │
│   - HTTP/2 (primary)                    │
│   - gRPC (optional)                     │
│   - WebSocket (streaming)               │
└──────────────┬──────────────────────────┘
               │
┌──────────────▼──────────────────────────┐
│   TLS 1.3 (Encryption)                  │
└──────────────┬──────────────────────────┘
               │
               ▼
         Network (TCP/IP)
```

### 2.2 Protocol Versioning

Following IETF NFS v4 guidelines:

```
BioNFS Version: MAJOR.MINOR.PATCH
Example: 1.0.0

MAJOR: Incompatible protocol changes
MINOR: Backward-compatible feature additions
PATCH: Backward-compatible bug fixes
```

**Current Version**: `1.0.0` (Initial release)

---

## 3. String Encoding (Following IETF NFS v4 Section 10)

### 3.1 UTF-8 Encoding

**From IETF NFS v4 Spec**:
> "All strings within the protocol MUST be encoded as UTF-8"

**BioNFS Extension**:
All strings MUST be UTF-8 encoded, with the following additions:

1. **Ethereum Addresses** (0x-prefixed 40-character hex strings)
   ```
   Example: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
   Format: "0x" + [0-9a-fA-F]{40}
   ```

2. **Filenames** (UTF-8 with genomics extensions)
   ```
   Allowed: sample_001.vcf, patient-123.bam, exome_R1.fastq.gz
   Forbidden: Non-UTF8 bytes, control characters
   ```

3. **Session Tokens** (base64url-encoded)
   ```
   Format: "bionfs_" + base64url(signature + timestamp + random)
   Example: bionfs_eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

### 3.2 Case Sensitivity

**Following IETF NFS v4 Section 7**:
> "Servers MAY treat canonically equivalent strings as identical"

**BioNFS Implementation**:
- **Filenames**: Case-sensitive (genomics convention: `sample001.vcf` ≠ `Sample001.VCF`)
- **Ethereum addresses**: Case-insensitive (checksummed addresses optional)
- **IP Asset IDs**: Case-insensitive

```python
# Example: These are equivalent
ip_id_1 = "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7"
ip_id_2 = "0xcce14315ee3d6a41596eeb4a2839ee50a8ec59f7"
assert ip_id_1.lower() == ip_id_2.lower()  # True
```

---

## 4. Authentication Protocol

### 4.1 Web3 Signature Authentication

**Unlike NFS v4 Kerberos**, BioNFS uses Ethereum signature verification:

```
Step 1: Client generates signature
  message = "BioNFS Access Request\nTimestamp: 1696636800\nNonce: abc123"
  signature = wallet.sign(message)  # EIP-191 format

Step 2: Client sends auth request
  POST /bionfs/v1/auth
  {
    "wallet": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
    "signature": "0x42226a0eeb5ec5a441...",
    "timestamp": 1696636800,
    "nonce": "abc123"
  }

Step 3: Server verifies signature
  recovered = ecrecover(message, signature)
  if recovered == wallet:
    session = create_session(wallet, expires=86400)  # 24 hours
    return session_token

Step 4: Client uses session
  GET /bionfs/v1/open/0xCCe1...
  Authorization: Bearer bionfs_eyJhbGci...
```

### 4.2 Session Token Format

```javascript
{
  "token": "bionfs_" + base64url({
    "wallet": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
    "issued_at": 1696636800,
    "expires_at": 1696723200,  // 24 hours later
    "nonce": "abc123",
    "signature": "0x42226a0eeb5ec5a441..."
  })
}
```

### 4.3 License Token Verification

**Story Protocol Integration**:

```
Step 1: Server discovers user's licenses
  licenses = license_tokens.find({
    "receiver": wallet,
    "status": "active"
  })

Step 2: Build granted file list
  granted_files = []
  for license in licenses:
    bioip = bioip_registry.find({"ip_id": license.ip_id})
    granted_files.append(bioip)

Step 3: Cache in session
  session.granted_files = [file.ip_id for file in granted_files]
```

---

## 5. File Handles

**NFS v4 uses opaque server-generated handles**. BioNFS uses **IP Asset IDs** as file handles.

### 5.1 File Handle Structure

```
Format: IP Asset ID (Ethereum address)
Example: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7

Properties:
- Globally unique (blockchain-guaranteed)
- Persistent (never changes)
- Verifiable (can query Story Protocol)
- Human-readable (unlike opaque NFS handles)
```

### 5.2 Path Resolution

**BioNFS Path Format**:
```
/mount_point/<ip_id>/<filename>

Example:
/mnt/genobank/0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7/55052008714000.deepvariant.vcf

Breakdown:
  /mnt/genobank/           → Mount point
  0xCCe14315...            → IP Asset ID (file handle)
  55052008714000...vcf     → Original filename
```

---

## 6. Protocol Operations

### 6.1 AUTHENTICATE

**Request**:
```json
{
  "version": "1.0.0",
  "operation": "AUTHENTICATE",
  "params": {
    "wallet": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
    "signature": "0x42226a0eeb5ec5a441...",
    "timestamp": 1696636800,
    "nonce": "abc123"
  }
}
```

**Response**:
```json
{
  "status": "success",
  "session_token": "bionfs_eyJhbGci...",
  "expires_at": 1696723200,
  "granted_files": [
    "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
    "0x89224559242246F93479Fc44B0d8a1AFF5950faB"
  ]
}
```

### 6.2 OPEN

**Request**:
```json
{
  "version": "1.0.0",
  "operation": "OPEN",
  "session": "bionfs_eyJhbGci...",
  "params": {
    "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
    "mode": "read"
  }
}
```

**Response**:
```json
{
  "status": "success",
  "file_handle": "fh_abc123",
  "file_info": {
    "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
    "filename": "55052008714000.deepvariant.vcf",
    "size": 152428800,  // 145 MB
    "content_type": "text/vcf",
    "owner": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
    "license_type": "non-commercial",
    "created_at": 1696550400
  }
}
```

### 6.3 READ

**Request**:
```json
{
  "version": "1.0.0",
  "operation": "READ",
  "session": "bionfs_eyJhbGci...",
  "params": {
    "file_handle": "fh_abc123",
    "offset": 0,
    "length": 1048576  // 1 MB chunk
  }
}
```

**Response** (streaming):
```
HTTP/2 200 OK
Content-Type: application/octet-stream
Transfer-Encoding: chunked
X-BioNFS-Chunk-Size: 1048576
X-BioNFS-Total-Size: 152428800

<binary data chunk 1>
<binary data chunk 2>
...
```

### 6.4 STAT

**Request**:
```json
{
  "version": "1.0.0",
  "operation": "STAT",
  "session": "bionfs_eyJhbGci...",
  "params": {
    "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7"
  }
}
```

**Response**:
```json
{
  "status": "success",
  "file_info": {
    "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
    "filename": "55052008714000.deepvariant.vcf",
    "size": 152428800,
    "content_type": "text/vcf",
    "owner": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
    "license_type": "non-commercial",
    "created_at": 1696550400,
    "last_accessed": 1696636800,
    "md5": "3931d9ff4b23c844e8e8f1e6c1234567"
  }
}
```

### 6.5 LIST

**Request**:
```json
{
  "version": "1.0.0",
  "operation": "LIST",
  "session": "bionfs_eyJhbGci...",
  "params": {
    "filter": {
      "file_type": "vcf",
      "access_level": "granted"
    }
  }
}
```

**Response**:
```json
{
  "status": "success",
  "files": [
    {
      "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
      "filename": "55052008714000.deepvariant.vcf",
      "size": 152428800,
      "owner": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
      "access_reason": "license_token_40205"
    }
  ],
  "total_count": 1
}
```

---

## 7. Error Handling

**Following IETF NFS v4 Section 12** (Errors Related to UTF-8):

### 7.1 Standard Error Codes

```javascript
const BioNFSErrors = {
  // Authentication errors (1000-1099)
  INVALID_SIGNATURE: {
    code: 1001,
    message: "Invalid Web3 signature",
    http_status: 401
  },
  SESSION_EXPIRED: {
    code: 1002,
    message: "Session token expired",
    http_status: 401
  },

  // Permission errors (1100-1199)
  ACCESS_DENIED: {
    code: 1101,
    message: "Access denied - no license token found",
    http_status: 403
  },
  LICENSE_REVOKED: {
    code: 1102,
    message: "License token has been revoked",
    http_status: 403
  },

  // File errors (1200-1299)
  FILE_NOT_FOUND: {
    code: 1201,
    message: "IP Asset not found in registry",
    http_status: 404
  },
  INVALID_IP_ID: {
    code: 1202,
    message: "Invalid IP Asset ID format",
    http_status: 400
  },

  // String encoding errors (following NFS v4)
  INVALID_UTF8: {
    code: 1301,
    message: "String contains invalid UTF-8 sequences",
    http_status: 400
  }
};
```

### 7.2 Error Response Format

```json
{
  "status": "error",
  "error": {
    "code": 1101,
    "message": "Access denied - no license token found",
    "details": {
      "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
      "wallet": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
      "reason": "No active license token found for this IP Asset"
    }
  }
}
```

---

## 8. Security Considerations

**Following IETF NFS v4 Section 14**:

### 8.1 Signature Verification

```python
def verify_web3_signature(message: str, signature: str, expected_wallet: str) -> bool:
    """
    Verify EIP-191 signature

    Security considerations:
    - Replay attack prevention (timestamp + nonce)
    - Message tampering detection (signature verification)
    - Wallet spoofing prevention (ecrecover)
    """
    # Reconstruct signed message
    eth_message = f"\x19Ethereum Signed Message:\n{len(message)}{message}"
    message_hash = keccak256(eth_message.encode())

    # Recover signer
    recovered_wallet = ecrecover(message_hash, signature)

    # Verify
    return recovered_wallet.lower() == expected_wallet.lower()
```

### 8.2 Session Security

```javascript
// Session token includes:
// 1. Wallet address (cannot be forged)
// 2. Signature (proves wallet ownership)
// 3. Timestamp (prevents replay attacks)
// 4. Nonce (prevents reuse)

const session = {
  wallet: "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
  signature: "0x42226a0eeb5ec5a441...",
  timestamp: Date.now(),
  nonce: crypto.randomBytes(16).toString('hex'),
  expires_at: Date.now() + 86400000  // 24 hours
};
```

### 8.3 License Token Verification

```python
def verify_license_access(wallet: str, ip_id: str) -> bool:
    """
    Verify license token on Story Protocol blockchain

    Security: On-chain verification prevents forged licenses
    """
    license_token = license_tokens.find_one({
        "ip_id": ip_id,
        "receiver": wallet,
        "status": {"$ne": "revoked"}
    })

    if not license_token:
        return False

    # Optional: Verify on blockchain (paranoid mode)
    on_chain_owner = story_protocol.ownerOf(license_token.license_token_id)
    return on_chain_owner.lower() == wallet.lower()
```

---

## 9. Internationalization

**Following IETF NFS v4 Sections 5-8**:

### 9.1 UTF-8 Support

All strings MUST be valid UTF-8. This includes:
- Filenames (e.g., `patient_測試.vcf` ✅)
- User metadata (e.g., `description: "Análisis genómico"` ✅)
- Error messages (localized)

### 9.2 Ethereum Address Handling

```python
# Addresses are hex strings, not Unicode
# But must be valid UTF-8 for JSON serialization

def normalize_address(address: str) -> str:
    """
    Normalize Ethereum address to lowercase

    Following NFS v4 Section 7.2 (case-insensitive comparison)
    """
    if not address.startswith('0x'):
        raise ValueError("Invalid address format")

    if len(address) != 42:
        raise ValueError("Invalid address length")

    return address.lower()
```

---

## 10. Streaming Protocol

### 10.1 Chunked Streaming (HTTP/2)

```
Client Request:
  GET /bionfs/v1/stream/0xCCe1...
  Authorization: Bearer bionfs_eyJhbGci...
  Range: bytes=0-1048575

Server Response:
  HTTP/2 200 OK
  Content-Type: application/octet-stream
  Content-Length: 1048576
  X-BioNFS-Chunk: 1/145
  X-BioNFS-Total-Chunks: 145

  <1MB binary data>
```

### 10.2 Range Requests (Seek Support)

```javascript
// Client can seek to any position in file
const chunk = await bionfs.read({
  file_handle: "fh_abc123",
  offset: 100000000,  // Start at 100MB
  length: 1048576     // Read 1MB
});

// Efficient for VCF files (skip to specific chromosome)
const chr22_chunk = await bionfs.read({
  file_handle: "fh_vcf_123",
  offset: chr22_offset,  // Calculated from VCF index
  length: chr22_length
});
```

---

## 11. Comparison with IETF NFS v4

| Aspect | IETF NFS v4 | BioNFS |
|--------|-------------|--------|
| **Authentication** | Kerberos, GSS-API | Web3 signatures (EIP-191) |
| **Authorization** | POSIX ACLs | Story Protocol License Tokens |
| **File Handles** | Opaque (server-generated) | IP Asset IDs (blockchain addresses) |
| **State Management** | Stateful (complex) | Session-based (simple) |
| **Locking** | Full file locking | Read-only (no locking needed) |
| **Write Operations** | Full read/write | Read-only (genomic data immutable) |
| **Caching** | Client-side caching | Minimal caching (always fresh) |
| **Internationalization** | Full UTF-8 (RFC 3629) | UTF-8 + Ethereum addresses |
| **Transport** | RPC over TCP | HTTP/2, WebSocket, gRPC |

---

## 12. Implementation Roadmap

### Phase 1: Core Protocol (Week 1)
- ✅ Protocol specification (this document)
- ✅ Authentication flow (Web3 signatures)
- ✅ Session management
- ✅ Basic file operations (OPEN, READ, STAT, LIST)

### Phase 2: Server Implementation (Week 2)
- ✅ FastAPI server
- ✅ MongoDB integration
- ✅ S3 streaming
- ✅ License token verification

### Phase 3: Client Library (Week 3)
- ✅ TypeScript client
- ✅ Python client
- ✅ Streaming support
- ✅ CLI integration

### Phase 4: FUSE Integration (Week 4)
- ✅ web3fuse updates
- ✅ Mount command
- ✅ Performance optimization
- ✅ Production deployment

---

## 13. References

### 13.1 Normative References

- **IETF NFS v4**: draft-ietf-nfsv4-internationalization-13
- **UTF-8**: RFC 3629 - UTF-8, a transformation format of ISO 10646
- **EIP-191**: Ethereum Signed Message Standard
- **HTTP/2**: RFC 7540 - Hypertext Transfer Protocol Version 2

### 13.2 GenoBank References

- **Story Protocol**: https://docs.story.foundation
- **BioIP Protocol**: `/production_api/BIOIP_PROTOCOL_DOCUMENTATION.md`
- **GenoBank API**: https://genobank.app/static/Genobank_API_Educational_Guide.html

---

## 14. Appendix: Protocol Design Rationale

### Why Not Pure NFS v4?

1. **Genomics-specific**: VCF/BAM files need optimized streaming
2. **Blockchain-native**: Web3 authentication is more secure than Kerberos
3. **Immutable data**: No write operations needed (genomic data is read-only)
4. **Global access**: HTTP/2 works better than RPC over internet

### Why Session-Based Instead of Stateless?

1. **Performance**: Cache granted files list (avoid repeated blockchain queries)
2. **UX**: 24-hour sessions better than 1-hour presigned URLs
3. **Security**: Wallet-bound sessions cannot be transferred

### Why IP Asset IDs as File Handles?

1. **Globally unique**: Blockchain-guaranteed uniqueness
2. **Persistent**: Never change (unlike server-generated handles)
3. **Verifiable**: Can verify ownership on blockchain
4. **Human-readable**: Easy to debug

---

**This specification follows IETF NFS v4 design principles while adapting them for blockchain-authenticated genomic data access.**

