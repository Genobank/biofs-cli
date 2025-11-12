# Story PIL-Based Access Control Design

**Date**: October 5, 2025
**Version**: BioFS v1.2.0 → v1.2.1 (PIL Integration)

---

## 🎯 Core Concept: PIL as GDPR Consent Mechanism

### License Types = Consent Types

| PIL License | GDPR Status | Access Level | Cost | Revocable |
|-------------|-------------|--------------|------|-----------|
| **No License** | No consent | ❌ Denied | N/A | N/A |
| **Non-Commercial (NCSR)** | ✅ GDPR consent | ✅ Read-only research | Free | ✅ Yes |
| **Commercial Use** | ✅ Implicit consent | ✅ Commercial use | Minting fee | ✅ Yes |
| **Commercial Remix** | ✅ Implicit consent | ✅ Create derivatives | Minting fee + rev share | ✅ Yes |

### Key Insight

**Story Protocol PIL = Programmable Consent Management**

- Non-commercial license = "I consent to researchers accessing my genomic data for non-commercial research"
- Commercial license = "I consent to companies accessing my data for commercial use, with compensation"
- License token revocation = GDPR Right to Erasure (revoke consent)

---

## 📊 Story Protocol Architecture

### Smart Contract Methods (StoryIpManagerDAO)

```python
# 1. Mint NFT + Create PIL Terms + Attach License
mint_and_register_and_create_terms_and_attach(
    collection_address,  # NFT collection
    receiver,            # Owner wallet
    ip_metadata,         # IPFS metadata
    license_terms_metadata  # PIL terms
)

# 2. Mint License Token (Grant Access)
mint_license_token(
    ip_id,              # IP Asset ID
    license_terms_id,   # PIL terms ID
    receiver,           # Researcher/company wallet
    amount              # Number of tokens (usually 1)
)

# 3. Attach PIL Terms to Existing IP
attach_license_terms(
    ip_id,              # IP Asset ID
    license_terms_id    # PIL terms ID
)
```

### PIL License Terms Structure

```python
{
    "transferable": True,
    "royaltyPolicy": "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    "defaultMintingFee": 0,  # 0 for NCSR, fee for commercial
    "expiration": 1735689600,  # Unix timestamp
    "commercialUse": False,  # False = GDPR consent, True = commercial
    "commercialAttribution": False,
    "commercializerChecker": "0x0000000000000000000000000000000000000000",
    "commercializerCheckerData": "0x",
    "commercialRevShare": 0,  # 0 for NCSR, percentage for commercial
    "commercialRevCeiling": 0,
    "derivativesAllowed": True,
    "derivativesAttribution": True,
    "derivativesApproval": True,
    "derivativesReciprocal": True,
    "derivativeRevCeiling": 0,
    "currency": "0x...",  # STORY_CURRENCY address
    "uri": "https://github.com/piplabs/pil-document/blob/.../NCSR.json"
}
```

### MongoDB Collection: `license_tokens`

```javascript
{
    "_id": ObjectId("..."),
    "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",  // IP Asset
    "license_terms_id": "5",  // PIL terms ID
    "receiver": "0x992b0a77...",  // Researcher wallet
    "sender": "0x5f5a60Ea...",  // GenoBank executor
    "amount": 1,
    "license_token_id": "12345",  // Blockchain license token ID
    "tx_hash": "0x...",
    "status": "active",  // active | revoked
    "revoked_at": null,  // Timestamp if revoked
    "createdAt": ISODate("2025-10-05T12:00:00Z"),
    "updatedAt": ISODate("2025-10-05T12:00:00Z")
}
```

---

## 🔄 Access Control Workflows

### Workflow 1: Request Non-Commercial Access (GDPR Consent)

**User Action**:
```bash
biofs access request biocid://0x5f5a.../bioip/3931d9ff... --message "PhD research on cancer"
```

**Backend Flow**:
1. CLI sends request to API endpoint: `POST /api_bioip/request_license_token`
2. API creates request record in MongoDB `license_token_requests` collection:
```javascript
{
    "ip_id": "0xCCe14...",
    "requester": "0x992b0a77...",
    "owner": "0x5f5a60Ea...",
    "license_type": "non-commercial",  // GDPR consent
    "message": "PhD research on cancer",
    "status": "pending",  // pending | approved | rejected
    "createdAt": ISODate("...")
}
```
3. API returns request ID to CLI
4. CLI displays success message with instructions

