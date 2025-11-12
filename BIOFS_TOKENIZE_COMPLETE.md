# BioFS Tokenize Command - Complete Implementation

**Date:** October 4, 2025
**Status:** ✅ **FULLY OPERATIONAL**
**Version:** 1.0.0

## 🎉 Overview

The `biofs tokenize` command is now fully implemented and follows the exact workflow of bioip.genobank.app for tokenizing genomic datasets as BioIP NFTs on Story Protocol blockchain.

---

## ✅ What Was Built

### 1. Core Tokenization Command

**Command Signature:**
```bash
biofs tokenize <file> [options]
```

**Available Options:**
- `--title <string>` - Custom title for the NFT (auto-generated if not provided)
- `--description <string>` - Custom description (uses Gemini AI if not provided)
- `--license <type>` - License type: `commercial` or `non-commercial` (default: non-commercial)
- `--collection <address>` - Manual collection address override
- `--network <network>` - Story Protocol network: `mainnet` or `testnet` (default: mainnet)
- `--no-ai` - Skip AI classification
- `--quiet` - No interactive prompts

---

## 🌐 Story Protocol Network Support

### Mainnet (Production)
- **RPC:** `https://rpc.story.foundation`
- **Chain ID:** `1516`
- **Explorer:** `https://explorer.story.foundation`
- **Usage:** Default network for production tokenization

### Testnet (Odyssey)
- **RPC:** `https://testnet.storyrpc.io`
- **Chain ID:** `1513`
- **Explorer:** `https://testnet.storyscan.xyz`
- **Usage:** For testing before mainnet deployment

---

## 🔧 Complete Tokenization Workflow

### Step-by-Step Process:

```
1. FILE VALIDATION ✅
   └─> Checks file exists and is readable
   └─> Validates file extension (vcf, txt, fastq, bam, etc.)
   └─> Gets file size and basic metadata

2. AUTHENTICATION CHECK ✅
   └─> Loads credentials from ~/.genobank/credentials.json
   └─> Validates user_signature and wallet_address
   └─> Confirms user is authenticated

3. NETWORK SELECTION ✅
   └─> Selects Story Protocol network (mainnet/testnet)
   └─> Configures RPC and Chain ID
   └─> Sets appropriate explorer URL

4. FINGERPRINT CALCULATION ✅
   └─> For VCF files: Extracts SNPs (chr:pos:ref:alt)
   └─> For 23andMe/Ancestry: Extracts rsID:genotype pairs
   └─> Limits to first 10,000 SNPs for consistency
   └─> Generates MD5 hash of sorted SNP list
   └─> Used for duplicate detection

5. AI CLASSIFICATION (Optional) ✅
   └─> Sends file sample to Gemini AI
   └─> Gets intelligent description (2-3 sentences)
   └─> Auto-detects dataset category
   └─> Suggests title based on content
   └─> Can be skipped with --no-ai flag

6. COLLECTION SELECTION ✅
   └─> Auto-selects based on file category:
       • VCF → 0x19A615224D03487AaDdC43e4520F9D83923d9512
       • Genomic → 0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5
       • GWAS/SNP/23andMe → 0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401
       • BAM/SAM → 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269
       • FASTQ/FASTA → 0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171
   └─> Manual override available with --collection flag

7. LICENSE CONFIGURATION ✅
   └─> Story Protocol PIL (Programmable IP License)
   └─> Non-commercial: PIL_NON_COMMERCIAL_REMIX (default)
   └─> Commercial: PIL_COMMERCIAL_REMIX
   └─> Sets on-chain licensing terms

8. METADATA PREPARATION ✅
   └─> Title: From --title or AI suggestion or filename
   └─> Description: From --description or AI or auto-generated
   └─> NFT Traits:
       • File Type (VCF, FASTQ, etc.)
       • File Size (bytes)
       • SNP Count (for genomic files)
       • Fingerprint Hash
       • Created Date
       • Category
   └─> Image: Auto-selected category-appropriate image

9. API SUBMISSION ✅
   └─> Uploads to /api_bioip/register_bioip
   └─> Includes all metadata and file
   └─> Shows upload progress
   └─> Handles errors gracefully

10. NFT MINTING ✅
    └─> Server-side minting using BIOSAMPLE_EXECUTOR wallet
    └─> Mints on selected Story Protocol network
    └─> Registers as IP Asset
    └─> Attaches PIL license terms
    └─> Returns IP Asset ID and transaction hash

11. BIOCID GENERATION ✅
    └─> Format: biocid://<wallet>/<category>/<filename>
    └─> Example: biocid://0x5f5a.../variant/my-genome.vcf
    └─> Universal identifier for cross-platform access

12. RESULT DISPLAY ✅
    └─> Shows all tokenization details
    └─> Provides explorer link
    └─> Saves local record
    └─> Displays BioCID
```

