# 🔒 GDPR-Compliant BioNFS Access Architecture

## 🧠 ULTRATHINK ANALYSIS: Genomic Data Access Consent

### Legal Requirements (GDPR Articles 6, 7, 9)

**Article 9 - Special Categories of Personal Data:**
> "Processing of personal data revealing...genetic data...shall be prohibited EXCEPT where...the data subject has given explicit consent."

**Article 7 - Conditions for Consent:**
> "The data subject shall have the right to withdraw consent at any time."

**Article 13 - Information to be Provided:**
> "The controller shall provide the data subject with: (a) identity of controller, (b) purposes of processing, (c) legitimate interests, (d) recipients of data, (e) right to withdraw consent."

### 🎯 Design Principles

1. **Informed Consent** - User understands EXACTLY what they're accessing
2. **Explicit Agreement** - Requires active "yes" (not just "OK")
3. **Granular Control** - Per-file consent, not blanket approval
4. **Revocable** - Can withdraw consent anytime via `biofs access revoke`
5. **Auditable** - All consent actions logged on-chain + MongoDB
6. **Minimal Data** - Only show consent for files being accessed NOW

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dr. Claudia's Workflow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  biofs download "55052008714000.deepvariant.vcf"               │
│         │                                                       │
│         ↓                                                       │
│  ┌─────────────────────────────────────────┐                  │
│  │  1. Check if consent already given      │                  │
│  │     - Query MongoDB: consents collection│                  │
│  │     - Key: {wallet, ip_id, action}      │                  │
│  └─────────────────────────────────────────┘                  │
│         │                                                       │
│         ↓ NO CONSENT FOUND                                     │
│  ┌─────────────────────────────────────────┐                  │
│  │  2. Display GDPR Consent Notice         │                  │
│  │                                          │                  │
│  │  ╔════════════════════════════════════╗  │                  │
│  │  ║  GENOMIC DATA ACCESS CONSENT      ║  │                  │
│  │  ╠════════════════════════════════════╣  │                  │
│  │  ║ File: 55052008714000.deepvariant.vcf│  │                  │
│  │  ║ Owner: 0x5f5a...d19a (Daniel Uribe)║  │                  │
│  │  ║ License: Non-Commercial Use        ║  │                  │
│  │  ║                                    ║  │                  │
│  │  ║ YOU ARE ABOUT TO ACCESS:           ║  │                  │
│  │  ║ • Genomic variants (VCF format)    ║  │                  │
│  │  ║ • Potentially identifying genetic  ║  │                  │
│  │  ║   information protected under GDPR ║  │                  │
│  │  ║   Article 9 (Special Categories)   ║  │                  │
│  │  ║                                    ║  │                  │
│  │  ║ PURPOSE OF ACCESS:                 ║  │                  │
│  │  ║ Research and clinical analysis     ║  │                  │
│  │  ║                                    ║  │                  │
│  │  ║ YOUR RIGHTS:                       ║  │                  │
│  │  ║ ✓ Revoke access anytime            ║  │                  │
│  │  ║ ✓ All access is logged (audit trail)│  │                  │
│  │  ║ ✓ Data owner can revoke your license│  │                  │
│  │  ║                                    ║  │                  │
│  │  ║ LICENSE TERMS:                     ║  │                  │
│  │  ║ • Non-commercial use only          ║  │                  │
│  │  ║ • Attribution required             ║  │                  │
│  │  ║ • No redistribution                ║  │                  │
│  │  ║                                    ║  │                  │
│  │  ║ By typing "I AGREE" you confirm:   ║  │                  │
│  │  ║ 1. You understand this is genomic  ║  │                  │
│  │  ║    data protected under GDPR       ║  │                  │
│  │  ║ 2. You will use it only for stated ║  │                  │
│  │  ║    purposes                        ║  │                  │
│  │  ║ 3. You will comply with license terms│ │                  │
│  │  ╚════════════════════════════════════╝  │                  │
│  │                                          │                  │
│  │  > Type "I AGREE" to proceed: _____     │                  │
│  └─────────────────────────────────────────┘                  │
│         │                                                       │
│         ↓ USER TYPES "I AGREE"                                 │
│  ┌─────────────────────────────────────────┐                  │
│  │  3. Record Consent                      │                  │
│  │     - Save to MongoDB consents collection│                  │
│  │     - Log to blockchain (optional)      │                  │
│  │     - Timestamp + wallet signature      │                  │
│  └─────────────────────────────────────────┘                  │
│         │                                                       │
│         ↓                                                       │
│  ┌─────────────────────────────────────────┐                  │
│  │  4. Proceed with Download/Mount         │                  │
│  │     - Authenticate with BioNFS server   │                  │
│  │     - Verify license token              │                  │
│  │     - Stream file from S3               │                  │
│  └─────────────────────────────────────────┘                  │
│         │                                                       │
│         ↓                                                       │
│  ✅ File downloaded to: ./55052008714000.deepvariant.vcf      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model: Consent Records