**Output**:
```
✓ Access request submitted successfully

══════════════════════════════════════════════════════════════════
  Access Request Details
══════════════════════════════════════════════════════════════════
  IP Asset ID: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
  License Type: Non-Commercial (GDPR Research Consent)
  Message: PhD research on cancer
══════════════════════════════════════════════════════════════════

⏳ Waiting for owner approval...
   You will be notified when the request is approved.

   Check status: biofs access list --mine
```

---

### Workflow 2: Grant Access (Mint License Token)

**User Action** (Owner):
```bash
biofs access grant biocid://0x5f5a.../bioip/3931d9ff... 0x992b0a77... --license non-commercial
```

**Backend Flow**:
1. CLI sends grant request to API: `POST /api_bioip/grant_license_token`
2. API verifies:
   - Caller is IP asset owner
   - Pending request exists from wallet
   - IP has PIL terms attached
3. API calls Story Protocol:
```python
license_result = story_protocol_manager.mint_license_token(
    ip_id="0xCCe14...",
    license_terms_id=5,  # Non-commercial PIL ID
    receiver="0x992b0a77...",
    amount=1
)
```
4. API saves license token to MongoDB:
```javascript
{
    "ip_id": "0xCCe14...",
    "license_terms_id": "5",
    "receiver": "0x992b0a77...",
    "sender": "0x5f5a60Ea...",
    "amount": 1,
    "license_token_id": license_result["startLicenseTokenId"],
    "tx_hash": license_result["tx_hash"],
    "status": "active",
    "createdAt": ISODate("...")
}
```
5. API updates request status to "approved"
6. CLI displays success with blockchain transaction details

**Output**:
```
✓ License token minted successfully

══════════════════════════════════════════════════════════════════
  License Grant Confirmation
══════════════════════════════════════════════════════════════════
  IP Asset ID: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
  Granted To: 0x992b0a77...
  License Type: Non-Commercial (GDPR Research Consent)
  License Token ID: 12345
  Transaction: 0xabcd1234... ✓ Confirmed
══════════════════════════════════════════════════════════════════

✓ The researcher can now download files using:
  biofs s3 cp biocid://0x5f5a.../bioip/3931d9ff... ./destination
```

---

### Workflow 3: Revoke Access (GDPR Right to Erasure)

**User Action** (Owner):
```bash
biofs access revoke biocid://0x5f5a.../bioip/3931d9ff... 0x992b0a77...
```

**Backend Flow**:
1. CLI sends revoke request to API: `POST /api_bioip/revoke_license_token`
2. API finds license token in MongoDB
3. API updates license token status:
```javascript
{
    "status": "revoked",
    "revoked_at": ISODate("2025-10-05T13:00:00Z"),
    "revoked_by": "0x5f5a60Ea...",
    "updatedAt": ISODate("2025-10-05T13:00:00Z")
}
```
4. **NOTE**: Story Protocol doesn't have a burn mechanism yet, so we rely on MongoDB status
5. Future: When S3 Object Lambda is implemented, check MongoDB status before allowing download

**Output**:
```
✓ Access revoked successfully

══════════════════════════════════════════════════════════════════
  Access Revocation Confirmation
══════════════════════════════════════════════════════════════════
  IP Asset ID: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
  Revoked From: 0x992b0a77...
  Status: Consent Withdrawn (GDPR Article 17)
══════════════════════════════════════════════════════════════════

⚠  The researcher can no longer download files from this asset.
   GDPR right to erasure has been exercised.
```

---

### Workflow 4: List License Tokens (Permittees)

**User Action** (Owner):
```bash
biofs access list biocid://0x5f5a.../bioip/3931d9ff...
```

**Backend Flow**:
1. CLI calls API: `GET /api_bioip/get_license_tokens?ip_id=0xCCe14...`
2. API queries MongoDB:
```python
license_tokens = license_token_service.fetch({
    "ip_id": "0xCCe14...",
    "status": {"$ne": "revoked"}  # Exclude revoked
})
```
3. API returns list of active license tokens
4. CLI displays in table format

**Output**:
```
✓ Active license tokens for IP Asset: 3

┌──────────────────────────────────────────┬─────────────────┬───────────────┬──────────────┐
│ Researcher Wallet                        │ License Type    │ Granted Date  │ Token ID     │
├──────────────────────────────────────────┼─────────────────┼───────────────┼──────────────┤
│ 0x992b0a77...                            │ Non-Commercial  │ Oct 5, 2025   │ 12345        │
│ 0x7f3c81bc...                            │ Non-Commercial  │ Oct 4, 2025   │ 12344        │
│ 0x3e9a5c2f...                            │ Commercial      │ Oct 3, 2025   │ 12343        │
└──────────────────────────────────────────┴─────────────────┴───────────────┴──────────────┘

⏳ 2 pending requests
   Approve: biofs access grant <biocid> <wallet>
```