---

## 📝 Usage Examples

### Basic Tokenization (Mainnet, Non-Commercial)
```bash
biofs tokenize my-genome.vcf
```
**Output:**
```
🧬 BioFS Tokenization
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ File validated: my-genome.vcf (2.5 MB)
✅ Authenticated: 0x5f5a60Ea...
✅ Network: Story Protocol Mainnet (Chain ID: 1516)
✅ Fingerprint: 3a4f7d2c... (10,000 SNPs)
✅ AI Classification: Variant Call Format
✅ Collection: VCF Analysis (0x19A6...9512)
✅ Upload complete
✅ NFT minted successfully!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉 BioIP Tokenization Successful!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 IP Asset ID: 0x4925ef6c5FbE63F9d5cF9FB20c074497FaB694C0
🔗 BioCID: biocid://0x5f5a.../variant/my-genome.vcf
🏛️ License: Non-Commercial Remix
📊 Collection: VCF Analysis

🌐 View on Explorer:
https://explorer.story.foundation/ipa/0x4925ef6c5FbE63F9d5cF9FB20c074497FaB694C0
```

### Testnet with Commercial License
```bash
biofs tokenize research-data.txt --network testnet --license commercial
```

### Custom Metadata (No AI)
```bash
biofs tokenize genome.vcf \
  --title "Clinical Whole Genome Sequencing" \
  --description "WGS for hereditary cancer research" \
  --no-ai
```

### Manual Collection Selection
```bash
biofs tokenize alignment.bam \
  --collection 0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269 \
  --network mainnet
```

### 23andMe/Ancestry File
```bash
biofs tokenize my_23andme_data.txt
```
**Auto-detects:** DTC category, uses GWAS collection

---

## 🗂️ File Type Support

| File Type | Extension | Category | Collection Address |
|-----------|-----------|----------|-------------------|
| VCF | `.vcf` | variant | `0x19A6...9512` |
| 23andMe/Ancestry | `.txt` | dtc | `0x2985...7401` |
| BAM | `.bam` | alignment | `0xB8d0...2269` |
| SAM | `.sam` | alignment | `0xB8d0...2269` |
| FASTQ | `.fastq`, `.fq` | sequence | `0x88Ed...9171` |
| FASTA | `.fasta`, `.fa` | sequence | `0x88Ed...9171` |
| GFF | `.gff` | annotation | `0x88Ed...9171` |
| GTF | `.gtf` | annotation | `0x88Ed...9171` |
| BED | `.bed` | annotation | `0x88Ed...9171` |
| DICOM | `.dicom`, `.dcm` | medical_imaging | `0x5021...74B5` |

---

## 🧬 Fingerprint Algorithm

### VCF Files
```typescript
1. Read VCF file line by line
2. Skip header lines (starting with #)
3. For each variant:
   - Extract: chromosome, position, ref, alt
   - Create SNP ID: "chr1:100:A:G"
4. Collect up to 10,000 SNPs
5. Sort SNPs alphabetically
6. Join with commas: "chr1:100:A:G,chr1:200:C:T,..."
7. Calculate MD5 hash
8. Use for duplicate detection
```

### 23andMe/Ancestry Files
```typescript
1. Read file line by line
2. Skip comment lines (starting with #)
3. For each SNP:
   - Extract: rsID, genotype
   - Create pair: "rs12345:AG"
4. Collect up to 10,000 SNPs
5. Sort alphabetically
6. Join with commas
7. Calculate MD5 hash
```

### Other Files
```typescript
1. Read entire file content
2. Calculate MD5 hash of content
3. Use for file integrity verification
```

---

## 🤖 AI Classification

