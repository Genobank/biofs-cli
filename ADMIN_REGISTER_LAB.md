# BioFS Admin Register Lab Command

## Overview

The `biofs admin register-lab` command onboards new research labs to the GenoBank platform on **Sequentia Network** with minimal input.

## Features

- **Website-based extraction**: Automatically extracts lab information from website
- **Custodial wallet generation**: Creates secure EIP-55 wallet for lab
- **MongoDB integration**: Stores lab profile with all metadata
- **Sequentia Network registration**: Registers as BioPIL DAO permittee
- **Blockchain logging**: Records registration transaction on-chain

## Network Configuration

✅ **Sequentia Mainnet**:
- RPC URL: `http://52.90.163.112:8545`
- Chain ID: `15132025`
- BioPIL DAO: `0xDae899b64282370001E3f820304213eDf2D983DE`

❌ **Deprecated Networks**:
- Avalanche Fuji (deprecated)
- Story Protocol (use Sequentia instead)

## Usage

### Basic Usage (Minimal Input)

```bash
biofs admin register-lab https://novogene.com --yes
```

This command will:
1. Extract lab information from the website
2. Generate a custodial wallet
3. Store in MongoDB
4. Register on Sequentia blockchain
5. Display lab credentials

### Advanced Usage (With Overrides)

```bash
biofs admin register-lab https://ciphersoniclabs.com \
  --name "CipherSonic Labs" \
  --email rashmi@ciphersoniclabs.com \
  --specialization "genomic analysis" \
  --location "San Francisco, CA" \
  --auto-approve
```

### Command Options

```
Arguments:
  <website_url>              Lab's website URL (required)

Options:
  --name <string>            Override extracted lab name
  --email <string>           Contact email (extracted if not provided)
  --specialization <string>  Research focus (extracted if not provided)
  --location <string>        Lab location (extracted if not provided)
  --auto-approve             Mark lab as verified immediately
  --yes                      Skip confirmation prompts
  -h, --help                 Display help
```

## Example Output

```
🧬 BioFS Lab Registration - Sequentia Network

✓ Website analysis complete
✓ Custodial wallet generated: 0x9346be6aD3384EB36c172F8B2bB4b7C9d8afFc07
✓ Assigned serial: 43
✓ Lab profile stored in MongoDB
✓ Sequentia registration complete

✅ Lab registered successfully on Sequentia Network!

Lab Details:
  🏥 Lab: Novogene
  🔗 Website: https://novogene.com
  👛 Custodial Wallet: 0x9346be6aD3384EB36c172F8B2bB4b7C9d8afFc07
  🔑 Private Key: (stored securely in MongoDB)
  📧 Email: contact@novogene.com
  🧬 Specialization: Genomic sequencing and bioinformatics
  📍 Location: United States
  ⛓️  Sequentia TX: 0xabc123...
  🌐 Network: Sequentia (Chain ID: 15132025)
  📋 Status: Verified ✅
  🆔 Serial: 43

💡 Next Steps:
  Lab can now receive BioNFT-licensed data:
  $ biofs share <file> --lab 0x9346be6aD3384EB36c172F8B2bB4b7C9d8afFc07 --license non-commercial

  View in admin dashboard:
  https://admin.genobank.io
```

## MongoDB Collections

### `lab_wallets` Collection

```javascript
{
  "_id": ObjectId("..."),
  "serial": 43,
  "lab_name": "Novogene",
  "wallet_address": "0x9346be6aD3384EB36c172F8B2bB4b7C9d8afFc07",
  "private_key": "081114ff09e10efb12970c90e162d5bb6d1db6823706633df8fdeeb13590918a",
  "mnemonic": "word1 word2 ... word12",
  "website": "https://www.novogene.com",
  "email": "contact@novogene.com",
  "specialization": "Genomic sequencing and bioinformatics",
  "description": "Leading genomics service provider...",
  "logo_url": "https://www.novogene.com/logo.png",
  "location": "United States",
  "network": "sequentia",
  "chain_id": 15132025,
  "verified": true,
  "auto_generated": true,
  "claimed": false,
  "created_at": ISODate("2025-11-10T08:00:00Z"),
  "updated_at": ISODate("2025-11-10T08:00:00Z")
}
```

