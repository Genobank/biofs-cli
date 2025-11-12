# 🧬 BioNFS + Sequentias Blockchain Integration

## 🎯 CRITICAL REALIZATION

**You already have a Sequentias blockchain running!** This changes everything about our BioNFS architecture.

---

## 📊 Current Sequentias Infrastructure

### **Running Node:**
- **Instance**: `sequentias-single-node` (i-0b8a8eb879dbba2f1)
- **Type**: t3.small
- **Public IP**: 52.90.163.112
- **Status**: ✅ Running (since Sep 30, 2025)
- **Current Block**: #48,987+
- **Block Time**: ~12 seconds (Clique PoA)

### **Blockchain Details:**
```
Network: Sequentias-Network
Chain ID: 15132025
Consensus: Clique PoA (Proof of Authority)
Validator: 0x088ebE307b4200A62dC6190d0Ac52D55bcABac11
RPC Endpoint: http://52.90.163.112:8545
WebSocket: ws://52.90.163.112:8545
P2P: tcp://52.90.163.112:30303
```

### **Smart Contracts (Pre-Deployed in Genesis):**
✅ **BioAssetRegistry** - `0x1000000000000000000000000000000000000001`
✅ **ConsentRegistry** - `0x1000000000000000000000000000000000000002`
✅ **SEQ Token (ERC20)** - (to be verified)
✅ **ProvenanceTracker** - (to be verified)
✅ **LicenseRegistry** - (to be verified)

---

## 🏗️ UPDATED BioNFS Architecture (With Sequentias Integration)

### **Previous Plan (Before Discovery):**
```
Sessions: DynamoDB or Cassandra
Permissions: Story Protocol (external blockchain)
```

### **NEW Plan (With Sequentias):**
```
Sessions: DynamoDB (Phase 1) → Cassandra (Phase 2)
Permissions: SEQUENTIAS BLOCKCHAIN ✅ (source of truth!)
```

---

## 📐 Complete Architecture Diagram

```
┌────────────────────────────────────────────────────────────┐
│  CLIENT (User's Computer)                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  FUSE Layer (web3fuse)                               │  │
│  │  Mount: /mnt/genomics/                               │  │
│  └──────────────┬───────────────────────────────────────┘  │
│                 │                                           │
│  ┌──────────────▼───────────────────────────────────────┐  │
│  │  BioNFS Client Library (libbionfs)                   │  │
│  │  - Web3 authentication                               │  │
│  │  - Session management                                │  │
│  │  - Chunk streaming                                   │  │
│  └──────────────┬───────────────────────────────────────┘  │
└─────────────────┼──────────────────────────────────────────┘
                  │
            BioNFS Protocol
          (HTTP/2 + WebSocket)
                  │
┌─────────────────▼──────────────────────────────────────────┐
│  BioNFS SERVER (genobank.app)                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Authentication Layer                                │  │
│  │  - Verify Web3 signature                            │  │
│  │  - Create session (DynamoDB)                        │  │
│  │  - Query Sequentias for permissions                 │  │
│  └──────────────┬───────────────────────────────────────┘  │
│                 │                                           │
│  ┌──────────────▼───────────────────────────────────────┐  │
│  │  Permission Layer (Sequentias Integration)          │  │
│  │  - Query ConsentRegistry smart contract            │  │
│  │  - Query LicenseRegistry smart contract            │  │
│  │  - Cache results in MongoDB                        │  │
│  └──────────────┬───────────────────────────────────────┘  │
│                 │                                           │
│  ┌──────────────▼───────────────────────────────────────┐  │
│  │  File Access Layer                                  │  │
│  │  - Query BioAssetRegistry (get S3 path)            │  │
│  │  - Verify ProvenanceTracker (data lineage)         │  │
│  │  - Stream from S3                                   │  │
│  └──────────────┬───────────────────────────────────────┘  │
└─────────────────┼──────────────────────────────────────────┘
                  │
       ┌──────────┼──────────┬──────────────┐
       │          │          │              │
       ▼          ▼          ▼              ▼
   DynamoDB   MongoDB   S3 Buckets   SEQUENTIAS BLOCKCHAIN
   (Sessions) (Cache)   (Files)      (Source of Truth)
                                      ┌──────────────────────┐
                                      │ Smart Contracts:     │
                                      │ • ConsentRegistry    │
                                      │ • LicenseRegistry    │
                                      │ • BioAssetRegistry   │
                                      │ • ProvenanceTracker  │
                                      │ • SEQ Token (ERC20)  │
                                      └──────────────────────┘
```

---

## 🔗 Integration Points

### **1. Authentication Flow**

