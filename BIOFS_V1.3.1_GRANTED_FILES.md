# BioFS v1.3.1 - Granted Files Feature

## ✅ Successfully Published to npm

**Package**: `@genobank/biofs@1.3.1`
**Published**: October 7, 2025
**npm URL**: https://www.npmjs.com/package/@genobank/biofs

## What's New in v1.3.1

### 1. ✅ Granted Files Discovery

**`biofs files` now shows files you've been granted access to via license tokens, not just files you own!**

Previously, `biofs files` only showed:
- Files you uploaded
- Files you own

Now it also shows:
- Files other users have granted you access to (marked with 🔑)

### 2. ✅ Fixed ESM Warning from inquirer

Downgraded `inquirer` from v9.2.0 (ESM-only) to v8.2.6 (CommonJS) to eliminate experimental warnings.

## Installation

### Update to v1.3.1

```bash
# Uninstall old version
npm uninstall -g @genobank/biofs

# Install v1.3.1
npm install -g @genobank/biofs@1.3.1

# Verify version
biofs --version  # Should show: 1.3.1
```

## Testing the Granted Files Feature

### For Dra. Claudia (Researcher)

You've been granted access to a VCF file from the server! Here's how to see and use it:

#### Step 1: Update to v1.3.1
```bash
npm install -g @genobank/biofs@1.3.1
biofs --version  # Should show: 1.3.1
```

#### Step 2: Authenticate
```bash
biofs login
# Use your wallet: 0xb3c3a584491b8ca4df45116a1e250098a0d6192d
```

#### Step 3: List Files (with verbose mode)
```bash
biofs files --verbose
```

**Expected Output:**
```
🔍 Fetching S3 files...
✅ Found 0 S3 files
🔍 Fetching Story Protocol IP assets...
✅ Found 0 IP assets
🔍 Fetching BioIP files...
✅ Found 0 BioIP files
🔍 Fetching granted BioIP files...
✅ Found 1 granted BioIP files  ← NEW! Files granted to you
🔍 Fetching VCF files...
✅ Found 0 VCF files

📊 Total files discovered: 1

📁 Your BioFiles (1 file)

VCF Files (1):
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   BioCID: biocid://0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/...     │
│   Filename: 55052008714000.deepvariant.vcf 🔑  ← 🔑 indicates granted      │
│   Type: VCF                                                                  │
│   Source:  IPFS                                                              │
│   Owner: 0x5f5a...Ed19a                                                      │
│   License: non-commercial                                                    │
│   IP Asset: 0xCCe1...59f7                                                    │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

#### Step 4: Download the Granted File
```bash
# Download by IP Asset ID
biofs download 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 ./my-analysis/

# Or download by filename
biofs download "55052008714000.deepvariant.vcf" ./my-analysis/
```

**Expected Output:**
```
✓ File downloaded successfully to ./my-analysis/55052008714000.deepvariant.vcf
```

#### Step 5: Verify Access Control
```bash
# Check your access status
biofs access list --mine
```

**Expected Output:**
```
✓ Assets with license tokens: 1

┌─────────────────────────────────────────────┬─────────────────────┬────────────────────┬────────┐
│ IP Asset ID                                 │ Owner               │ License Type       │ Status │
├─────────────────────────────────────────────┼─────────────────────┼────────────────────┼────────┤
│ 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7  │ 0x5f5a...Ed19a      │ GDPR Research      │ Active │
└─────────────────────────────────────────────┴─────────────────────┴────────────────────┴────────┘
```

## What's Happening Behind the Scenes

### New Backend Endpoint

**GET** `/api_bioip/get_my_granted_bioips?user_signature={sig}`

Returns all BioIP assets where the user has been granted license tokens:

```json
{
  "status": "Success",
  "status_details": {
    "granted_bioips": [
      {
        "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
        "filename": "55052008714000.deepvariant.vcf",
        "file_category": "vcf",
        "s3_path": "users/0x5f5a.../bioip/.../55052008714000.deepvariant.vcf",
        "ipfs_hash": "QmNyGTuhS7TkJojvZ2N1RVgqt9rGG7hpWSMWc8SbiDhnow",
        "owner": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",
        "license_token_id": 40249,
        "license_type": "non-commercial",
        "granted_at": "2025-10-07T01:16:14Z",
        "grant_type": "direct"
      }
    ],
    "count": 1
  }
}
```

### File Discovery Flow

The `biofs files` command now fetches from **5 sources**:

1. **S3 files** (owned by user)
2. **Story Protocol IP assets** (owned by user)
3. **BioIP files** (owned by user)
4. **Granted BioIP files** (license tokens) ← **NEW!**
5. **VCF files** (owned by user)

### Granted File Indicators

Files granted via license tokens are marked with:
- **🔑 emoji** in filename
- **`granted: true`** in metadata
- **`owner`** field shows who granted access
- **`license_type`** shows the license terms

## Use Cases

### 1. Collaborative Research
Researcher receives direct grant from PI:
```bash
# PI grants access
biofs access grant 0xMyDataset 0xResearcher

