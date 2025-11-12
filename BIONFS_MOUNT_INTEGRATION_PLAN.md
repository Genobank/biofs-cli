# BioNFS Mount Integration for biofs CLI

## Current Status: Dr. Claudia's Granted Files

### ✅ What's Working

Dr. Claudia (wallet `0xb3c3a584491b8ca4df45116a1e250098a0d6192d`) has:

**2 License Tokens for VCF File:**
```json
{
  "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
  "filename": "55052008714000.deepvariant.vcf",
  "s3_path": "users/0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/3931d9ff-54df-43c5-bd9b-10a273a8d37e/55052008714000.deepvariant.vcf",
  "license_token_id": 40205,  // First license
  "license_type": "non-commercial"
}
{
  "license_token_id": 40249   // Second license
}
```

**BioCID:**
```
biocid://0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
```

---

## 🎯 Goal: Enable Dr. Claudia to Mount VCF via BioNFS

### What We Need to Build

**1. `biofs mount` Command**
```bash
# Mount all granted files to local directory
biofs mount ~/genomic-data

# Mount specific BioCID
biofs mount biocid://0x5f5a...d19a/bioip/0xCCe...59f7 ~/my-vcf

# Mount with read-only flag
biofs mount --read-only ~/genomic-data
```

**2. BioNFS Client Integration**
- Authenticate with BioNFS server using Web3 signature
- Stream files using BioNFS protocol (HTTP/2 or gRPC)
- Create local FUSE mount point

**3. BioNFS Server Deployment**
- Deploy on main API server (genobank.app) - has internet for Story Protocol queries
- Or add BioNFS endpoints to existing API

---

## Architecture Options

### Option 1: FUSE Mount (Full Linux Compatibility)

**Pros:**
- ✅ Works with any Linux app (IGV, bcftools, samtools)
- ✅ Transparent to applications
- ✅ Standard file system semantics

**Cons:**
- ❌ Requires FUSE library
- ❌ Complex to implement
- ❌ macOS/Windows require different approaches

**Implementation:**
```javascript
// Using fusejs or node-fuse-bindings
const fuse = require('fusejs');

fuse.mount('./mount-point', {
  readdir: async (path) => {
    // List files from BioNFS API
    const files = await bionfs.listFiles(session_id);
    return files.map(f => f.filename);
  },

  getattr: async (path) => {
    // Get file metadata
    const file = await bionfs.getMetadata(session_id, path);
    return {
      size: file.size,
      mode: 0o444,  // Read-only
      mtime: new Date(file.created_at)
    };
  },

  open: async (path) => {
    // Verify permissions when opening file
    const permitted = await bionfs.checkPermission(session_id, path);
    if (!permitted) throw new Error('Permission denied');
    return 0;  // File descriptor
  },

  read: async (path, fd, buffer, length, position) => {
    // Stream chunk from BioNFS
    const chunk = await bionfs.streamChunk(session_id, path, position, length);
    chunk.copy(buffer);
    return chunk.length;
  }
});
```

---

### Option 2: Smart Download with Caching (Simpler)

**Pros:**
- ✅ No FUSE required
- ✅ Works on all platforms
- ✅ Easy to implement
- ✅ Can cache frequently used files

**Cons:**
- ❌ Not a "real" mount (downloads to temp directory)
- ❌ Uses disk space

**Implementation:**
```javascript
// biofs mount ~/genomic-data
// Actually downloads files to ~/genomic-data with symlinks

async function mountCommand(mountPoint) {
  // 1. Create mount directory
  fs.mkdirSync(mountPoint, { recursive: true });

  // 2. Get all granted files
  const files = await api.getGrantedBioIPs(userSignature);

  // 3. For each file, create download job
  for (const file of files) {
    const localPath = path.join(mountPoint, file.filename);

    // Download in background
    await streamFile(file.biocid, localPath);

    console.log(`✅ Mounted: ${file.filename}`);
  }

  console.log(`\n📁 Files available at: ${mountPoint}`);
}
```

---

### Option 3: Hybrid Approach (Recommended)

**Combine both:**
- Use download/caching for initial access
- Add FUSE support later for advanced users

**Phase 1: Download-based mount (Week 1)**
```bash
biofs mount ~/genomic-data
# Downloads all granted files to ~/genomic-data
# Creates .bionfs-cache directory for metadata
```

**Phase 2: FUSE support (Week 2)**
```bash
biofs mount --fuse ~/genomic-data
# Real mount point with on-demand streaming
# No upfront downloads
```

---

## Implementation Plan

### Step 1: Add BioNFS Client to biofs CLI

**File:** `/home/ubuntu/genobank-cli/lib/bionfs-client.js`

```javascript
const axios = require('axios');
const crypto = require('crypto');

class BioNFSClient {
  constructor(serverUrl = 'https://genobank.app/bionfs/v1') {
    this.serverUrl = serverUrl;
    this.sessionId = null;
  }

  /**
   * Authenticate with BioNFS server using Web3 signature
   */
  async authenticate(wallet, signature) {
    const response = await axios.post(`${this.serverUrl}/auth`, {
      wallet: wallet,
      signature: signature,
      message: 'I want to access BioNFS'
    });

    this.sessionId = response.data.session_id;
    this.permissions = response.data.permissions;

    return this.sessionId;
  }

  /**
   * Stream file by BioCID
   */
  async streamFile(biocid, outputPath) {
    // Parse BioCID to extract IP asset ID
    const ipAssetId = this.parseBioCID(biocid);

    // Stream from BioNFS server
    const response = await axios.get(
      `${this.serverUrl}/stream/${ipAssetId}`,
      {
        headers: { 'X-Session-ID': this.sessionId },
        responseType: 'stream'
      }
    );

    // Save to disk
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  /**
   * Parse BioCID format:
   * biocid://OWNER/bioip/IP_ASSET_ID
   */
  parseBioCID(biocid) {
    const match = biocid.match(/biocid:\/\/0x[a-fA-F0-9]{40}\/bioip\/(0x[a-fA-F0-9]{40})/);
    if (!match) throw new Error('Invalid BioCID format');
    return match[1];  // IP Asset ID
  }
}

module.exports = BioNFSClient;
```

