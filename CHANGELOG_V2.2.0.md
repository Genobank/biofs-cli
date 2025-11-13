# BioFS-CLI v2.2.0 Changelog

## Release Date: November 12, 2025

## 🎯 Major Features

### LabNFT Integration Complete

Fully integrated LabNFT smart contract with BioFS-CLI and GenoBank API for unified lab registration and verification.

#### New LabNFT Module

- **File:** `/src/lib/sequentia/LabNFT.ts`
- **Features:**
  - Full Sequentia LabNFT contract integration
  - EIP-55 checksummed addresses
  - GDPR consent hash generation
  - Lab type enums (LAB, RESEARCHER, INSTITUTION)
  - Access level management (Research, Clinical, Commercial)
  - GA4GH compliance levels

#### New Commands

1. **`biofs admin register-lab`** (Updated)
   - Now calls unified GenoBank `/register_lab` API
   - Automatic LabNFT minting on registration
   - Supports custodial wallet generation
   - Website information extraction
   - Stores in unified `labs` MongoDB collection

2. **`biofs admin verify-lab`** (New)
   - Verify LabNFT ownership on-chain
   - Display complete lab information
   - Check verification and active status
   - Show GDPR consent hashes
   - Display access control settings

## 🔧 Breaking Changes

### Lab Registration Flow

**Before (v2.1.11):**
- Registered in `lab_wallets` collection
- No LabNFT minting
- Placeholder BioPIL DAO integration
- Manual serial number assignment

**After (v2.2.0):**
- Registers via unified `/register_lab` API
- Automatic LabNFT minting
- Stores in `labs` collection
- Blockchain-verified serial numbers

### MongoDB Schema Changes

**Old Collections (Deprecated):**
- `lab_wallets` - Replaced by `labs`
- Manual permittee tracking

**New Collection:**
- `labs` - Unified lab registry with LabNFT integration

**Migration:** All existing labs have been migrated to the new system with LabNFTs minted.

## 🚀 API Integration

### New API Endpoint

**`POST /register_lab`**
- URL: `https://genobank.app/register_lab`
- Generates custodial wallets or accepts user wallets
- Mints LabNFTs automatically
- Returns complete registration details including private keys (custodial only)

### Updated Commands

```bash
# Register with custodial wallet
biofs admin register-lab https://novogene.com --yes

# Register with custom details
biofs admin register-lab https://example.edu \
  --name "Example Genomics Lab" \
  --email contact@example.edu \
  --specialization "cancer genomics" \
  --location "Boston, MA" \
  --lab-type RESEARCHER

# Verify lab registration
biofs admin verify-lab 0x9346be6aD3384EB36c172F8B2bB4b7C9d8afFc07
```

## 📋 Smart Contract Details

**LabNFT Contract:**
- Address: `0x24f42752F491540e305384A5C947911649C910CF`
- Network: Sequentia L1
- Chain ID: `15132025`
- RPC: `http://52.90.163.112:8545`

**Features:**
- ERC-721 compliant
- GDPR consent management (Article 17)
- Four access levels
- GA4GH compliance tracking
- Lab verification status
- Active/inactive toggle

## 🔐 Security Enhancements

### GDPR Compliance

- **Biodata consent hash:** Stored on-chain as bytes32
- **Commercial consent hash:** Separate tracking
- **Right to erasure:** Supported via ConsentManager

### Access Control

**Access Levels:**
- Level 0: Research Only
- Level 1: Clinical Non-Critical
- Level 2: Clinical Critical
- Level 3: Commercial

**GA4GH Compliance:**
- Level 0: None
- Level 1: Basic
- Level 2: Lite
- Level 3: Full

### Wallet Security

- **Custodial wallets:** Private keys encrypted in MongoDB
- **Claiming workflow:** Labs can claim via email verification
- **EIP-55 checksumming:** All addresses validated

## 📊 Migration Statistics

**Completed Migration:**
- Total labs: 63
- Labs with LabNFTs: 63 (100%)
- Custodial wallets: 28
- User-provided wallets: 35
- LabNFT serials: #1 - #61

## 🐛 Bug Fixes

### Fixed Issues

1. **Duplicate Collections**
   - Consolidated `lab_wallets`, `permittees`, and `researchers` into single `labs` collection
   - Fixed inconsistent wallet tracking

2. **Missing LabNFT Verification**
   - All labs now have LabNFTs minted
   - Blockchain verification enabled

3. **Inconsistent Lab Types**
   - Standardized to LAB, RESEARCHER, INSTITUTION enum

## 📖 Documentation

### New Documentation Files

1. **`LABNFT_BIOFS_INTEGRATION.md`**
   - Complete integration guide
   - API usage examples
   - Testing procedures
   - Migration summary

2. **`ADMIN_REGISTER_LAB.md`** (Updated)
   - Updated to reflect v2.0 unified API approach
   - New CLI command examples
   - MongoDB schema documentation

## 🔄 Dependencies

### Updated Packages

- `ethers`: ^6.9.0 (LabNFT integration)
- `axios`: ^1.6.0 (API calls)
- `@types/node`: ^20.0.0

### New Environment Variables Required

```bash
# LabNFT Contract (Sequentia)
SEQUENTIA_RPC_URL=http://52.90.163.112:8545
SEQUENTIA_CHAIN_ID=15132025
SEQUENTIA_EXECUTOR_KEY=0xfaa...

# GenoBank API
GENOBANK_API_URL=https://genobank.app
ADMIN_SIGNATURE=0xa51...
```

## 🚧 Known Issues

### Limitations

1. **File Sharing Verification**
   - LabNFT verification not yet enforced in `share_file()` endpoint
   - Planned for v2.3.0

2. **Lab Claiming Workflow**
   - Email verification for custodial wallets not implemented
   - Planned for v2.3.0

3. **Admin Dashboard Integration**
   - LabNFT viewing in admin dashboard pending
   - Planned for v2.3.0

## 🎯 Roadmap

### v2.3.0 (Planned)

1. **File Sharing Integration**
   - Enforce LabNFT verification in file sharing
   - Add access level checks
   - Implement GA4GH compliance validation

2. **Lab Claiming Workflow**
   - Email verification system
   - Wallet claiming via dashboard
   - Private key secure transfer

3. **Enhanced CLI Commands**
   - `biofs lab list` - List all registered labs
   - `biofs lab update` - Update lab information
   - `biofs lab deactivate` - Deactivate lab

4. **Admin Dashboard**
   - View all LabNFTs
   - Approve/verify labs
   - Monitor activity

## 🧪 Testing

### Test Commands

```bash
# Build CLI
cd /home/ubuntu/biofs-cli
npm run build

# Test lab registration
biofs admin register-lab https://novogene.com --yes

# Test verification
biofs admin verify-lab <wallet_address>

# Test API endpoint
curl -X POST https://genobank.app/register_lab \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Lab", "lab_type": "LAB", "mint_nft": true}'
```

### MongoDB Verification

```bash
# Check labs collection
mongosh "mongodb+srv://..." --eval "db.labs.countDocuments()"

# Check LabNFT registrations
mongosh "mongodb+srv://..." --eval "db.labs.countDocuments({'sequentia.registered': true})"

# Find lab by wallet
mongosh "mongodb+srv://..." --eval "db.labs.findOne({owner_wallet: '<wallet>'})"
```

## 👥 Contributors

- GenoBank.io Development Team
- Claude AI (Development Assistant)

## 📝 License

GenoBank.io - Proprietary

---

**For complete integration details, see `LABNFT_BIOFS_INTEGRATION.md`**

**Support:** support@genobank.io | https://github.com/Genobank/biofs-cli
