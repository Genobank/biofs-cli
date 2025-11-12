# BioFS v1.3.0 Release Summary

## ✅ Successfully Published to npm

**Package**: `@genobank/biofs@1.3.0`
**Published**: October 7, 2025
**npm URL**: https://www.npmjs.com/package/@genobank/biofs
**Package Size**: 167.3 kB (unpacked: 763.9 kB)

## Major Feature: Direct Grant Access Control

### What Changed

**NEW**: IP asset owners can now grant access to researchers **directly** without requiring them to request access first.

### Both Access Flows Now Supported

#### 1. Direct Grant (NEW) ✨
```bash
# Owner grants access directly (no request needed)
biofs access grant <ip_id> <researcher_wallet>

# Example:
biofs access grant 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 0xb3c3a584491b8ca4df45116a1e250098a0d6192d

# Output shows:
Grant Type: Direct Grant (owner-initiated)
```

#### 2. Request-Based Grant (Existing)
```bash
# Researcher requests access
biofs access request <ip_id>

# Owner approves
biofs access grant <ip_id> <researcher_wallet>

# Output shows:
Grant Type: Request-Based (researcher-requested)
```

### Smart Fallback Mechanism

The CLI automatically tries the best flow:
1. **Tries direct grant first** (no request needed)
2. **Falls back to request-based** if request exists
3. **Clear error messages** if both fail

## Installation

### New Install
```bash
npm install -g @genobank/biofs@1.3.0
biofs --version  # Should show: 1.3.0
```

### Update from Previous Version
```bash
npm update -g @genobank/biofs
biofs --version  # Should show: 1.3.0
```

## Testing the Feature

### Live Test Results ✅

Successfully tested on production server:

```bash
# 1. Listed server's BioIP files
./bin/biofs.js files --json
# Found: 17 BioIP files owned by 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a

# 2. Granted direct access to Dra. Claudia
./bin/biofs.js access grant 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 0xb3c3a584491b8ca4df45116a1e250098a0d6192d

# Result:
══════════════════════════════════════════════════════════════════
  License Token Grant Confirmation (GDPR Consent)
══════════════════════════════════════════════════════════════════
  Grant Type: Direct Grant (owner-initiated)
  IP Asset ID: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
  Granted To: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d
  License Type: Non-Commercial (GDPR Research Consent)
══════════════════════════════════════════════════════════════════

# 3. Verified grant in access list
./bin/biofs.js access list 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7

# Shows:
┌─────────────────────────────────────────────┬────────────────────┬───────────────┬────────────┬───────────────┐
│ Researcher Wallet                           │ License Type       │ Date          │ Status     │ Token ID      │
├─────────────────────────────────────────────┼────────────────────┼───────────────┼────────────┼───────────────┤
│ 0xb3c3a584491b8ca4df45116a1e250098a0d6192d  │ GDPR Research      │ 10/7/2025     │ active     │ 40249         │
└─────────────────────────────────────────────┴────────────────────┴───────────────┴────────────┴───────────────┘

✅ License token ID 40249 successfully minted on blockchain
✅ Dra. Claudia can now access the file
```

## Files Modified

### Frontend (CLI)
1. **`src/lib/api/client.ts`** - Added `directGrantLicenseToken()` method
2. **`src/commands/access/grant.ts`** - Smart fallback: try direct grant → request-based
3. **`package.json`** - Version 1.2.9 → 1.3.0
4. **`src/index.ts`** - Version and banner updated

### Backend (API)
1. **`plugins/bioip/api_bioip.py`** - Added `direct_grant_license_token()` endpoint
2. **Production API restarted** - New endpoint now live

### Documentation
1. **`BIOFS_V1.3.0_DIRECT_GRANT.md`** - Comprehensive feature documentation
2. **`RELEASE_SUMMARY_V1.3.0.md`** - This release summary

## API Changes

### New Endpoint

**POST** `/api_bioip/direct_grant_license_token`

**Request:**
```json
{
  "user_signature": "0x...",
  "ip_id": "0x...",
  "receiver_wallet": "0x...",
  "license_type": "non-commercial"
}
```