---

### Step 2: Add `mount` Command to biofs CLI

**File:** `/home/ubuntu/genobank-cli/commands/mount.js`

```javascript
const BioNFSClient = require('../lib/bionfs-client');
const fs = require('fs');
const path = require('path');

async function mountCommand(mountPoint, options) {
  const spinner = ora('Mounting BioFiles...').start();

  try {
    // 1. Load authentication
    const { wallet, signature } = loadAuth();

    // 2. Create mount directory
    fs.mkdirSync(mountPoint, { recursive: true });

    // 3. Authenticate with BioNFS
    const bionfs = new BioNFSClient();
    await bionfs.authenticate(wallet, signature);
    spinner.text = 'Authenticated with BioNFS server';

    // 4. Get all granted files
    const files = await api.getGrantedBioIPs(signature);
    spinner.text = `Found ${files.length} granted files`;

    // 5. Mount each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const localPath = path.join(mountPoint, file.filename);

      spinner.text = `Mounting ${file.filename} (${i+1}/${files.length})`;

      // Stream from BioNFS
      await bionfs.streamFile(file.biocid, localPath);
    }

    spinner.succeed(`✅ Mounted ${files.length} files to ${mountPoint}`);

    // 6. Create .bionfs-cache for metadata
    const cacheDir = path.join(mountPoint, '.bionfs-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'manifest.json'),
      JSON.stringify({ files, mounted_at: new Date() }, null, 2)
    );

    console.log(`\n📁 Your files are ready at: ${mountPoint}`);
    console.log(`\n💡 Use with any tool:`);
    console.log(`   bcftools view ${mountPoint}/55052008714000.deepvariant.vcf`);
    console.log(`   IGV ${mountPoint}/55052008714000.deepvariant.vcf`);

  } catch (error) {
    spinner.fail('Mount failed');
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = mountCommand;
```

---

### Step 3: Add BioNFS Endpoints to Main API

**Option A: Add to existing `/production_api/run/runweb.py`**

```python
# Add BioNFS endpoints to main API
from libs.service.bionfs_service import BioNFSService

bionfs_service = BioNFSService()

@app.route('/bionfs/v1/auth', methods=['POST'])
def bionfs_authenticate():
    """
    Authenticate user with Web3 signature
    Returns session_id for subsequent requests
    """
    wallet = request.json.get('wallet')
    signature = request.json.get('signature')

    # Verify signature
    recovered = recover_wallet(signature)
    if recovered.lower() != wallet.lower():
        return jsonify({'error': 'Invalid signature'}), 401

    # Get permissions from Story Protocol + MongoDB
    session_id = bionfs_service.create_session(wallet, signature)

    return jsonify({
        'session_id': session_id,
        'wallet': wallet,
        'expires_at': (datetime.utcnow() + timedelta(hours=24)).isoformat()
    })


@app.route('/bionfs/v1/stream/<ip_asset_id>', methods=['GET'])
def bionfs_stream_file(ip_asset_id):
    """
    Stream file by IP Asset ID
    Requires X-Session-ID header
    """
    session_id = request.headers.get('X-Session-ID')

    # Verify session and permissions
    permitted = bionfs_service.check_permission(session_id, ip_asset_id)
    if not permitted:
        return jsonify({'error': 'Permission denied'}), 403

    # Get S3 path from IP metadata
    s3_path = bionfs_service.get_s3_path(ip_asset_id)

    # Stream from S3
    return stream_s3_file(s3_path)
```

---

## Quick Test for Dr. Claudia

### Test 1: Verify Download Works

```bash
# Try downloading the granted VCF
biofs download biocid://0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7

# Should download 55052008714000.deepvariant.vcf
```

### Test 2: Once Mount is Implemented

```bash
# Mount all granted files
biofs mount ~/dr-claudia-genomic-data

# Use with standard tools
bcftools view ~/dr-claudia-genomic-data/55052008714000.deepvariant.vcf | head -20
```

---

## Next Steps

1. **Verify current download works** - Test Dr. Claudia's permissions
2. **Add BioNFS client library** - Implement authentication + streaming
3. **Add mount command** - Phase 1 (download-based)
4. **Deploy BioNFS endpoints** - Add to main API server
5. **Test with Dr. Claudia** - End-to-end verification

---

## Timeline

- **Today**: Verify download works, add BioNFS client
- **Tomorrow**: Implement mount command, deploy endpoints
- **Day 3**: Test with Dr. Claudia's files

---

## Success Criteria

✅ Dr. Claudia runs: `biofs mount ~/genomic-data`
✅ File appears: `~/genomic-data/55052008714000.deepvariant.vcf`
✅ Can analyze with: `bcftools stats ~/genomic-data/55052008714000.deepvariant.vcf`
✅ Permission verified via Story Protocol license token #40205
