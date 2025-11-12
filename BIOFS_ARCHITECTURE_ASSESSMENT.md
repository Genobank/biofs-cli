# BioFS Architecture Assessment & v1.2.0 Roadmap

**Date**: October 5, 2025
**Current Version**: 1.1.0
**Target Vision**: BioNFT-Gated S3 AWS CLI + web3fuse + boto-biofs Integration

---

## 1. AWS CLI Taxonomical Architecture

### Command Structure
```
aws <service> <operation> [parameters] [options]
```

### Hierarchy Levels
1. **Service**: `s3`, `s3api`, `ec2`, `lambda`
2. **Operation**: `ls`, `cp`, `sync`, `get-object`, `put-object`
3. **Parameters**: Positional arguments (paths, files)
4. **Options**: Flags (`--recursive`, `--acl`, `--region`)

### S3 Operations Taxonomy

#### High-Level Commands (`aws s3`)
| Operation | Purpose | Example |
|-----------|---------|---------|
| `ls` | List objects | `aws s3 ls s3://bucket/path --recursive` |
| `cp` | Copy objects | `aws s3 cp file.txt s3://bucket/key` |
| `sync` | Sync directories | `aws s3 sync local/ s3://bucket/ --delete` |
| `mv` | Move objects | `aws s3 mv s3://bucket/old s3://bucket/new` |
| `rm` | Remove objects | `aws s3 rm s3://bucket/key --recursive` |
| `mb` | Make bucket | `aws s3 mb s3://bucket --region us-east-1` |
| `rb` | Remove bucket | `aws s3 rb s3://bucket --force` |
| `presign` | Generate URLs | `aws s3 presign s3://bucket/key --expires-in 3600` |

#### Low-Level API Commands (`aws s3api`)
| Operation | Purpose | Example |
|-----------|---------|---------|
| `get-object` | Download | `aws s3api get-object --bucket name --key path out.file` |
| `put-object` | Upload | `aws s3api put-object --bucket name --key path --body file` |
| `list-objects-v2` | List | `aws s3api list-objects-v2 --bucket name --prefix path/` |
| `head-object` | Metadata | `aws s3api head-object --bucket name --key path` |
| `delete-object` | Delete | `aws s3api delete-object --bucket name --key path` |

### Authentication Model
- **AWS Access Key ID** + **AWS Secret Access Key**
- Optional: IAM roles, temporary credentials, MFA

---

## 2. BioFS v1.1.0 Current State Audit

### Implemented Commands (7 total)

| Command | Alias | Purpose | AWS Equivalent |
|---------|-------|---------|----------------|
| `login` | - | Web3 authentication | N/A (Web3-specific) |
| `logout` | - | Clear credentials | N/A |
| `whoami` | - | Show wallet | N/A |
| `files` | `ls` | List BioFiles | `aws s3 ls` (partial) |
| `download` | `get` | Download file | `aws s3 cp s3://... local` |
| `upload` | `put` | Upload file | `aws s3 cp local s3://...` |
| `tokenize` | - | Mint BioIP NFT | N/A (Web3-specific) |

### Current Capabilities

#### ✅ What Works
1. **Authentication**
   - Web3 wallet signature ("I want to proceed")
   - Persistent credential storage
   - Wallet recovery from signature

2. **File Discovery**
   - List tokenized BioIP assets
   - Filter by file type (`--filter vcf`)
   - Filter by source (`--source ipfs`)
   - JSON output (`--json`)

3. **File Operations**
   - Upload to GenoBank S3 vault
   - Download via BioCID or filename
   - Stream large files

4. **Tokenization**
   - SNP fingerprinting (50 quality-filtered variants)
   - AI metadata generation (Claude Haiku)
   - Story Protocol IP Asset minting
   - PIL license attachment

#### ❌ What's Missing

### Critical Gaps for BioNFT-Gated S3 Vision

---

## 3. Missing Functionality Analysis

### 🔴 CRITICAL (Required for BioNFT-Gating)

#### 3.1 Access Control & Permissions
| Feature | Backend Endpoint | Status | Priority |
|---------|-----------------|--------|----------|
| Request access to BioNFT | `/request_biosample` | ❌ Not implemented | P0 |
| Approve access request | `/approve_biosample_request` | ❌ Not implemented | P0 |
| Revoke access | `/revoke_biosample_request` | ❌ Not implemented | P0 |
| List my permissions | `/get_permitted_biosamples` | ❌ Not implemented | P0 |
| List permittees | `/permittees?serial={serial}` | ❌ Not implemented | P0 |
| Verify NFT ownership | Local check needed | ❌ Not implemented | P0 |