# Researcher sees file immediately
biofs files
# Shows: my-dataset.vcf 🔑
```

### 2. Data Sharing
Data owner shares with multiple researchers:
```bash
# Owner grants to 3 researchers
biofs access grant 0xDataset 0xResearcher1
biofs access grant 0xDataset 0xResearcher2
biofs access grant 0xDataset 0xResearcher3

# All 3 can now see and download
biofs files  # Each sees: dataset.vcf 🔑
```

### 3. Teaching & Workshops
Instructor shares teaching data with students:
```bash
# Instructor grants to all students
for wallet in $(cat students.txt); do
  biofs access grant 0xTeachingData $wallet
done

# Students see teaching data
biofs files
# Shows: teaching-dataset.vcf 🔑
```

## Technical Details

### New CLI Methods

**`src/lib/api/client.ts`**:
```typescript
async getMyGrantedBioIPs(): Promise<any[]> {
  try {
    const signature = await this.getSignature();
    const response = await this.axios.get('/api_bioip/get_my_granted_bioips', {
      params: { user_signature: signature }
    });
    return response.data.status_details?.granted_bioips || [];
  } catch (error) {
    return [];
  }
}
```

**`src/lib/biofiles/resolver.ts`**:
```typescript
// Get BioIP files (granted access via license tokens)
if (verbose) console.log('🔍 Fetching granted BioIP files...');
const grantedBioips = await this.api.getMyGrantedBioIPs();
if (verbose) console.log(`✅ Found ${grantedBioips.length} granted BioIP files`);

for (const bioip of grantedBioips) {
  if (bioip.s3_path || bioip.ipfs_hash) {
    bioFiles.push({
      filename: (bioip.filename || 'Granted BioIP') + ' 🔑',
      biocid: `biocid://${bioip.owner}/bioip/${bioip.ip_id}`,
      type: bioip.file_category || 'bioip',
      source: bioip.ipfs_hash ? 'IPFS' : 'S3',
      created_at: bioip.granted_at,
      s3_path: bioip.s3_path,
      ipfs_hash: bioip.ipfs_hash,
      ip_asset: bioip.ip_id,
      granted: true,
      owner: bioip.owner,
      license_type: bioip.license_type
    });
  }
}
```

### Updated Type Definitions

**`src/types/biofiles.ts`**:
```typescript
export interface BioFile {
  filename: string;
  biocid: string;
  type: string;
  size?: number;
  source: 'S3' | 'IPFS' | 'Story';
  created_at?: string;
  ip_asset?: string;
  s3_path?: string;
  ipfs_hash?: string;
  presigned_url?: string;
  granted?: boolean;       // NEW: True if access granted via license token
  owner?: string;          // NEW: Owner wallet (for granted files)
  license_type?: string;   // NEW: License type (for granted files)
}
```

## Fixes in v1.3.1

### 1. ESM Warning Fixed ✅
- Downgraded `inquirer`: ^9.2.0 → ^8.2.6 (CommonJS)
- No more experimental warnings!

### 2. Granted Files Query Fixed ✅
- Case-insensitive wallet matching
- Supports old tokens without `status` field
- Uses regex query: `$regex: "^{wallet}$", $options: "i"`

### 3. License Token Storage Fixed ✅
- Direct MongoDB insert preserves all fields
- Includes: `status`, `grant_type`, `license_type`, `created_at`
- Old service method was dropping fields

## Testing Checklist for Dra. Claudia

- [ ] Update to v1.3.1: `npm install -g @genobank/biofs@1.3.1`
- [ ] Verify version: `biofs --version` shows 1.3.1
- [ ] No ESM warnings when running commands
- [ ] Login with your wallet: `biofs login`
- [ ] List files with verbose: `biofs files --verbose`
- [ ] See granted file with 🔑: `55052008714000.deepvariant.vcf 🔑`
- [ ] Download granted file: `biofs download 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7 ./test/`
- [ ] Check access: `biofs access list --mine`

## Known Issues & Solutions

### Issue: "No granted files" but token exists
**Solution**: The backend query is case-insensitive and supports old tokens without `status` field. The fix is deployed.

### Issue: ESM warning from inquirer
**Solution**: Fixed in v1.3.1 by downgrading to inquirer v8.2.6.

### Issue: Can't download granted file
**Solution**: Make sure you're authenticated with the correct wallet that received the grant.

## Support

- **npm Package**: https://www.npmjs.com/package/@genobank/biofs
- **GitHub**: https://github.com/Genobank/genobank-cli
- **Support**: support@genobank.io

---

**Version**: 1.3.1
**Status**: ✅ Published and ready for testing
**Key Feature**: Granted Files Discovery - See files others have shared with you
**Fixes**: ESM warnings eliminated, license token storage fixed