```python
# BioNFS Server: /bionfs/v1/auth

async def authenticate(wallet: str, signature: str):
    # Step 1: Verify Web3 signature (EIP-191)
    recovered = ecrecover(signature, "BioNFS Access Request")
    if recovered != wallet:
        raise HTTPException(401, "Invalid signature")

    # Step 2: Query Sequentias blockchain for permissions
    web3 = Web3(Web3.HTTPProvider('http://52.90.163.112:8545'))

    # ConsentRegistry: What can this wallet access?
    consent_contract = web3.eth.contract(
        address='0x1000000000000000000000000000000000000002',
        abi=CONSENT_REGISTRY_ABI
    )

    # Get all biosamples this wallet has consent for
    granted_consents = consent_contract.functions.getUserConsents(wallet).call()

    # LicenseRegistry: What license tokens does this wallet hold?
    license_contract = web3.eth.contract(
        address=LICENSE_REGISTRY_ADDRESS,
        abi=LICENSE_REGISTRY_ABI
    )

    granted_licenses = license_contract.functions.getUserLicenses(wallet).call()

    # Step 3: Build granted files list
    granted_files = []

    for consent in granted_consents:
        biosample_serial = consent['biosampleSerial']
        # Query BioAssetRegistry for this biosample's files
        bioassets = bioasset_contract.functions.getBiosampleAssets(
            biosample_serial
        ).call()
        granted_files.extend(bioassets)

    for license in granted_licenses:
        ip_id = license['ipId']
        granted_files.append(ip_id)

    # Step 4: Create session in DynamoDB (cache)
    session = await session_storage.create_session(
        wallet=wallet,
        granted_files=granted_files,
        expires_at=time.time() + 86400  # 24 hours
    )

    # Step 5: Cache permissions in MongoDB (faster subsequent queries)
    mongodb.update_one(
        {"wallet": wallet},
        {"$set": {
            "granted_files": granted_files,
            "updated_at": datetime.utcnow()
        }},
        upsert=True
    )

    return {
        "session_token": session['session_token'],
        "expires_at": session['expires_at'],
        "granted_files": granted_files
    }
```

### **2. File Access Flow**

```python
# BioNFS Server: /bionfs/v1/stream/{ip_id}

async def stream_file(ip_id: str, session_token: str):
    # Step 1: Verify session (DynamoDB - fast!)
    session = await session_storage.get_session(session_token)
    if not session:
        raise HTTPException(401, "Session expired")

    # Step 2: Check cached permission (MongoDB - faster!)
    cache = mongodb.find_one({"wallet": session['wallet']})
    if ip_id in cache.get('granted_files', []):
        # Permission cached, proceed
        pass
    else:
        # Step 3: Verify on Sequentias blockchain (source of truth)
        web3 = Web3(Web3.HTTPProvider('http://52.90.163.112:8545'))

        # Check ConsentRegistry
        consent_valid = consent_contract.functions.verifyConsent(
            ip_id,
            session['wallet']
        ).call()

        # Check LicenseRegistry
        license_valid = license_contract.functions.verifyLicense(
            ip_id,
            session['wallet'],
            "read"  # permission type
        ).call()

        if not (consent_valid or license_valid):
            raise HTTPException(403, "Access denied")

        # Update cache
        mongodb.update_one(
            {"wallet": session['wallet']},
            {"$addToSet": {"granted_files": ip_id}}
        )

    # Step 4: Get file metadata from BioAssetRegistry
    bioasset = bioasset_contract.functions.getBioAsset(ip_id).call()
    s3_path = bioasset['s3Path']
    file_size = bioasset['fileSize']

    # Step 5: Stream from S3 (bypass presigned URLs!)
    async def chunk_generator():
        s3_client = boto3.client('s3')
        response = s3_client.get_object(
            Bucket='test.vault.genoverse.io',
            Key=s3_path
        )

        for chunk in response['Body'].iter_chunks(chunk_size=1024*1024):
            yield chunk

    return StreamingResponse(
        chunk_generator(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename={bioasset['name']}",
            "X-BioNFS-IP-ID": ip_id,
            "X-BioNFS-File-Size": str(file_size)
        }
    )
```

### **3. REVOKE Flow (GDPR Compliance)**

```python
# BioNFS Server: /bionfs/v1/revoke

async def revoke_access(ip_id: str, wallet: str, signature: str):
    # Step 1: Verify requester is owner
    web3 = Web3(Web3.HTTPProvider('http://52.90.163.112:8545'))

    bioasset = bioasset_contract.functions.getBioAsset(ip_id).call()
    if bioasset['owner'].lower() != wallet.lower():
        raise HTTPException(403, "Only owner can revoke")

    # Step 2: Revoke consent on Sequentias blockchain
    tx = consent_contract.functions.revokeConsent(
        ip_id
    ).build_transaction({
        'from': wallet,
        'nonce': web3.eth.get_transaction_count(wallet),
        'gas': 200000,
        'gasPrice': web3.eth.gas_price
    })

    # Sign transaction with owner's wallet
    signed_tx = web3.eth.account.sign_transaction(tx, owner_private_key)
    tx_hash = web3.eth.send_raw_transaction(signed_tx.rawTransaction)

    # Wait for confirmation
    receipt = web3.eth.wait_for_transaction_receipt(tx_hash)

    # Step 3: Invalidate all sessions accessing this file
    sessions_to_invalidate = mongodb.find({
        "granted_files": ip_id
    })

    for session_data in sessions_to_invalidate:
        # Remove from granted list
        session_token = session_data['session_token']
        session = await session_storage.get_session(session_token)
        session['granted_files'].remove(ip_id)
        await session_storage.update_session(session_token, session)

    # Step 4: Clear MongoDB cache
    mongodb.update_many(
        {"granted_files": ip_id},
        {"$pull": {"granted_files": ip_id}}
    )

    # Step 5: Delete from S3 (right to erasure)
    s3_client.delete_object(
        Bucket='test.vault.genoverse.io',
        Key=bioasset['s3Path']
    )

    # Step 6: Emit event
    emit_revocation_event(ip_id, wallet, tx_hash)

    return {
        "status": "success",
        "tx_hash": tx_hash.hex(),
        "message": "All access revoked and data deleted"
    }
```

