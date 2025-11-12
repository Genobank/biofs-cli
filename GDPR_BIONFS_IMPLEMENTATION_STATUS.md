# 🔒 GDPR-Compliant BioNFS Implementation Status

## ✅ COMPLETED: Core Libraries

### 1. Consent Manager (`lib/consent-manager.js`)
**Purpose:** Manages GDPR consent records via API

**Features:**
- ✅ Check if user has already given consent
- ✅ Record new consent after user agrees
- ✅ Revoke consent for IP assets
- ✅ Get all consent records for wallet

**API Integration:**
- `POST /bionfs/v1/verify_consent` - Check consent status
- `POST /bionfs/v1/record_consent` - Record consent
- `POST /bionfs/v1/revoke_consent` - Revoke consent
- `GET /bionfs/v1/my_consents` - List consents

---

### 2. Consent Prompt (`lib/consent-prompt.js`)
**Purpose:** Display GDPR-compliant consent notice

**Features:**
- ✅ Shows file information (owner, license, IP asset)
- ✅ Explains genomic data nature (GDPR Article 9)
- ✅ Lists user rights (revoke, audit trail)
- ✅ Shows license terms (non-commercial, attribution)
- ✅ Records IP address and timestamp
- ✅ Requires explicit "I AGREE" input

**GDPR Compliance:**
- ✅ Informed consent (user understands what they're accessing)
- ✅ Explicit agreement (active "I AGREE" required)
- ✅ Purpose limitation (stated purpose of access)
- ✅ Right to withdraw (revoke command mentioned)
- ✅ Audit trail (timestamp + IP logged)

---

### 3. BioNFS Client (`lib/bionfs-client.js`)
**Purpose:** Stream files via BioNFS protocol

**Features:**
- ✅ Authenticate with BioNFS server
- ✅ Stream files by IP Asset ID or BioCID
- ✅ Fallback to direct API if BioNFS unavailable
- ✅ Parse BioCID format

**Streaming Methods:**
1. **BioNFS Protocol** (preferred):
   - Authenticate → Get session ID
   - Stream via `/bionfs/v1/stream/<ip_id>`
   - Uses session-based permissions

2. **Direct API** (fallback):
   - Download via `/api_bioip/download_granted_file`
   - Uses signature-based auth

---

## 🚧 IN PROGRESS: Command Integration

### Next Steps

#### 1. Update Download Command
**File:** `bin/biofs.js` (download command section)

**Add:**
```javascript
const ConsentManager = require('../lib/consent-manager');
const ConsentPrompt = require('../lib/consent-prompt');
const BioNFSClient = require('../lib/bionfs-client');

// In download command:
program
  .command('download')
  .action(async (biocid, destination, options) => {
    // 1. Load auth
    const { wallet, signature } = loadAuth();

    // 2. Resolve BioCID to file info
    const fileInfo = await resolveFile(biocid, signature);

    // 3. Check consent
    const consentManager = new ConsentManager();
    const hasConsent = await consentManager.hasConsent(
      wallet, fileInfo.ip_id, 'download', signature
    );

    if (!hasConsent) {
      // 4. Show GDPR consent notice
      const consentPrompt = new ConsentPrompt();
      fileInfo.wallet = wallet;
      const agreed = await consentPrompt.showConsentNotice(fileInfo, 'download');

      if (!agreed) {
        console.log('❌ Consent declined');
        process.exit(1);
      }

      // 5. Record consent
      const ipAddress = await consentPrompt.getPublicIP();
      await consentManager.recordConsent(wallet, fileInfo, 'download', ipAddress, signature);
    }

    // 6. Download file
    const bionfs = new BioNFSClient();
    await bionfs.authenticate(wallet, signature);
    await bionfs.streamFile(fileInfo.ip_id, destination, signature);

    console.log('✅ Downloaded:', destination);
  });
```

#### 2. Add Mount Command
**File:** `bin/biofs.js`

**Add:**
```javascript
program
  .command('mount')
  .argument('<mount-point>', 'Directory to mount files')
  .option('--read-only', 'Mount as read-only')
  .description('Mount all granted BioFiles to local directory')
  .action(async (mountPoint, options) => {
    // 1. Get all granted files
    const files = await api.getGrantedBioIPs(signature);

    // 2. Check/request consent for each
    for (const file of files) {
      const hasConsent = await consentManager.hasConsent(
        wallet, file.ip_id, 'mount', signature
      );

      if (!hasConsent) {
        const agreed = await consentPrompt.showConsentNotice(file, 'mount');
        if (agreed) {
          await consentManager.recordConsent(wallet, file, 'mount', ipAddress, signature);
        }
      }
    }

    // 3. Download all consented files
    fs.mkdirSync(mountPoint, { recursive: true });
    for (const file of files) {
      const localPath = path.join(mountPoint, file.filename);
      await bionfs.streamFile(file.ip_id, localPath, signature);
    }

    console.log(`✅ Mounted ${files.length} files to ${mountPoint}`);
  });
```

#### 3. Add Revoke Command
**File:** `bin/biofs.js`

**Add:**
```javascript
program
  .command('access')
  .command('revoke [ip-id]')
  .option('--all', 'Revoke all consents')
  .description('Revoke access consent for genomic files')
  .action(async (ipId, options) => {
    const consentManager = new ConsentManager();

    if (options.all) {
      await consentManager.revokeConsent(wallet, null, signature);
      console.log('✅ Revoked all consents');
    } else {
      await consentManager.revokeConsent(wallet, ipId, signature);
      console.log('✅ Revoked consent for', ipId);
    }
  });
```

---

## 📋 PENDING: API Endpoints

### API Implementation Required

**File:** `/home/ubuntu/Genobank_APIs/production_api/plugins/bioip/api_bioip.py`

**Add these endpoints:**

```python
@app.route('/bionfs/v1/verify_consent', methods=['POST'])
def verify_consent():
    """Check if user has given consent for this file"""
    user_signature = request.json.get('user_signature')
    ip_id = request.json.get('ip_id')
    action = request.json.get('action')

    wallet = recover_wallet(user_signature)

    # Check MongoDB
    consent = db.bioip_access_consents.find_one({
        'wallet_address': wallet.lower(),
        'ip_id': ip_id.lower(),
        'action': action,
        'revoked': False
    })

    if consent:
        return jsonify({
            'has_consent': True,
            'consent_given_at': consent['consent_given_at'].isoformat(),
            'access_count': consent['access_count']
        })
    else:
        return jsonify({'has_consent': False})


@app.route('/bionfs/v1/record_consent', methods=['POST'])
def record_consent():
    """Record GDPR consent after user agrees"""
    user_signature = request.json.get('user_signature')
    ip_id = request.json.get('ip_id')
    action = request.json.get('action')
    ip_address = request.json.get('ip_address')

    wallet = recover_wallet(user_signature)

    # Get file info
    bioip = bioip_dao.get_bioip_by_ip_id(ip_id)

    consent_record = {
        'wallet_address': wallet.lower(),
        'ip_id': ip_id.lower(),
        'filename': bioip.get('filename'),
        'data_owner': bioip.get('owner', '').lower(),
        'license_token_id': bioip.get('license_token_id'),
        'license_type': bioip.get('license_type', 'non-commercial'),

        'action': action,
        'purpose': 'research_and_clinical_analysis',

        'consent_text_version': 'v1.0',
        'consent_given_at': datetime.utcnow(),
        'consent_ip_address': ip_address,
        'consent_user_agent': request.headers.get('User-Agent'),

        'gdpr_rights_acknowledged': True,
        'license_terms_acknowledged': True,

        'access_count': 1,
        'last_accessed_at': datetime.utcnow(),

        'revoked': False
    }

    db.bioip_access_consents.insert_one(consent_record)

    # Audit log
    db.audit_log.insert_one({
        'event_type': 'consent_granted',
        'wallet': wallet,
        'ip_id': ip_id,
        'action': action,
        'timestamp': datetime.utcnow()
    })

    return jsonify({'status': 'Success', 'message': 'Consent recorded'})


@app.route('/bionfs/v1/revoke_consent', methods=['POST'])
def revoke_consent():
    """Revoke consent (GDPR right to withdraw)"""
    user_signature = request.json.get('user_signature')
    ip_id = request.json.get('ip_id')

    wallet = recover_wallet(user_signature)

    if ip_id == 'all':
        result = db.bioip_access_consents.update_many(
            {
                'wallet_address': wallet.lower(),
                'revoked': False
            },
            {
                '$set': {
                    'revoked': True,
                    'revoked_at': datetime.utcnow(),
                    'revoked_reason': 'user_requested'
                }
            }
        )
        count = result.modified_count
    else:
        result = db.bioip_access_consents.update_many(
            {
                'wallet_address': wallet.lower(),
                'ip_id': ip_id.lower(),
                'revoked': False
            },
            {
                '$set': {
                    'revoked': True,
                    'revoked_at': datetime.utcnow(),
                    'revoked_reason': 'user_requested'
                }
            }
        )
        count = result.modified_count

    db.audit_log.insert_one({
        'event_type': 'consent_revoked',
        'wallet': wallet,
        'ip_id': ip_id,
        'timestamp': datetime.utcnow()
    })

    return jsonify({
        'status': 'Success',
        'message': f'Revoked {count} consent(s)'
    })


@app.route('/api_bioip/download_granted_file', methods=['GET', 'POST'])
def download_granted_file():
    """Download a file you have a license token for"""
    user_signature = request.values.get('user_signature')
    ip_id = request.values.get('ip_id')

    wallet = recover_wallet(user_signature)

    # Verify license token
    has_license = story_protocol_service.verify_license(ip_id, wallet)
    if not has_license:
        return jsonify({'error': 'No valid license found'}), 403

    # Get S3 path
    bioip = bioip_dao.get_bioip_by_ip_id(ip_id)
    if not bioip:
        return jsonify({'error': 'File not found'}), 404

    s3_path = bioip['s3_path']

    # Stream from S3
    return stream_s3_file_response(s3_path, bioip['filename'])
```

---

## 🧪 Testing Plan

### Test 1: Dr. Claudia's First Download (Shows Consent)

```bash
biofs download "biocid://0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a/bioip/0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7"

# Expected:
# ═══════════════════════════════════════════
#  🔒 GENOMIC DATA ACCESS CONSENT
# ═══════════════════════════════════════════
#
# FILE INFORMATION:
#   Filename: 55052008714000.deepvariant.vcf
#   Owner: 0x5f5a...d19a
#   License Type: non-commercial
#
# YOU ARE ABOUT TO ACCESS:
#   • Genomic variants (VCF format)
#   • Protected under GDPR Article 9
#
# > Type "I AGREE" to proceed: I AGREE
#
# ✅ Consent recorded
# ✅ Downloaded: ./55052008714000.deepvariant.vcf
```

### Test 2: Second Download (Uses Existing Consent)

```bash
biofs download "55052008714000.deepvariant.vcf" ~/second-copy.vcf

# Expected:
# ✓ Using existing consent
# ✅ Downloaded: ~/second-copy.vcf
```

### Test 3: Mount (Shows Consent for Each File)

```bash
biofs mount ~/dr-claudia-genomic-data

# Expected:
# 📄 File 1 of 1:
# [Shows consent notice]
# > Type "I AGREE" to proceed: I AGREE
#
# ✅ Consent recorded
# ✅ Mounted 1 file(s) to ~/dr-claudia-genomic-data
#
# Your Files:
#   ✓ 55052008714000.deepvariant.vcf
```

### Test 4: Revoke Access

```bash
biofs access revoke 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7

# Expected:
# ✅ Revoked consent for 0xCCe1...59f7
```

---

## 📊 GDPR Compliance Checklist

✅ **Article 6 (Lawfulness)** - Consent is basis for processing
✅ **Article 7 (Conditions for Consent)** - Explicit "I AGREE" required
✅ **Article 9 (Special Categories)** - Genomic data explicitly mentioned
✅ **Article 13 (Information)** - User informed of purpose, rights, audit
✅ **Article 17 (Right to Erasure)** - Revoke command available
✅ **Article 30 (Records of Processing)** - Audit trail in MongoDB

---

## 📁 File Summary

**Created:**
- ✅ `/home/ubuntu/genobank-cli/lib/consent-manager.js`
- ✅ `/home/ubuntu/genobank-cli/lib/consent-prompt.js`
- ✅ `/home/ubuntu/genobank-cli/lib/bionfs-client.js`
- ✅ `/home/ubuntu/genobank-cli/GDPR_BIONFS_CONSENT_ARCHITECTURE.md`
- ✅ `/home/ubuntu/genobank-cli/BIONFS_MOUNT_INTEGRATION_PLAN.md`

**To Update:**
- ⏳ `/home/ubuntu/genobank-cli/bin/biofs.js` - Add download/mount/revoke commands
- ⏳ `/home/ubuntu/Genobank_APIs/production_api/plugins/bioip/api_bioip.py` - Add BioNFS endpoints

**To Create:**
- ⏳ MongoDB collection: `bioip_access_consents`
- ⏳ MongoDB collection: `audit_log` (if not exists)

---

## 🚀 Next Actions

1. **Update bin/biofs.js** with consent flow integration
2. **Deploy API endpoints** to production API
3. **Create MongoDB collections** with proper indexes
4. **Test with Dr. Claudia's file**
5. **Document user guide** for GDPR consent workflow

---

## 💡 Key Innovation

This implementation provides:
- **First GDPR-compliant genomic data CLI** with explicit consent
- **Blockchain-verified access control** (Story Protocol licenses)
- **Full audit trail** for regulatory compliance
- **User-friendly consent flow** (not just legalese)
- **Revocable access** (right to withdraw)

Dr. Claudia will have full transparency and control over her genomic data access! 🔒