### Gemini AI Integration

**API:** Google Generative AI (Gemini Pro)
**Key:** `AIzaSyCuPPjSPkHTbu2YBoyZjUB-o-xCnhCNaac`

**What AI Does:**
1. Analyzes first 100 lines of file
2. Identifies file type and format
3. Generates 2-3 sentence description
4. Suggests appropriate title
5. Determines best category

**Example Output:**
```json
{
  "description": "Whole genome sequencing variant calls from Illumina platform, containing approximately 4.5 million variants across all chromosomes. High-quality calls filtered for clinical significance.",
  "category": "variant",
  "suggestedTitle": "Clinical WGS Variant Analysis"
}
```

**Can be disabled** with `--no-ai` flag for faster processing or custom metadata.

---

## 📜 Story Protocol PIL Licensing

### License Types Supported

#### Non-Commercial (Default)
- **PIL Term:** `PIL_NON_COMMERCIAL_REMIX`
- **Allows:**
  - Non-commercial use
  - Derivative works
  - Attribution required
- **Forbids:**
  - Commercial use
  - Selling derivatives
- **Usage:** `--license non-commercial` (or omit flag)

#### Commercial
- **PIL Term:** `PIL_COMMERCIAL_REMIX`
- **Allows:**
  - Commercial use
  - Derivative works
  - Revenue from derivatives
  - Attribution required
- **Usage:** `--license commercial`

### On-Chain Enforcement
- License terms stored on Story Protocol blockchain
- Immutable and transparent
- Automatically inherited by derivatives
- Royalty tracking built-in

---

## 🔐 Security & Privacy

### Authentication
- Uses existing `~/.genobank/credentials.json`
- No re-authentication needed
- Web3 signature verified by API
- Wallet ownership confirmed

### Private Key Handling
- **BIOSAMPLE_EXECUTOR** private key NEVER exposed to CLI
- All blockchain transactions signed server-side
- CLI only sends data, API handles minting
- Zero-trust architecture

### Data Storage
- **Public (Blockchain):** IP Asset ID, collection, license type
- **Public (IPFS):** NFT metadata, description, traits, image
- **Private (MongoDB):** S3 path, wallet address, fingerprint
- **Never Public:** Genomic file content, S3 paths, user data

### Fingerprint Privacy
- Fingerprint is MD5 hash of SNP list
- Does not expose raw genomic data
- Sufficient for duplicate detection
- Cannot reverse-engineer genome from hash

---

## 📊 Collection Addresses

### Story Protocol Mainnet Collections

```javascript
const BIOIP_COLLECTIONS = {
  'genomic':         '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5',
  'variant':         '0x19A615224D03487AaDdC43e4520F9D83923d9512',
  'alignment':       '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269',
  'sequence':        '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'annotation':      '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'microarray':      '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'snp':             '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'gwas':            '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'dtc':             '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'medical_imaging': '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5',
  'medical':         '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5'
};
```

**Note:** Testnet uses same addresses but on different chain (1513).

---

## 🌍 BioCID Format

### Structure
```
biocid://<wallet_address>/<category>/<filename>
```

### Examples
```
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/variant/my-genome.vcf
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/dtc/23andme_data.txt
biocid://0x5f5a60eaef242c0d51a21c703f520347b96ed19a/sequence/sample_R1.fastq
```

### Usage
- Universal identifier across GenoBank ecosystem
- Used in `biofs download` command
- Resolves to S3/IPFS/Story Protocol
- Platform-independent file reference

---

## 📁 Implementation Files

### Core Command
- `/home/ubuntu/genobank-cli/src/commands/tokenize.ts` - Main command logic
- `/home/ubuntu/genobank-cli/src/index.ts` - Command registration

### Supporting Libraries
- `/home/ubuntu/genobank-cli/src/lib/biofiles/fingerprint.ts` - Fingerprint calculation
- `/home/ubuntu/genobank-cli/src/lib/ai/classifier.ts` - Gemini AI integration
- `/home/ubuntu/genobank-cli/src/lib/bioip/collections.ts` - Collection mapping
- `/home/ubuntu/genobank-cli/src/lib/bioip/licenses.ts` - License type mapping
- `/home/ubuntu/genobank-cli/src/lib/config/constants.ts` - Network configuration
- `/home/ubuntu/genobank-cli/src/lib/storage/tokenizations.ts` - Local record storage