---

## 🚀 Implementation Roadmap (UPDATED)

### **Week 1: BioNFS Server Foundation**

#### Day 1: Sequentias Integration
```bash
# Connect to existing Sequentias blockchain
✅ Add Web3 provider: http://52.90.163.112:8545
✅ Load smart contract ABIs
✅ Test ConsentRegistry.verifyConsent()
✅ Test LicenseRegistry.verifyLicense()
✅ Test BioAssetRegistry.getBioAsset()
```

#### Day 2: DynamoDB Session Storage
```bash
✅ Create bionfs_sessions table
✅ Enable TTL (24-hour auto-expire)
✅ Implement SessionStorageManager
✅ Test session creation/retrieval
```

#### Day 3: Authentication Endpoint
```bash
✅ POST /bionfs/v1/auth
  - Verify Web3 signature
  - Query Sequentias for permissions
  - Create DynamoDB session
  - Cache in MongoDB
```

#### Day 4: File Access Endpoints
```bash
✅ GET /bionfs/v1/stream/{ip_id}
  - Verify session
  - Check permissions (cache → blockchain)
  - Query BioAssetRegistry for S3 path
  - Stream from S3
```

#### Day 5: Testing & Documentation
```bash
✅ End-to-end testing
✅ Performance benchmarks
✅ API documentation
✅ Deploy to production
```

---

## 🔧 Required Environment Variables

```bash
# /home/ubuntu/Genobank_APIs/bionfs_server/.env

# Sequentias Blockchain
SEQUENTIAS_RPC_URL=http://52.90.163.112:8545
SEQUENTIAS_CHAIN_ID=15132025
SEQUENTIAS_NETWORK_NAME=sequentias

# Smart Contract Addresses
BIOASSET_REGISTRY_ADDRESS=0x1000000000000000000000000000000000000001
CONSENT_REGISTRY_ADDRESS=0x1000000000000000000000000000000000000002
LICENSE_REGISTRY_ADDRESS=0x1000000000000000000000000000000000000003  # Verify
PROVENANCE_TRACKER_ADDRESS=0x1000000000000000000000000000000000000004  # Verify
SEQ_TOKEN_ADDRESS=0x1000000000000000000000000000000000000005  # Verify

# Session Storage (DynamoDB)
AWS_REGION=us-east-1
DYNAMODB_TABLE_NAME=bionfs_sessions

# Cache (MongoDB)
MONGO_DB_HOST=mongodb+srv://cluster...  # Existing GenoBank MongoDB
MONGO_DB_NAME=genobank-api

# S3 Storage
S3_BUCKET=test.vault.genoverse.io
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

---

## 💡 KEY ADVANTAGES

### **1. Single Source of Truth**
```
Before: Story Protocol (external) + MongoDB (cache) = potential inconsistency
After:  Sequentias (owned) + MongoDB (cache) = full control
```

### **2. GDPR Compliance Built-In**
```
ConsentRegistry.sol already has:
  - grantConsent()
  - revokeConsent()
  - verifyConsent()

BioNFS just needs to INTEGRATE, not re-implement! ✅
```

### **3. Performance**
```
Without Cache:
  Sequentias RPC call: ~50ms (local network)

With MongoDB Cache:
  First access: 50ms (query blockchain + cache)
  Subsequent: <5ms (MongoDB lookup)

24-hour session = only verify once per day!
```

### **4. Cost Efficiency**
```
Sequentias Gas Costs: $0 (you own the validator!)
DynamoDB: $0 (free tier)
MongoDB: Already running
S3: Existing infrastructure

Total new cost: $0 🚀
```

---

## 📋 Next Steps

1. ✅ **Extract Smart Contract ABIs** from Sequentias-Network repository
2. ✅ **Create BioNFS server skeleton** with Web3 integration
3. ✅ **Implement authentication endpoint** with Sequentias queries
4. ✅ **Test end-to-end flow** with existing Sequentias blockchain
5. ✅ **Deploy BioNFS server** to genobank.app

**Should we start building the BioNFS server with Sequentias integration now?** 🧬