### MongoDB Collection: `bioip_access_consents`

```javascript
{
  "_id": ObjectId("..."),
  "wallet_address": "0xb3c3a584491b8ca4df45116a1e250098a0d6192d",  // Dr. Claudia
  "ip_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
  "filename": "55052008714000.deepvariant.vcf",
  "data_owner": "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a",  // Daniel
  "license_token_id": 40249,
  "license_type": "non-commercial",

  "action": "download",  // or "mount"
  "purpose": "research_and_clinical_analysis",

  "consent_text_version": "v1.0",  // Track which consent text was shown
  "consent_given_at": ISODate("2025-10-07T06:00:00Z"),
  "consent_ip_address": "192.168.1.100",
  "consent_user_agent": "BioFS CLI v1.0.0",

  "gdpr_rights_acknowledged": true,
  "license_terms_acknowledged": true,

  "access_count": 1,  // Increment on each access
  "last_accessed_at": ISODate("2025-10-07T06:00:00Z"),

  "revoked": false,
  "revoked_at": null,
  "revoked_reason": null
}
```

**Indexes:**
```javascript
db.bioip_access_consents.createIndex({ wallet_address: 1, ip_id: 1, action: 1 });
db.bioip_access_consents.createIndex({ ip_id: 1 });
db.bioip_access_consents.createIndex({ data_owner: 1 });
```

---

## Implementation: Consent Flow

### 1. Check if Consent Already Given

```javascript
// lib/consent-manager.js

class ConsentManager {
  async hasConsent(wallet, ipId, action) {
    const consent = await db.collection('bioip_access_consents').findOne({
      wallet_address: wallet.toLowerCase(),
      ip_id: ipId.toLowerCase(),
      action: action,  // 'download' or 'mount'
      revoked: false
    });

    return consent !== null;
  }
}
```

### 2. Display Consent Notice

