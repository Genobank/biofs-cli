# 🔐 Where BioIP License Permissions Live

## TL;DR: Hybrid Storage (Blockchain + Database)

Your **2 granted BioIP permissions** for Dra. Claudia exist in **BOTH** locations:

### 1. ✅ **On Story Protocol Blockchain** (Immutable, Verifiable)
- **License Token #40205**: https://aeneid.storyscan.io/tx/0x23c86b4741a8e0db765ae2a064c9781071e677a5820a272c98afa5d641255be4
- **License Token #40249**: https://aeneid.storyscan.io/tx/0x90c59317ec4756a7d668cd52d63a7d4e850ef1e5193b2393c39d678292c7ff97

### 2. ✅ **In MongoDB Database** (Fast Query, Rich Metadata)
- **Collection**: `license_tokens`
- **Database**: `genobank-api` (MongoDB Atlas)
- **Records**: 2 documents for `receiver: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d`

---

## 📋 License Token #1 (Request-Based)

### On-Chain (Story Protocol Testnet)
```
License Token ID: 40205
Transaction Hash: 0x23c86b4741a8e0db765ae2a064c9781071e677a5820a272c98afa5d641255be4
IP Asset: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
Receiver: 0xB3C3a584491B8ca4DF45116A1e250098a0D6192D (Dra. Claudia)
Sender: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a (CEO)
License Terms ID: 1 (Non-Commercial)
```

### In MongoDB
```json
{
  "license_token_id": 40205,
  "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
  "receiver": "0xB3C3a584491B8ca4DF45116A1e250098a0D6192D",
  "sender": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
  "license_type": "non-commercial",
  "grant_type": "request-based",
  "status": "active",
  "tx_hash": "23c86b4741a8e0db765ae2a064c9781071e677a5820a272c98afa5d641255be4",
  "created_at": "2025-10-05T05:34:00Z"
}
```

**Flow**: Dra. Claudia **requested** access → CEO **approved** → License minted on-chain

---

## 📋 License Token #2 (Direct Grant)

### On-Chain (Story Protocol Testnet)
```
License Token ID: 40249
Transaction Hash: 0x90c59317ec4756a7d668cd52d63a7d4e850ef1e5193b2393c39d678292c7ff97
IP Asset: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
Receiver: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d (Dra. Claudia)
Sender: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a (CEO)
License Terms ID: 1 (Non-Commercial)
```

### In MongoDB
```json
{
  "license_token_id": 40249,
  "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
  "receiver": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",
  "sender": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
  "license_type": "non-commercial",
  "grant_type": "direct",
  "status": "active",
  "tx_hash": "90c59317ec4756a7d668cd52d63a7d4e850ef1e5193b2393c39d678292c7ff97",
  "created_at": "2025-10-07T01:16:14Z"
}
```

**Flow**: CEO **directly granted** access → License minted on-chain (no request needed)

---

## 🏗️ Architecture: Why Hybrid Storage?

### Blockchain (Story Protocol) = Source of Truth
- ✅ **Immutable**: Cannot be deleted or modified
- ✅ **Verifiable**: Anyone can verify on StoryScan
- ✅ **Decentralized**: No single point of failure
- ✅ **GDPR Consent**: License token = proof of permission

### MongoDB = Performance Layer
- ✅ **Fast Queries**: Instant lookup by wallet/IP/status
- ✅ **Rich Metadata**: grant_type, license_type, timestamps
- ✅ **Filtering**: Find all active/revoked/expired tokens
- ✅ **Analytics**: Track usage patterns

---

## 🔍 How BioFS CLI Discovers Granted Files

```typescript
// 1. Query MongoDB for active license tokens
const tokens = await db.license_tokens.find({
  receiver: userWallet,
  status: "active"
});

// 2. For each token, fetch BioIP details from registry
for (const token of tokens) {
  const bioip = await db.bioip_registry.findOne({
    ip_id: token.ip_id
  });

  // 3. User can now download from BioNFT-Gated S3
  const presignedUrl = await s3.getSignedUrl({
    bucket: "test.vault.genoverse.io",
    key: bioip.s3_path
  });
}
```

---

## 📂 File Storage vs Permission Storage

### ❌ VCF File is NOT on IPFS!
```
S3 Path: users/0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/3931d9ff.../55052008714000.deepvariant.vcf
Location: BioNFT-Gated S3 (test.vault.genoverse.io)
Access: Requires license token (blockchain proof)
GDPR: Supports "right to erasure" (can delete from S3)
```

### ✅ Only NFT Metadata on IPFS
```
IPFS Hash: QmNyGTuhS7TkJojvZ2N1RVgqt9rGG7hpWSMWc8SbiDhnow
Content: {"name": "DeepVariant Analysis", "description": "...", "image": "..."}
Purpose: NFT card display (thumbnail, title, description)
```

---

## 🎯 Summary

**Your 2 granted permissions live in:**

1. **Story Protocol Blockchain** (Chain ID 1514 - Testnet)
   - Token #40205: Request-based grant (Oct 5, 2025)
   - Token #40249: Direct grant (Oct 7, 2025)
   - Both minted with non-commercial PIL terms
   - Both currently active (not revoked)

2. **MongoDB Atlas** (`genobank-api` database)
   - Collection: `license_tokens`
   - Indexed by: receiver, ip_id, status
   - Used for fast permission checks

3. **BioFS CLI** queries MongoDB → verifies on blockchain → grants S3 access

**The VCF file itself?** Safely stored in BioNFT-Gated S3, NOT on IPFS! 🧬

---

## 🔗 Verification Links

- **IP Asset**: https://aeneid.storyscan.io/ipa/0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
- **Token #40205 TX**: https://aeneid.storyscan.io/tx/0x23c86b4741a8e0db765ae2a064c9781071e677a5820a272c98afa5d641255be4
- **Token #40249 TX**: https://aeneid.storyscan.io/tx/0x90c59317ec4756a7d668cd52d63a7d4e850ef1e5193b2393c39d678292c7ff97