**Why Critical**: Without access control, there's no "gating" - anyone can access files.

#### 3.2 Hybrid Authentication (Web3 + AWS)
| Feature | Implementation | Status | Priority |
|---------|---------------|--------|----------|
| AWS credentials integration | ENV vars + config file | ❌ Not implemented | P0 |
| Dual auth verification | Web3 sig + AWS keys | ❌ Not implemented | P0 |
| Credential rotation | Auto-refresh AWS creds | ❌ Not implemented | P1 |

**Why Critical**: boto-biofs requires AWS credentials, but access must be gated by BioNFT ownership.

#### 3.3 S3 Operations Parity
| Operation | AWS Command | BioFS Equivalent | Status |
|-----------|-------------|-----------------|--------|
| Copy | `aws s3 cp` | `biofs cp` | ❌ Not implemented |
| Move | `aws s3 mv` | `biofs mv` | ❌ Not implemented |
| Delete | `aws s3 rm` | `biofs rm` | ❌ Not implemented |
| Sync | `aws s3 sync` | `biofs sync` | ❌ Not implemented |
| Presign | `aws s3 presign` | `biofs presign` | ❌ Not implemented |

**Why Critical**: Basic S3 operations needed for CLI to be useful.

---

### 🟡 HIGH PRIORITY (Essential for Production)

#### 3.4 License Management
| Feature | Backend Endpoint | Status |
|---------|-----------------|--------|
| View license terms | `/get_license_terms_data` | ❌ Not implemented |
| Mint license token | `/mint_license_token` | ❌ Not implemented |
| Check license compliance | Local validation | ❌ Not implemented |
| Request commercial license | `/request_license` | ❌ Not implemented |

#### 3.5 Collection Management
| Feature | Backend Endpoint | Status |
|---------|-----------------|--------|
| Create collection | `/create_bioip_collection` | ❌ Not implemented |
| List collections | `/get_collections_by_category` | ❌ Not implemented |
| Add to collection | `/mint_bioip_to_collection` | ❌ Not implemented |

#### 3.6 Search & Discovery
| Feature | Backend Endpoint | Status |
|---------|-----------------|--------|
| Search BioIPs | `/search_bioips` | ❌ Not implemented |
| Search datasets | `/search_available_datasets` | ❌ Not implemented |
| Filter by license | Query param | ❌ Not implemented |
| Filter by phenotype | Query param | ❌ Not implemented |

#### 3.7 File Sharing
| Feature | Backend Endpoint | Status |
|---------|-----------------|--------|
| Share with user | `/share_file` | ❌ Not implemented |
| Share with lab | `/share_file` | ❌ Not implemented |
| List shared files | `/get_uploaded_files_shared_with_me_urls` | ❌ Not implemented |
| Lab shared files | `/find_shared_files_by_lab` | ❌ Not implemented |

---

### 🟢 MEDIUM PRIORITY (Quality of Life)

#### 3.8 Advanced File Operations
| Feature | Description | Status |
|---------|-------------|--------|
| Multipart upload | Chunks >100MB files | ❌ Not implemented |
| Resume transfers | Continue interrupted uploads | ❌ Not implemented |
| Progress bars | Show transfer progress | ⚠️ Partial (tokenize only) |
| Batch operations | Process multiple files | ❌ Not implemented |
| Server-side encryption | KMS/SSE-S3 | ❌ Not implemented |

#### 3.9 Metadata Management
| Feature | Description | Status |
|---------|-------------|--------|
| View metadata | Show NFT metadata | ❌ Not implemented |
| Update metadata | Edit title/description | ❌ Not implemented |
| Add tags | Categorize files | ❌ Not implemented |
| Search by tags | Filter by tags | ❌ Not implemented |

---

### 🔵 LOW PRIORITY (Future Enhancements)

#### 3.10 Analytics & Reporting
| Feature | Description | Status |
|---------|-------------|--------|
| Usage statistics | Downloads, views | ❌ Not implemented |
| Access logs | Who accessed what | ❌ Not implemented |
| Revenue tracking | License token sales | ❌ Not implemented |