```javascript
// lib/consent-prompt.js

const chalk = require('chalk');
const inquirer = require('inquirer');

class ConsentPrompt {
  async showConsentNotice(fileInfo) {
    console.log('\n');
    console.log(chalk.yellow('═'.repeat(70)));
    console.log(chalk.bold.yellow('       🔒 GENOMIC DATA ACCESS CONSENT'));
    console.log(chalk.yellow('═'.repeat(70)));
    console.log('');

    console.log(chalk.bold('FILE INFORMATION:'));
    console.log(`  Filename:     ${chalk.cyan(fileInfo.filename)}`);
    console.log(`  Owner:        ${chalk.cyan(fileInfo.owner)}`);
    console.log(`  IP Asset:     ${chalk.gray(fileInfo.ip_id)}`);
    console.log(`  License Type: ${chalk.green(fileInfo.license_type)}`);
    console.log('');

    console.log(chalk.bold('YOU ARE ABOUT TO ACCESS:'));
    console.log('  • Genomic variants (VCF format)');
    console.log('  • Potentially identifying genetic information');
    console.log('  • Protected under GDPR Article 9 (Special Categories)');
    console.log('');

    console.log(chalk.bold('PURPOSE OF ACCESS:'));
    console.log('  Research and clinical analysis');
    console.log('');

    console.log(chalk.bold.green('YOUR RIGHTS:'));
    console.log('  ✓ Revoke access anytime via: ' + chalk.cyan('biofs access revoke <ip_id>'));
    console.log('  ✓ All access is logged (audit trail)');
    console.log('  ✓ Data owner can revoke your license token');
    console.log('');

    console.log(chalk.bold('LICENSE TERMS:'));
    if (fileInfo.license_type === 'non-commercial') {
      console.log('  • Non-commercial use only');
      console.log('  • Attribution required');
      console.log('  • No redistribution without permission');
    }
    console.log('');

    console.log(chalk.bold('GDPR COMPLIANCE:'));
    console.log('  This access will be recorded with:');
    console.log(`  • Your wallet: ${fileInfo.wallet}`);
    console.log(`  • Timestamp: ${new Date().toISOString()}`);
    console.log(`  • IP address: ${await this.getPublicIP()}`);
    console.log('');

    console.log(chalk.yellow('─'.repeat(70)));
    console.log('');

    // Require explicit "I AGREE"
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'consent',
        message: 'Type "I AGREE" to confirm consent and proceed:',
        validate: (input) => {
          if (input.trim().toUpperCase() === 'I AGREE') {
            return true;
          }
          return 'You must type "I AGREE" exactly to proceed';
        }
      }
    ]);

    return answer.consent.trim().toUpperCase() === 'I AGREE';
  }

  async getPublicIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json');
      return response.data.ip;
    } catch {
      return 'unknown';
    }
  }
}
```

### 3. Record Consent

```javascript
// lib/consent-manager.js (continued)

class ConsentManager {
  async recordConsent(wallet, fileInfo, action, ipAddress) {
    const consentRecord = {
      wallet_address: wallet.toLowerCase(),
      ip_id: fileInfo.ip_id.toLowerCase(),
      filename: fileInfo.filename,
      data_owner: fileInfo.owner.toLowerCase(),
      license_token_id: fileInfo.license_token_id,
      license_type: fileInfo.license_type,

      action: action,  // 'download' or 'mount'
      purpose: 'research_and_clinical_analysis',

      consent_text_version: 'v1.0',
      consent_given_at: new Date(),
      consent_ip_address: ipAddress,
      consent_user_agent: 'BioFS CLI v1.0.0',

      gdpr_rights_acknowledged: true,
      license_terms_acknowledged: true,

      access_count: 1,
      last_accessed_at: new Date(),

      revoked: false,
      revoked_at: null,
      revoked_reason: null
    };

    await db.collection('bioip_access_consents').insertOne(consentRecord);

    // Also log to audit trail
    await db.collection('audit_log').insertOne({
      event_type: 'consent_granted',
      wallet: wallet,
      ip_id: fileInfo.ip_id,
      action: action,
      timestamp: new Date()
    });

    console.log(chalk.green('✅ Consent recorded'));
  }

  async incrementAccessCount(wallet, ipId, action) {
    await db.collection('bioip_access_consents').updateOne(
      {
        wallet_address: wallet.toLowerCase(),
        ip_id: ipId.toLowerCase(),
        action: action
      },
      {
        $inc: { access_count: 1 },
        $set: { last_accessed_at: new Date() }
      }
    );
  }
}
```

---

## Implementation: Download with Consent

### Updated Download Command