---

### Workflow 5: Check Access (License Token Verification)

**User Action** (Researcher):
```bash
biofs access check biocid://0x5f5a.../bioip/3931d9ff...
```

**Backend Flow**:
1. CLI calls API: `GET /api_bioip/check_my_access?ip_id=0xCCe14...&wallet=0x992b0a77...`
2. API checks:
   - Is user the IP owner? (check Story Protocol)
   - Does user have active license token? (check MongoDB)
   - What are the PIL terms? (query Story Protocol)
3. API returns access details
4. CLI displays color-coded result

**Output (Has License)**:
```
══════════════════════════════════════════════════════════════════
  Access Check Results
══════════════════════════════════════════════════════════════════
  IP Asset ID: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
  Owner: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
  Your Wallet: 0x992b0a77...
──────────────────────────────────────────────────────────────────
  ✓ ACCESS LEVEL: Licensed Researcher

  License Details:
    • Type: Non-Commercial (GDPR Research Consent)
    • Token ID: 12345
    • Granted: Oct 5, 2025
    • Status: Active
    • Transaction: 0xabcd1234...

  Available actions:
    • Download: biofs s3 cp biocid://... ./destination
    • View metadata: biofs s3 stat biocid://...

  License Terms:
    • Commercial use: ✗ Not allowed (GDPR consent for research only)
    • Derivatives: ✓ Allowed (with attribution)
    • Attribution: ⚠ Required
══════════════════════════════════════════════════════════════════
```

---

## 🚀 Implementation Plan

### Phase 1: Backend API Endpoints (Python)

**File**: `/home/ubuntu/Genobank_APIs/production_api/plugins/bioip/api_bioip.py`

```python
# 1. Request License Token
@app.route('/api_bioip/request_license_token', methods=['POST'])
def request_license_token(self):
    # Save request to license_token_requests collection
    pass

# 2. Grant License Token (Mint)
@app.route('/api_bioip/grant_license_token', methods=['POST'])
def grant_license_token(self):
    # Call story_protocol_manager.mint_license_token()
    # Save to license_tokens collection
    pass

# 3. Revoke License Token
@app.route('/api_bioip/revoke_license_token', methods=['POST'])
def revoke_license_token(self):
    # Update status to "revoked" in license_tokens
    pass

# 4. Get License Tokens (List Permittees)
@app.route('/api_bioip/get_license_tokens', methods=['GET'])
def get_license_tokens(self):
    # Query license_tokens by ip_id
    pass

# 5. Check My Access
@app.route('/api_bioip/check_my_access', methods=['GET'])
def check_my_access(self):
    # Check ownership + license tokens
    pass

# 6. Get Pending Requests
@app.route('/api_bioip/get_pending_license_requests', methods=['GET'])
def get_pending_license_requests(self):
    # Query license_token_requests by ip_id
    pass
```

### Phase 2: CLI Updates (TypeScript)

Update all access commands in `src/commands/access/` to use new PIL-based endpoints.

### Phase 3: MongoDB Collections

Create new collection: `license_token_requests`

```javascript
{
    "_id": ObjectId("..."),
    "ip_id": "0xCCe14...",
    "requester": "0x992b0a77...",
    "owner": "0x5f5a60Ea...",
    "license_type": "non-commercial",  // non-commercial | commercial
    "message": "Research purpose",
    "status": "pending",  // pending | approved | rejected
    "createdAt": ISODate("..."),
    "updatedAt": ISODate("...")
}
```

Update existing collection: `license_tokens` - add status field

---

## 🎯 Key Benefits

1. **GDPR Compliance**: Non-commercial licenses = explicit research consent
2. **Blockchain Proof**: Every access grant is on-chain and verifiable
3. **Revocable**: License tokens can be revoked (GDPR Article 17)
4. **Commercial Compensation**: Commercial licenses include minting fees + revenue share
5. **Transparent**: All license terms are on-chain and queryable
6. **Audit Trail**: Complete history of who accessed what and when

---

## 📝 Next Steps

1. ✅ Design complete (this document)
2. ⏳ Implement backend API endpoints
3. ⏳ Update CLI access commands
4. ⏳ Test with real Story Protocol testnet
5. ⏳ Integrate with S3 Object Lambda for enforcement

---

**Last Updated**: October 5, 2025
**Status**: Design Complete - Ready for Implementation
