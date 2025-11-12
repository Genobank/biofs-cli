# BioFS v1.3.0 - Direct Grant Feature

## ✅ Successfully Published to npm

**Package**: `@genobank/biofs@1.3.0`
**Published**: October 7, 2025
**npm URL**: https://www.npmjs.com/package/@genobank/biofs

## Major New Feature: Direct Grant Access Control

### Problem Solved

Previously, BioFS access control only supported one flow:
1. Researcher **requests** access → `biofs access request <ip_id>`
2. Owner **approves** request → `biofs access grant <ip_id> <wallet>`

This required researchers to know about the asset and proactively request access.

### What's New in v1.3.0

**Two Access Grant Flows Now Supported:**

#### 1. Direct Grant (NEW) - Owner-Initiated
Owner can proactively grant access to researchers **WITHOUT** requiring them to request access first.

```bash
# Owner grants access directly (no request needed)
biofs access grant <ip_id> <researcher_wallet>

# Example:
biofs access grant 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 0xb3c3a584491b8ca4df45116a1e250098a0d6192d

# Output:
══════════════════════════════════════════════════════════════════
  License Token Grant Confirmation (GDPR Consent)
══════════════════════════════════════════════════════════════════
  Grant Type: Direct Grant (owner-initiated)
  IP Asset ID: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
  Granted To: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d
  License Type: Non-Commercial (GDPR Research Consent)
  License Token ID: 40249
  Blockchain TX: 0x...
══════════════════════════════════════════════════════════════════
```

#### 2. Request-Based Grant (Existing) - Researcher-Initiated
Traditional flow where researcher requests, then owner approves.

```bash
# Researcher requests access
biofs access request <ip_id>

# Owner approves request
biofs access grant <ip_id> <researcher_wallet>

# Output:
══════════════════════════════════════════════════════════════════
  License Token Grant Confirmation (GDPR Consent)
══════════════════════════════════════════════════════════════════
  Grant Type: Request-Based (researcher-requested)
  IP Asset ID: 0x...
  Granted To: 0x...
  License Type: Non-Commercial (GDPR Research Consent)
══════════════════════════════════════════════════════════════════
```

### How It Works

The CLI now uses a **smart fallback mechanism**:

1. **Tries Direct Grant First**: Attempts to grant access directly (no request needed)
2. **Falls Back to Request-Based**: If direct grant fails, looks for pending request
3. **Clear Error Messages**: Tells you exactly what's needed if both fail

```typescript
// From src/commands/access/grant.ts
try {
  // Try direct grant first
  result = await api.directGrantLicenseToken(ipId, walletAddress, licenseType);
  grantType = 'direct';
} catch (directGrantError) {
  // Fall back to request-based grant
  const requests = await api.getPendingLicenseRequests(ipId);
  const pendingRequest = requests.find(r =>
    r.requester?.toLowerCase() === walletAddress.toLowerCase()
  );

  if (!pendingRequest) {
    throw new Error('No pending license token request found for this wallet address. The researcher must request access first, or you can use the direct grant flow.');
  }

  result = await api.grantLicenseToken(pendingRequest._id, walletAddress);
  grantType = 'request-based';
}
```

### API Changes

#### New API Client Method

Added `directGrantLicenseToken()` to `/src/lib/api/client.ts`:

```typescript
async directGrantLicenseToken(
  ipId: string,
  receiverWallet: string,
  licenseType: string = 'non-commercial'
): Promise<any> {
  const signature = await this.getSignature();
  const response = await this.axios.post('/api_bioip/direct_grant_license_token', {
    user_signature: signature,
    ip_id: ipId,
    receiver_wallet: receiverWallet,
    license_type: licenseType
  });

  if (response.data.status === 'Success') {
    return response.data.status_details?.data || response.data;
  }
  throw new Error(response.data.status_details?.message || 'Direct grant failed');
}
```

#### New Backend Endpoint

Added `direct_grant_license_token()` to `/production_api/plugins/bioip/api_bioip.py`:

```python
@cherrypy.expose
@cherrypy.tools.CORS()
@cherrypy.tools.allow(methods=["POST"])
@cherrypy.tools.json_in()
@cherrypy.tools.json_out()
def direct_grant_license_token(
    self,
    user_signature=None,
    ip_id=None,
    receiver_wallet=None,
    license_type="non-commercial"
):
    """
    DIRECT GRANT: Mint a license token without requiring a request first

    Allows the IP owner to proactively grant access to researchers
    without waiting for them to request access first.
    """
    # Verify ownership
    owner_wallet = self.signature_service.recover_from_signature(user_signature, ...)
    bioip = self.bioip_service.fetch_one({"ip_id": ip_id})

    if asset_owner.lower() != owner_wallet.lower():
        return self.create_response("Failure", {
            'message': 'Unauthorized',
            'description': 'Only the IP asset owner can grant access'
        })

    # Check for existing token
    existing_token = license_tokens_collection.find_one({
        "ip_id": ip_id,
        "receiver": receiver_wallet,
        "status": {"$ne": "revoked"}
    })

    if existing_token:
        return self.create_response("Failure", {
            'message': 'Already Has Access',
            'description': f'Wallet already has an active license token'
        })

    # Mint license token on blockchain
    license_token_result = self.story_protocol_manager.mint_license_token(
        ip_id=ip_id,
        license_terms_id=int(license_terms_id),
        receiver=receiver_wallet,
        amount=1
    )

    # Save to MongoDB with grant_type='direct'
    license_token_data = {
        "ip_id": ip_id,
        "sender": owner_wallet,
        "receiver": receiver_wallet,
        "license_token_id": license_token_result["startLicenseTokenId"],
        "tx_hash": license_token_result["tx_hash"],
        "status": "active",
        "grant_type": "direct",  # Mark as direct grant
        "created_at": datetime.datetime.now()
    }
    self.license_token_service.create(license_token_data)
```