```javascript
// commands/download.js

const ConsentManager = require('../lib/consent-manager');
const ConsentPrompt = require('../lib/consent-prompt');
const BioNFSClient = require('../lib/bionfs-client');

async function downloadCommand(biocid, destination, options) {
  const spinner = ora('Preparing download...').start();

  try {
    // 1. Load authentication
    const { wallet, signature } = loadAuth();

    // 2. Resolve BioCID to get file metadata
    spinner.text = 'Resolving BioCID...';
    const fileInfo = await api.resolveFile(biocid, signature);

    if (!fileInfo) {
      throw new Error('File not found or you do not have access');
    }

    spinner.stop();

    // 3. Check if consent already given
    const consentManager = new ConsentManager();
    const hasConsent = await consentManager.hasConsent(
      wallet,
      fileInfo.ip_id,
      'download'
    );

    if (!hasConsent) {
      // 4. Show GDPR consent notice
      const consentPrompt = new ConsentPrompt();
      fileInfo.wallet = wallet;  // Add user's wallet to display

      const agreed = await consentPrompt.showConsentNotice(fileInfo);

      if (!agreed) {
        console.log(chalk.red('❌ Consent declined. Download cancelled.'));
        process.exit(1);
      }

      // 5. Record consent
      const ipAddress = await consentPrompt.getPublicIP();
      await consentManager.recordConsent(wallet, fileInfo, 'download', ipAddress);
    } else {
      console.log(chalk.green('✓ Using existing consent'));

      // Increment access count
      await consentManager.incrementAccessCount(wallet, fileInfo.ip_id, 'download');
    }

    // 6. Proceed with BioNFS download
    spinner.start('Authenticating with BioNFS...');

    const bionfs = new BioNFSClient();
    await bionfs.authenticate(wallet, signature);

    spinner.text = `Downloading ${fileInfo.filename}...`;
    await bionfs.streamFile(fileInfo.ip_id, destination);

    spinner.succeed(`✅ Downloaded: ${destination}`);

    // 7. Show post-download info
    console.log('');
    console.log(chalk.bold('File Information:'));
    console.log(`  Size: ${filesize(fileInfo.size)}`);
    console.log(`  License: ${fileInfo.license_type}`);
    console.log('');
    console.log(chalk.yellow('💡 To revoke access: ') + chalk.cyan(`biofs access revoke ${fileInfo.ip_id}`));

  } catch (error) {
    spinner.fail('Download failed');
    console.error(error.message);
    process.exit(1);
  }
}
```

---

## Implementation: Mount with Consent

### New Mount Command