### `researcher_registration_logs` Collection

```javascript
{
  "_id": ObjectId("..."),
  "researcher_serial": 43,
  "researcher_wallet": "0X9346BE6AD3384EB36C172F8B2BB4B7C9D8AFFC07",
  "researcher_name": "Novogene",
  "admin_wallet": "0X088EBE307B4200A62DC6190D0AC52D55BCABAC11",
  "timestamp": ISODate("2025-11-10T08:00:00Z"),
  "action": "researcher_registered_blockchain",
  "network": "sequentia",
  "chain_id": 15132025,
  "tx_hash": "0xabc123...",
  "ip_address": "CLI"
}
```

## Environment Variables

Required in `/home/ubuntu/Genobank_APIs/production_api/.env`:

```bash
# Sequentia Network Configuration
SEQUENTIA_RPC_URL=http://52.90.163.112:8545
SEQUENTIA_CHAIN_ID=15132025
SEQUENTIA_EXECUTOR_KEY=***REMOVED***

# BioPIL DAO Contract
BIOPIL_CONTRACT_ADDRESS=0xDae899b64282370001E3f820304213eDf2D983DE

# MongoDB
MONGO_DB_HOST=mongodb://localhost:27017/genobank-api

# GenoBank API
GENOBANK_API_URL=https://genobank.app
ADMIN_SIGNATURE=0xa5141ae955bba91ad46a940aefc3b05120489b8b776a180668e5b849f16254d44982fb867724390b388ea3bbc606ab4128e264c7b4d3de4082aeb63c3144af501c
```

## Implementation Details

### Files Created

1. **`/home/ubuntu/biofs-cli/src/commands/admin/register-lab.ts`**
   - Main registration logic
   - Website extraction via GenoBank API
   - Wallet generation with ethers.js
   - MongoDB operations
   - Sequentia blockchain registration

2. **`/home/ubuntu/biofs-cli/src/commands/admin/index.ts`**
   - Admin command group index
   - Exports createAdminCommand()

### Integration Points

- **GenoBank API**: `/api_lab_customization/extract_website_branding` endpoint
- **MongoDB**: Direct connection to `genobank-api` database
- **Sequentia Network**: Blockchain registration via BioPIL DAO
- **Admin Dashboard**: Labs appear at `https://admin.genobank.io`

## Security Considerations

1. **Private Key Storage**: Private keys stored in MongoDB (consider encryption at rest)
2. **Admin Privileges**: Command requires admin credentials from `.env`
3. **HTTPS Required**: Website URLs must use HTTPS for extraction
4. **Wallet Security**: EIP-55 checksummed addresses

## Troubleshooting

### Website Extraction Fails
```bash
⚠️  Website extraction failed: timeout
```
**Solution**: Use manual overrides with `--name`, `--email`, etc.

### Blockchain Registration Fails
```bash
⚠️  Blockchain registration skipped: contract not deployed
```
**Solution**: Lab will still be registered in MongoDB. Blockchain registration is optional.

### MongoDB Connection Error
```bash
Error: MongoServerError: connection refused
```
**Solution**: Verify MongoDB is running and `MONGO_DB_HOST` is correct

## Testing

```bash
# Test with Novogene (real website)
biofs admin register-lab https://www.novogene.com --yes

# Test with custom overrides
biofs admin register-lab https://example-lab.edu \
  --name "Example Genomics Lab" \
  --email contact@example.edu \
  --specialization "cancer genomics" \
  --location "Boston, MA" \
  --auto-approve
```

## Future Enhancements

1. **Lab Claims Wallet**: Allow labs to claim custodial wallets via email verification
2. **Batch Registration**: Register multiple labs from CSV file
3. **Email Notifications**: Send registration confirmation to lab email
4. **Private Key Encryption**: Encrypt private keys at rest using AWS KMS
5. **BioPIL DAO Confirmation**: Verify contract interface and enable full blockchain registration

## Support

For issues or questions:
- GitHub: https://github.com/Genobank/biofs-cli
- Email: support@genobank.io
- Dashboard: https://admin.genobank.io

---

**Implementation Date**: November 11, 2025
**Author**: GenoBank.io - BioFS CLI Team
**Network**: Sequentia Mainnet (Chain ID: 15132025)