## Use Cases

### Use Case 1: Collaborative Research
**Scenario**: PI wants to share genomic data with collaborators

```bash
# PI grants access to 3 collaborators without requiring requests
biofs access grant 0xMyDataset 0xCollaborator1
biofs access grant 0xMyDataset 0xCollaborator2
biofs access grant 0xMyDataset 0xCollaborator3

# All 3 can immediately download
biofs download 0xMyDataset ./my-analysis/
```

### Use Case 2: Data Sharing Workshop
**Scenario**: Instructor wants to share teaching datasets with students

```bash
# Instructor shares dataset with 20 students
for wallet in $(cat student_wallets.txt); do
  biofs access grant 0xTeachingDataset $wallet
done

# Students can immediately access data
biofs files  # Shows shared dataset
biofs download 0xTeachingDataset ./course-materials/
```

### Use Case 3: Consortium Data Sharing
**Scenario**: Consortium lead shares aggregated data with all members

```bash
# Consortium lead grants access to all member institutions
biofs access grant 0xConsortiumData 0xInstitution1
biofs access grant 0xConsortiumData 0xInstitution2
# ... (continues for all members)

# Members can access immediately without requesting
```

### Use Case 4: Traditional Request Flow Still Supported
**Scenario**: Researcher discovers public dataset and requests access

```bash
# Researcher requests access
biofs access request 0xPublicDataset

# Owner approves (uses same grant command)
biofs access grant 0xPublicDataset 0xResearcher

# Output shows: "Grant Type: Request-Based (researcher-requested)"
```

## Installation & Update

### Install New Version

```bash
# Uninstall old version
npm uninstall -g @genobank/biofs

# Install v1.3.0
npm install -g @genobank/biofs@1.3.0

# Verify
biofs --version  # Should show: 1.3.0
```

### Update from v1.2.9

```bash
npm update -g @genobank/biofs
biofs --version  # Should show: 1.3.0
```

## Testing the Feature

### Test Direct Grant

```bash
# 1. Authenticate as owner
biofs login

# 2. List your BioIP assets
biofs files

# 3. Grant access to a wallet directly
biofs access grant <ip_id> <researcher_wallet>

# 4. Verify grant
biofs access list <ip_id>
# Should show the granted wallet with status: active
```

### Test Researcher Access

```bash
# 1. Authenticate as researcher
biofs login

# 2. List accessible files
biofs files
# Should show granted dataset

# 3. Download granted file
biofs download <ip_id> ./destination/
# Should download successfully
```

## Files Modified

### CLI Changes

1. **`src/lib/api/client.ts`** - Added `directGrantLicenseToken()` method
2. **`src/commands/access/grant.ts`** - Updated to try direct grant first, fall back to request-based
3. **`package.json`** - Version bumped to 1.3.0

### Backend Changes

1. **`plugins/bioip/api_bioip.py`** - Added `direct_grant_license_token()` endpoint
2. **`plugins/bioip/libs/dao/license_tokens_dao.py`** - Supports `grant_type` field
3. **`plugins/bioip/libs/service/license_token_service.py`** - Handles direct grants

## MongoDB Changes

### New Field: `grant_type`

License tokens now include `grant_type` to distinguish flows:

```json
{
  "_id": ObjectId("..."),
  "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
  "sender": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
  "receiver": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
  "license_token_id": 40249,
  "tx_hash": "0x...",
  "status": "active",
  "grant_type": "direct",  // NEW: "direct" or "request-based"
  "created_at": ISODate("2025-10-07T01:15:00Z")
}
```

## Security & GDPR Compliance

### Access Control Unchanged

- **Ownership Verification**: Only IP asset owner can grant access (both flows)
- **Blockchain Enforcement**: All grants minted as Story Protocol license tokens
- **Revocation Supported**: `biofs access revoke <ip_id> <wallet>` works for both flows

### GDPR Rights Preserved

- **Right to Erasure**: Revoke license token = revoke data access (both flows)
- **Consent Management**: License tokens = GDPR consent mechanism
- **Audit Trail**: MongoDB records all grants with timestamps and grant_type

## Backward Compatibility

✅ **Fully Backward Compatible**

- Existing request-based flow works unchanged
- Old CLI versions still work (just don't have direct grant)
- MongoDB queries unchanged (grant_type is optional field)
- API endpoints are additive (no breaking changes)

## Breaking Changes

**None**. This is a purely additive feature.

## Version History

- **v1.3.0** (Oct 7, 2025): Added direct grant access control
- **v1.2.9** (Oct 7, 2025): Fixed ESM warnings, added verbose mode
- **v1.2.8** (Oct 7, 2025): Version banner fix
- **v1.2.7** (Oct 7, 2025): Added annotator intelligence
- **v1.2.6** (Oct 5, 2025): Added BioOS job management

## Support

- **npm Package**: https://www.npmjs.com/package/@genobank/biofs
- **GitHub**: https://github.com/Genobank/genobank-cli
- **Support**: support@genobank.io

---

**Version**: 1.3.0
**Status**: ✅ Published and ready for use
**Key Feature**: Direct Grant - Owner can proactively share data without requiring requests