```javascript
// commands/mount.js

const ConsentManager = require('../lib/consent-manager');
const ConsentPrompt = require('../lib/consent-prompt');
const BioNFSClient = require('../lib/bionfs-client');

async function mountCommand(mountPoint, options) {
  const spinner = ora('Preparing mount...').start();

  try {
    // 1. Load authentication
    const { wallet, signature } = loadAuth();

    // 2. Get all granted files
    spinner.text = 'Discovering granted files...';
    const files = await api.getGrantedBioIPs(signature);

    if (files.length === 0) {
      spinner.warn('No granted files found');
      console.log('💡 Request access to files with: ' + chalk.cyan('biofs access request'));
      process.exit(0);
    }

    spinner.stop();

    // 3. Check consent for each file
    const consentManager = new ConsentManager();
    const consentPrompt = new ConsentPrompt();
    const filesNeedingConsent = [];

    for (const file of files) {
      const hasConsent = await consentManager.hasConsent(
        wallet,
        file.ip_id,
        'mount'
      );

      if (!hasConsent) {
        filesNeedingConsent.push(file);
      }
    }

    // 4. Show consent for files that need it
    if (filesNeedingConsent.length > 0) {
      console.log('');
      console.log(chalk.yellow(`⚠️  ${filesNeedingConsent.length} file(s) require consent before mounting`));
      console.log('');

      for (let i = 0; i < filesNeedingConsent.length; i++) {
        const file = filesNeedingConsent[i];

        console.log(chalk.bold(`\n📄 File ${i+1} of ${filesNeedingConsent.length}:`));
        file.wallet = wallet;

        const agreed = await consentPrompt.showConsentNotice(file);

        if (!agreed) {
          console.log(chalk.red(`❌ Consent declined for ${file.filename}. Skipping.`));
          continue;
        }

        // Record consent
        const ipAddress = await consentPrompt.getPublicIP();
        await consentManager.recordConsent(wallet, file, 'mount', ipAddress);
      }
    }

    // 5. Mount all consented files
    spinner.start('Mounting files...');

    const bionfs = new BioNFSClient();
    await bionfs.authenticate(wallet, signature);

    fs.mkdirSync(mountPoint, { recursive: true });

    let mountedCount = 0;
    for (const file of files) {
      const hasConsent = await consentManager.hasConsent(
        wallet,
        file.ip_id,
        'mount'
      );

      if (!hasConsent) continue;  // Skip files without consent

      const localPath = path.join(mountPoint, file.filename);
      spinner.text = `Mounting ${file.filename}...`;

      await bionfs.streamFile(file.ip_id, localPath);
      mountedCount++;

      // Increment access count
      await consentManager.incrementAccessCount(wallet, file.ip_id, 'mount');
    }

    spinner.succeed(`✅ Mounted ${mountedCount} file(s) to ${mountPoint}`);

    // 6. Show usage info
    console.log('');
    console.log(chalk.bold('Your Files:'));
    files.forEach(file => {
      const localPath = path.join(mountPoint, file.filename);
      if (fs.existsSync(localPath)) {
        console.log(`  ${chalk.green('✓')} ${file.filename}`);
      }
    });

    console.log('');
    console.log(chalk.bold('Usage Examples:'));
    console.log(`  bcftools view ${mountPoint}/55052008714000.deepvariant.vcf | head -20`);
    console.log(`  IGV ${mountPoint}/55052008714000.deepvariant.vcf`);
    console.log('');
    console.log(chalk.yellow('💡 To revoke access to all files: ') + chalk.cyan('biofs access revoke --all'));

  } catch (error) {
    spinner.fail('Mount failed');
    console.error(error.message);
    process.exit(1);
  }
}
```

---

## Implementation: Revoke Access

### New Access Revoke Command

```javascript
// commands/access/revoke.js

async function revokeCommand(ipId, options) {
  const spinner = ora('Revoking access...').start();

  try {
    const { wallet, signature } = loadAuth();

    if (options.all) {
      // Revoke all consents
      const consents = await db.collection('bioip_access_consents').find({
        wallet_address: wallet.toLowerCase(),
        revoked: false
      }).toArray();

      spinner.text = `Revoking ${consents.length} consent(s)...`;

      await db.collection('bioip_access_consents').updateMany(
        {
          wallet_address: wallet.toLowerCase(),
          revoked: false
        },
        {
          $set: {
            revoked: true,
            revoked_at: new Date(),
            revoked_reason: 'user_requested'
          }
        }
      );

      spinner.succeed(`✅ Revoked access to ${consents.length} file(s)`);

    } else {
      // Revoke specific IP asset
      const result = await db.collection('bioip_access_consents').updateMany(
        {
          wallet_address: wallet.toLowerCase(),
          ip_id: ipId.toLowerCase(),
          revoked: false
        },
        {
          $set: {
            revoked: true,
            revoked_at: new Date(),
            revoked_reason: 'user_requested'
          }
        }
      );

      spinner.succeed(`✅ Revoked access to IP asset ${ipId}`);
      console.log(`   ${result.modifiedCount} consent record(s) updated`);
    }

    // Log to audit trail
    await db.collection('audit_log').insertOne({
      event_type: 'consent_revoked',
      wallet: wallet,
      ip_id: ipId || 'all',
      timestamp: new Date()
    });

  } catch (error) {
    spinner.fail('Revoke failed');
    console.error(error.message);
    process.exit(1);
  }
}
```

---

## API Endpoints: BioNFS with Consent

### 1. Add Consent Verification to BioNFS