**Response:**
```json
{
  "status": "Success",
  "status_details": {
    "data": {
      "license_token_id": 40249,
      "tx_hash": "0x...",
      "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
      "receiver": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
      "owner": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
      "license_type": "non-commercial",
      "grant_type": "direct",
      "message": "Direct access granted! 0xb3c3a584... can now access the data"
    }
  }
}
```

### New Client Method

**TypeScript:**
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

## MongoDB Changes

### New Field: `grant_type`

License tokens now track how they were created:

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

## Use Cases

### 1. Collaborative Research
PI shares genomic data with collaborators without requiring requests:
```bash
biofs access grant 0xMyDataset 0xCollaborator1
biofs access grant 0xMyDataset 0xCollaborator2
biofs access grant 0xMyDataset 0xCollaborator3
```

### 2. Teaching & Workshops
Instructor shares datasets with students:
```bash
for wallet in $(cat student_wallets.txt); do
  biofs access grant 0xTeachingDataset $wallet
done
```

### 3. Consortium Data Sharing
Consortium lead shares aggregated data with all member institutions:
```bash
biofs access grant 0xConsortiumData 0xInstitution1
biofs access grant 0xConsortiumData 0xInstitution2
# ... (continues for all members)
```

### 4. Traditional Request Flow
Researcher discovers public dataset and requests access:
```bash
# Researcher: request access
biofs access request 0xPublicDataset

# Owner: approve request
biofs access grant 0xPublicDataset 0xResearcher
# Output: "Grant Type: Request-Based (researcher-requested)"
```

## Security & Compliance

### Access Control ✅
- **Ownership Verification**: Only IP asset owner can grant (both flows)
- **Blockchain Enforcement**: All grants = Story Protocol license tokens
- **Revocation Supported**: `biofs access revoke` works for both flows

### GDPR Compliance ✅
- **Right to Erasure**: Revoke license token = revoke data access
- **Consent Management**: License tokens = GDPR consent mechanism
- **Audit Trail**: MongoDB records all grants with timestamps and grant_type

## Backward Compatibility ✅

**Fully Backward Compatible**:
- ✅ Existing request-based flow unchanged
- ✅ Old CLI versions still work (just lack direct grant)
- ✅ MongoDB queries unchanged (grant_type is optional)
- ✅ API endpoints are additive (no breaking changes)

## Breaking Changes

**None**. This is a purely additive feature.

## Version History

- **v1.3.0** (Oct 7, 2025): ✨ Added direct grant access control
- **v1.2.9** (Oct 7, 2025): Fixed ESM warnings, added verbose mode
- **v1.2.8** (Oct 7, 2025): Version banner fix
- **v1.2.7** (Oct 7, 2025): Added annotator intelligence
- **v1.2.6** (Oct 5, 2025): Added BioOS job management

## Support

- **npm Package**: https://www.npmjs.com/package/@genobank/biofs
- **GitHub**: https://github.com/Genobank/genobank-cli
- **Documentation**: See `BIOFS_V1.3.0_DIRECT_GRANT.md`
- **Support**: support@genobank.io

## Next Steps for Users

### Dra. Claudia (Researcher)

1. **Update to v1.3.0**:
   ```bash
   npm install -g @genobank/biofs@1.3.0
   biofs --version  # Should show: 1.3.0
   ```

2. **Authenticate**:
   ```bash
   biofs login  # Use wallet: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d
   ```

3. **Verify Access**:
   ```bash
   biofs files
   # Should now show: 55052008714000.deepvariant.vcf
   ```

4. **Download File**:
   ```bash
   biofs download 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 ./my-analysis/
   # File downloads successfully!
   ```

### IP Asset Owners

1. **Share Data Proactively**:
   ```bash
   # No longer need to wait for requests!
   biofs access grant <your_ip_id> <researcher_wallet>
   ```

2. **View All Grants**:
   ```bash
   biofs access list <your_ip_id>
   # Shows all granted wallets with grant type
   ```

3. **Revoke Access**:
   ```bash
   biofs access revoke <your_ip_id> <researcher_wallet> --yes
   # GDPR right to erasure
   ```

---

**Status**: ✅ Published, tested, and ready for production use
**Key Feature**: Direct Grant enables owner-initiated data sharing
**Impact**: Simplifies collaborative research workflows
**Compliance**: Fully GDPR compliant with right to erasure support