### Configuration
- `/home/ubuntu/genobank-cli/.env` - Environment variables
- `/home/ubuntu/genobank-cli/package.json` - Dependencies

### Dependencies Added
```json
{
  "@google/generative-ai": "^0.24.1"  // Gemini AI SDK
}
```

---

## 🧪 Testing

### Test Files

**Create test VCF:**
```bash
cat > test.vcf << 'EOF'
##fileformat=VCFv4.2
#CHROM	POS	ID	REF	ALT	QUAL	FILTER	INFO
chr1	100	rs123	A	G	30	PASS	DP=10
chr1	200	rs456	C	T	40	PASS	DP=15
chr2	300	rs789	G	A	50	PASS	DP=20
EOF
```

**Create test 23andMe:**
```bash
cat > test_23andme.txt << 'EOF'
# rsid	chromosome	position	genotype
rs12345	1	100	AG
rs67890	2	200	CC
rs11111	3	300	TT
EOF
```

### Test Commands

```bash
# Test mainnet tokenization
biofs tokenize test.vcf

# Test testnet
biofs tokenize test.vcf --network testnet

# Test with AI disabled
biofs tokenize test_23andme.txt --no-ai

# Test commercial license
biofs tokenize test.vcf --license commercial

# Test full options
biofs tokenize test.vcf \
  --title "Test VCF" \
  --description "Test variant file" \
  --license non-commercial \
  --network mainnet
```

---

## ✅ Success Criteria - All Met!

- ✅ Command runs without errors
- ✅ File fingerprint calculated correctly for VCF and 23andMe
- ✅ AI classification provides intelligent descriptions
- ✅ Correct collection auto-selected based on file type
- ✅ Network selection works (mainnet/testnet)
- ✅ NFT minted successfully on Story Protocol
- ✅ BioCID generated and displayed
- ✅ Transaction details shown with explorer links
- ✅ Local tokenization records saved
- ✅ Beautiful, informative terminal output
- ✅ Error handling graceful and helpful
- ✅ Secure BIOSAMPLE_EXECUTOR handling
- ✅ PIL licensing properly configured

---

## 🚀 What's Next?

### Potential Enhancements

1. **Batch Tokenization**
   ```bash
   biofs tokenize --batch *.vcf
   ```

2. **Royalty Configuration**
   ```bash
   biofs tokenize file.vcf --royalty 5%
   ```

3. **Derivative Creation**
   ```bash
   biofs tokenize analysis.csv --parent 0x1234...
   ```

4. **License Token Minting**
   ```bash
   biofs mint-license 0x1234... --amount 10
   ```

5. **Collection Management**
   ```bash
   biofs create-collection "My Research" MYRES
   ```

---

## 📚 Related Documentation

- **BioFS CLI Guide:** `/home/ubuntu/genobank-cli/README.md`
- **Quick Start:** `/home/ubuntu/genobank-cli/BIOFS_QUICK_START.md`
- **Architecture:** `/home/ubuntu/Genobank_APIs/GENOBANK_CLI_ARCHITECTURE.md`
- **BioIP API:** `/home/ubuntu/Genobank_APIs/production_api/plugins/bioip/api_bioip.py`
- **Story Protocol DAO:** `/home/ubuntu/Genobank_APIs/production_api/libs/dao/story/story_protocol_manager_dao.py`

---

## 🎉 Conclusion

The `biofs tokenize` command is **fully operational** and production-ready! It provides a seamless command-line interface for tokenizing genomic datasets as BioIP NFTs on Story Protocol, with:

- ✅ AI-powered metadata generation
- ✅ Intelligent fingerprinting for duplicate detection
- ✅ Automatic collection and license selection
- ✅ Multi-network support (mainnet/testnet)
- ✅ Beautiful terminal UX
- ✅ Secure server-side blockchain operations
- ✅ Complete integration with GenoBank ecosystem

**Users can now tokenize their genomic data with a single command!** 🚀

---

**Version:** 1.0.0
**Last Updated:** October 4, 2025
**Status:** ✅ Production Ready
**Maintained By:** GenoBank.io Team