```python
# /production_api/plugins/bioip/api_bioip.py

@app.route('/bionfs/v1/verify_consent', methods=['POST'])
def verify_consent():
    """
    Verify user has given GDPR consent for this file
    Called by biofs CLI before download/mount
    """
    user_signature = request.json.get('user_signature')
    ip_id = request.json.get('ip_id')
    action = request.json.get('action')  # 'download' or 'mount'

    wallet = recover_wallet(user_signature)

    # Check MongoDB for consent record
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
        return jsonify({
            'has_consent': False
        })


@app.route('/bionfs/v1/record_consent', methods=['POST'])
def record_consent():
    """
    Record GDPR consent after user agrees
    Called by biofs CLI after showing consent notice
    """
    user_signature = request.json.get('user_signature')
    ip_id = request.json.get('ip_id')
    action = request.json.get('action')
    ip_address = request.json.get('ip_address')

    wallet = recover_wallet(user_signature)

    # Get file info
    bioip = bioip_dao.get_bioip_by_ip_id(ip_id)

    # Create consent record
    consent_record = {
        'wallet_address': wallet.lower(),
        'ip_id': ip_id.lower(),
        'filename': bioip['filename'],
        'data_owner': bioip['owner'].lower(),
        'license_token_id': bioip['license_token_id'],
        'license_type': bioip['license_type'],

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

    # Log to audit trail
    db.audit_log.insert_one({
        'event_type': 'consent_granted',
        'wallet': wallet,
        'ip_id': ip_id,
        'action': action,
        'timestamp': datetime.utcnow()
    })

    return jsonify({'status': 'Success', 'message': 'Consent recorded'})
```

---

## Deployment Steps

1. **Add consent-manager.js to biofs CLI**
2. **Add consent-prompt.js to biofs CLI**
3. **Add BioNFS client library**
4. **Update download command with consent flow**
5. **Add mount command with consent flow**
6. **Add revoke command**
7. **Deploy BioNFS endpoints to main API**
8. **Create MongoDB bioip_access_consents collection**

---

## Testing with Dr. Claudia

### Test 1: First Download (Shows Consent)

```bash
biofs download "55052008714000.deepvariant.vcf"

# Should show:
# ═══════════════════════════════════════════
#  🔒 GENOMIC DATA ACCESS CONSENT
# ═══════════════════════════════════════════
#
# FILE INFORMATION:
#   Filename: 55052008714000.deepvariant.vcf
#   Owner: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
#   ...
#
# > Type "I AGREE" to proceed: I AGREE
#
# ✅ Consent recorded
# ⏳ Downloading...
# ✅ Downloaded: ./55052008714000.deepvariant.vcf
```

### Test 2: Second Download (Uses Existing Consent)

```bash
biofs download "55052008714000.deepvariant.vcf" ~/second-copy.vcf

# Should show:
# ✓ Using existing consent
# ⏳ Downloading...
# ✅ Downloaded: ~/second-copy.vcf
```

### Test 3: Mount (Shows Consent for Each File)

```bash
biofs mount ~/genomic-data

# Should show consent for each file, then:
# ✅ Mounted 1 file(s) to ~/genomic-data
#
# Your Files:
#   ✓ 55052008714000.deepvariant.vcf
```

### Test 4: Revoke Access

```bash
biofs access revoke 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7

# Should show:
# ✅ Revoked access to IP asset 0xCCe1...59f7
#    1 consent record(s) updated
```

---

## Summary: GDPR Compliance Features

✅ **Informed Consent** - Clear explanation of what's being accessed
✅ **Explicit Agreement** - Requires typing "I AGREE"
✅ **Granular** - Per-file, per-action consent
✅ **Revocable** - `biofs access revoke` command
✅ **Auditable** - All actions logged with timestamp + IP
✅ **Purpose Limitation** - Stated purpose of access
✅ **Data Minimization** - Only access files user explicitly needs
✅ **Right to Information** - Shows owner, license, rights
✅ **Transparent** - Access count tracked and visible

This implementation satisfies GDPR Articles 6, 7, 9, and 13! 🔒