#### 3.11 Biosample Management
| Feature | Backend Endpoint | Status |
|---------|-----------------|--------|
| List biosamples | `/my_active_biosamples` | ❌ Not implemented |
| Transfer ownership | `/create_biosample_transfer_request` | ❌ Not implemented |
| Accept transfer | `/accept_biosample_transfer` | ❌ Not implemented |

---

## 4. web3fuse Integration Requirements

### Objective
Mount BioNFT-gated S3 buckets as FUSE filesystem:
```bash
web3fuse mount s3://vault.genobank.io/biowallet/0x5f5a.../vcf/ /mnt/genomics
```

### Required biofs Functionality

#### 4.1 Mount Command
```bash
biofs mount <biocid|path> <mountpoint> [options]
```

**Options**:
- `--read-only` - Mount as read-only
- `--cache-ttl <seconds>` - Cache metadata TTL
- `--lazy` - Lazy loading (don't prefetch)

**Implementation Needs**:
1. NFT ownership verification before mount
2. Presigned URL generation with expiry
3. Cache layer for metadata
4. Permission checking on access

#### 4.2 Unmount Command
```bash
biofs unmount <mountpoint>
```

#### 4.3 Mount Management
```bash
biofs mounts              # List active mounts
biofs mount-status <path> # Check mount health
```

---

## 5. boto-biofs Integration Requirements

### Objective
Python SDK for BioNFT-gated S3 operations:
```python
from boto_biofs import S3Client

client = S3Client(
    wallet_address='0x5f5a...',
    signature='0xa514...',
    aws_access_key_id='...',
    aws_secret_access_key='...'
)

# Verify BioNFT ownership before download
client.download_file('vault.genobank.io', 'biowallet/0x.../file.vcf', 'local.vcf')
```

### Required biofs Functionality

#### 5.1 Configuration Export
```bash
biofs config export --format boto
```

**Output**: `~/.biofs/boto_config.json`
```json
{
  "wallet_address": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
  "signature": "0xa5141ae955bba91ad46a940aefc3b05120489b8b...",
  "api_endpoint": "https://genobank.app",
  "aws_access_key_id": "AKIAIOSFODNN7EXAMPLE",
  "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "default_region": "us-east-1"
}
```

#### 5.2 AWS Credential Management
```bash
biofs config aws set-credentials
biofs config aws get-credentials
biofs config aws rotate-credentials
```

---

## 6. Proposed Command Architecture for v1.2.0+

### Target Structure (AWS-inspired)

```
biofs <category> <operation> [parameters] [options]
```

### Category Taxonomy

#### 6.1 Storage Operations (`biofs s3`)
```bash
biofs s3 ls [biocid|path]                    # List files
biofs s3 cp <source> <dest>                  # Copy
biofs s3 mv <source> <dest>                  # Move
biofs s3 rm <path>                           # Delete
biofs s3 sync <source> <dest>                # Sync directories
biofs s3 presign <path> [--expires 3600]     # Generate URL
biofs s3 stat <path>                         # Show metadata
```

#### 6.2 Access Control (`biofs access`)
```bash
biofs access request <biocid|ip_id>          # Request access
biofs access grant <biocid> <wallet>         # Grant access (owner)
biofs access revoke <biocid> <wallet>        # Revoke access
biofs access list <biocid>                   # List permittees
biofs access check <biocid>                  # Check my permissions
```

#### 6.3 License Management (`biofs license`)
```bash
biofs license show <biocid>                  # View license terms
biofs license mint <biocid>                  # Mint license token
biofs license request <biocid> --commercial  # Request commercial
biofs license list                           # My license tokens
```

#### 6.4 Collection Management (`biofs collection`)
```bash
biofs collection create <name> [--symbol]    # Create collection
biofs collection list [--category vcf]       # List collections
biofs collection add <biocid> <collection>   # Add to collection
biofs collection remove <biocid>             # Remove from collection
```

#### 6.5 Tokenization (`biofs bioip`)
```bash
biofs bioip register <file>                  # Register (alias: tokenize)
biofs bioip list [--filter vcf]              # List (alias: files)
biofs bioip search <query>                   # Search registry
biofs bioip details <biocid>                 # Show details
```

#### 6.6 Sharing (`biofs share`)
```bash
biofs share with <file> <wallet|email>       # Share file
biofs share list                             # Files shared with me
biofs share revoke <file> <wallet>           # Revoke sharing
```

#### 6.7 Mount Operations (`biofs mount`)
```bash
biofs mount <biocid|path> <mountpoint>       # Mount FUSE
biofs umount <mountpoint>                    # Unmount
biofs mounts                                 # List mounts
biofs mount-status <mountpoint>              # Mount health
```

#### 6.8 Configuration (`biofs config`)
```bash
biofs config show                            # Show all config
biofs config set <key> <value>               # Set config
biofs config export [--format boto|json]     # Export config
biofs config aws set-credentials             # Set AWS creds
```

#### 6.9 Authentication (`biofs auth`)
```bash
biofs auth login                             # Web3 login
biofs auth logout                            # Clear creds
biofs auth whoami                            # Show wallet
biofs auth verify                            # Verify signature
```

---

## 7. BioNFT-Gating Implementation Strategy

### Authentication Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    BioNFT-Gated Access Flow                 │
└─────────────────────────────────────────────────────────────┘

User: biofs s3 ls biocid://0x5f5a.../bioip/3931d9ff.../file.vcf
  │
  ├─ 1. Web3 Authentication
  │    ├─ Load signature from ~/.biofs/credentials
  │    ├─ Recover wallet: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
  │    └─ Verify signature: "I want to proceed"
  │
  ├─ 2. BioNFT Ownership Verification
  │    ├─ Extract IP Asset ID from BioCID
  │    ├─ Query Story Protocol: getIpOwner(ipId)
  │    ├─ Check: owner == recovered_wallet OR
  │    └─ Query GenoBank API: /get_permitted_biosamples
  │         └─ Check: wallet in permittees list
  │
  ├─ 3. License Compliance Check
  │    ├─ Get license terms: /get_license_terms_data
  │    ├─ Check: commercial_use allowed?
  │    ├─ Check: derivatives_allowed?
  │    └─ Check: license token required?
  │
  ├─ 4. AWS S3 Access
  │    ├─ Load AWS credentials (if owner/permittee verified)
  │    ├─ Generate presigned URL: /get_presigned_link
  │    └─ Download via AWS SDK
  │
  └─ 5. Return Data
       └─ Stream file to user
```

### Access Control Matrix

| Role | NFT Owner | Permittee (Approved) | License Token Holder | Public |
|------|-----------|---------------------|---------------------|--------|
| **Read** | ✅ Always | ✅ If approved | ✅ If PIL allows | ❌ No |
| **Write** | ✅ Always | ❌ No | ❌ No | ❌ No |
| **Delete** | ✅ Always | ❌ No | ❌ No | ❌ No |
| **Share** | ✅ Always | ⚠️ Depends on PIL | ⚠️ Depends on PIL | ❌ No |
| **Tokenize** | ✅ Always | ❌ No | ❌ No | ❌ No |

---

## 8. Development Roadmap

### Phase 1: v1.2.0 - Core BioNFT Gating (Target: 2 weeks)

#### Sprint 1: Access Control Foundation
- [ ] Implement `biofs access request`
- [ ] Implement `biofs access grant`
- [ ] Implement `biofs access revoke`
- [ ] Implement `biofs access list`
- [ ] Implement `biofs access check`
- [ ] Add NFT ownership verification layer
- [ ] Add permittee verification layer

#### Sprint 2: S3 Operations Parity
- [ ] Implement `biofs s3 ls` (enhance current `files`)
- [ ] Implement `biofs s3 cp` (enhance current `upload`/`download`)
- [ ] Implement `biofs s3 mv`
- [ ] Implement `biofs s3 rm`
- [ ] Implement `biofs s3 sync`
- [ ] Implement `biofs s3 presign`
- [ ] Add access verification to all operations

#### Sprint 3: Hybrid Authentication
- [ ] AWS credentials configuration
- [ ] Credential storage in `~/.biofs/aws_credentials`
- [ ] Dual auth verification (Web3 + AWS)
- [ ] Config export for boto-biofs

**Deliverable**: BioNFT-gated S3 CLI with access control

---

### Phase 2: v1.3.0 - License & Collection Management (Target: 2 weeks)

#### Sprint 4: License System
- [ ] Implement `biofs license show`
- [ ] Implement `biofs license mint`
- [ ] Implement `biofs license request`
- [ ] Implement `biofs license list`
- [ ] Add license compliance checking to downloads

#### Sprint 5: Collection System
- [ ] Implement `biofs collection create`
- [ ] Implement `biofs collection list`
- [ ] Implement `biofs collection add`
- [ ] Implement `biofs collection remove`
- [ ] Refactor tokenize to use collections

**Deliverable**: Complete PIL management + collection system

---

### Phase 3: v1.4.0 - web3fuse Integration (Target: 3 weeks)

#### Sprint 6: Mount Operations
- [ ] Implement `biofs mount`
- [ ] Implement `biofs umount`
- [ ] Implement `biofs mounts`
- [ ] Implement `biofs mount-status`

#### Sprint 7: FUSE Layer
- [ ] Integrate with web3fuse daemon
- [ ] Implement lazy loading
- [ ] Implement metadata caching
- [ ] Implement permission checking on FUSE ops
- [ ] Handle mount failures gracefully

**Deliverable**: Mount BioNFT-gated S3 as filesystem

---

### Phase 4: v1.5.0 - boto-biofs Integration (Target: 2 weeks)

#### Sprint 8: Configuration Export
- [ ] Implement `biofs config export --format boto`
- [ ] Generate boto-compatible config files
- [ ] Document boto-biofs setup

#### Sprint 9: Python SDK Integration Testing
- [ ] Test boto-biofs with biofs config
- [ ] Verify access control works via Python
- [ ] Performance benchmarking

**Deliverable**: Full boto-biofs integration

---

### Phase 5: v2.0.0 - Production Hardening (Target: 3 weeks)

#### Sprint 10: Search & Discovery
- [ ] Implement `biofs bioip search`
- [ ] Implement dataset search
- [ ] Implement advanced filtering

#### Sprint 11: Sharing System
- [ ] Implement `biofs share with`
- [ ] Implement `biofs share list`
- [ ] Implement `biofs share revoke`

#### Sprint 12: Production Features
- [ ] Multipart upload support
- [ ] Resume interrupted transfers
- [ ] Server-side encryption
- [ ] Comprehensive error handling
- [ ] Performance optimization
- [ ] Security audit

**Deliverable**: Production-ready BioNFT-gated S3 CLI

---

## 9. Technical Architecture

### Component Stack

```
┌─────────────────────────────────────────────────────────────┐
│                     User Interface Layer                     │
│                    biofs CLI (TypeScript)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                   Authentication Layer                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Web3 Wallet  │  │  AWS IAM     │  │ Story Proto  │     │
│  │  Signature   │  │  Credentials │  │  NFT Check   │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                   Authorization Layer                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ NFT          │  │  Permittee   │  │  PIL         │     │
│  │ Ownership    │  │  Verification│  │  Compliance  │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                      Storage Layer                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  AWS S3      │  │    IPFS      │  │  MongoDB     │     │
│  │  (Genomic    │  │  (Metadata   │  │  (Registry)  │     │
│  │   Data)      │  │   Images)    │  │              │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                   Blockchain Layer                           │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ Story        │  │ Ethereum     │                        │
│  │ Protocol     │  │ Mainnet      │                        │
│  │ (IP Assets)  │  │ (Future)     │                        │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Key Decisions & Rationale

### 10.1 Why Hybrid Auth (Web3 + AWS)?

**Problem**: S3 requires AWS credentials, but BioNFT gating requires Web3 ownership proof.

**Solution**: Dual authentication
1. **Web3 signature** proves wallet ownership
2. **AWS credentials** enable S3 operations
3. **BioNFT verification** gates access to specific files

**Implementation**:
```typescript
async function verifyAccess(biocid: string, wallet: string) {
  // 1. Verify Web3 signature
  const recoveredWallet = recoverWallet(signature);
  if (recoveredWallet !== wallet) throw new Error('Invalid signature');

  // 2. Check BioNFT ownership
  const ipAsset = await getIPAsset(biocid);
  const isOwner = ipAsset.owner === wallet;
  const isPermittee = await checkPermittee(ipAsset.ip_id, wallet);

  if (!isOwner && !isPermittee) {
    throw new Error('Access denied: Not NFT owner or approved permittee');
  }

  // 3. Check license compliance
  const license = await getLicenseTerms(ipAsset.license_id);
  if (license.commercial_use === false && isCommercialUse) {
    throw new Error('Commercial use not allowed under PIL terms');
  }

  // 4. Grant AWS access
  return await generatePresignedURL(s3_path, expiry);
}
```

### 10.2 Why Category-Based Commands?

**Problem**: Flat command structure doesn't scale (e.g., `biofs request-access` vs `biofs grant-access`)

**Solution**: AWS-style categories
```bash
# Instead of:
biofs request-access <biocid>
biofs grant-access <biocid>
biofs revoke-access <biocid>

# Use:
biofs access request <biocid>
biofs access grant <biocid>
biofs access revoke <biocid>
```

**Benefits**:
- Logical grouping
- Better discoverability (`biofs access --help`)
- Scalability (add more operations without polluting namespace)

### 10.3 Why BioCID as Primary Identifier?

**Format**: `biocid://<wallet>/bioip/<registration_id>/<filename>`

**Benefits**:
1. **Globally unique** - No collision across users
2. **Self-describing** - Contains wallet, type, ID
3. **Resolvable** - Can lookup metadata from BioCID alone
4. **Blockchain-compatible** - Maps to IP Asset ID

**Example**:
```bash
biofs s3 ls biocid://0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/3931d9ff-54df-43c5-bd9b-10a273a8d37e

# Resolves to:
# - IP Asset: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
# - S3 Path: users/0x5f5a.../bioip/3931d9ff.../55052008714000.deepvariant.vcf
# - IPFS: QmNyGTuhS7TkJojvZ2N1RVgqt9rGG7hpWSMWc8SbiDhnow
```

---

## 11. Implementation Priorities

### Must-Have for v1.2.0 (MVP BioNFT Gating)
1. ✅ Access control (`biofs access`)
2. ✅ S3 operations (`biofs s3`)
3. ✅ Hybrid auth (Web3 + AWS)
4. ✅ NFT ownership verification
5. ✅ Permittee system integration

### Should-Have for v1.3.0
1. License management (`biofs license`)
2. Collection system (`biofs collection`)
3. Search & discovery
4. File sharing

### Nice-to-Have for v1.4.0+
1. FUSE mounting (`biofs mount`)
2. boto-biofs integration
3. Advanced features (multipart, resume, encryption)
4. Analytics & reporting

---

## 12. Success Metrics

### v1.2.0 Success Criteria
- [ ] Can verify BioNFT ownership before file access
- [ ] Can request/grant/revoke permittee access
- [ ] Can perform all basic S3 operations (ls, cp, mv, rm)
- [ ] Dual authentication working (Web3 + AWS)
- [ ] 100% test coverage on access control

### v1.4.0 Success Criteria
- [ ] Can mount BioNFT-gated S3 as FUSE filesystem
- [ ] web3fuse integration working
- [ ] Performance: <100ms access check latency
- [ ] Handles 10,000+ files in directory

### v2.0.0 Success Criteria
- [ ] boto-biofs fully integrated
- [ ] Production-ready (error handling, logging, monitoring)
- [ ] Security audit passed
- [ ] Documentation complete
- [ ] CLI used by 100+ researchers

---

## 13. Next Steps

### Immediate Actions (Next 48 hours)
1. **Review this assessment** with team
2. **Prioritize features** for v1.2.0
3. **Create GitHub issues** for each feature
4. **Set up project board** for sprint tracking
5. **Begin Sprint 1** (Access Control Foundation)

### Week 1 Deliverables
- [ ] `biofs access request` implemented
- [ ] `biofs access grant` implemented
- [ ] `biofs access list` implemented
- [ ] NFT ownership verification working
- [ ] Unit tests for access control

### Week 2 Deliverables
- [ ] `biofs s3 cp` implemented
- [ ] `biofs s3 mv` implemented
- [ ] `biofs s3 rm` implemented
- [ ] AWS credentials integration
- [ ] Dual auth verification working

---

## 14. Questions for Team

1. **Authentication**: Should we support AWS SSO in addition to access keys?
2. **Performance**: What's acceptable latency for NFT ownership checks? (currently ~200ms)
3. **Caching**: How long should we cache permittee lists? (currently no cache)
4. **Error Handling**: Should access denial errors show specific reason (not owner vs not permittee)?
5. **Billing**: Should we track data transfer for future billing integration?
6. **Encryption**: Should all uploads be encrypted by default (SSE-S3 vs SSE-KMS)?

---

**Document Version**: 1.0
**Last Updated**: October 5, 2025
**Author**: GenoBank Engineering Team
**Status**: Draft for Review
