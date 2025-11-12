# BioFS v1.3.0 Enhanced Roadmap
## License Management + S3 Policy Enforcement Integration

**Version**: 1.2.0 → 1.3.0
**Duration**: 2 weeks
**Priority**: P1 - High (Production-Critical Feature)

---

## Mission Statement

**Link Story Protocol PIL license terms to AWS S3 bucket policies**, creating the world's first blockchain-enforced cloud storage system where **smart contract conditions automatically translate into infrastructure access control**.

---

## Enhanced Scope (Based on Architecture Deep-Dive)

### Original Scope (from v1.2.0 TODO)
- License management commands
- Collection system
- Search & discovery

### **NEW Enhanced Scope**
- ✅ License management commands
- ✅ Collection system
- ✅ Search & discovery
- **🆕 PIL → S3 Policy Mapping Engine**
- **🆕 S3 Object Lambda Enforcement Layer**
- **🆕 Dynamic Policy Generation from Story Protocol Events**
- **🆕 Object-Level Access Control with BioNFT Tags**
- **🆕 Revenue Share Tracking for Commercial Licenses**

---

## Architecture Foundation

### The Hybrid Enforcement Model

```
┌─────────────────────────────────────────────────────────────┐
│ Story Protocol Smart Contract (Source of Truth)             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ PIL License Terms:                                    │  │
│  │  - commercial_use: boolean                           │  │
│  │  - derivatives_allowed: boolean                      │  │
│  │  - revenue_share: 0-100%                             │  │
│  │  - minting_fee: uint256                              │  │
│  └──────────────────┬───────────────────────────────────┘  │
└────────────────────┬┴──────────────────────────────────────┘
                     │
                     │ Event: LicenseTermsAttached(ipId, termsId)
                     ↓
┌────────────────────────────────────────────────────────────┐
│ Layer 1: GenoBank API (genobank.app)                       │
│  - Listens to Story Protocol events                        │
│  - Generates session tokens with license metadata          │
│  - Creates presigned URLs with PIL constraints             │
└──────────────────────┬─────────────────────────────────────┘
                       │
                       │ Session Token (JWT)
                       ↓
┌────────────────────────────────────────────────────────────┐
│ Layer 2: S3 Object Lambda (ENFORCEMENT)                    │
│  Lambda: bioip-access-validator                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ 1. Verify session token signature                    │ │
│  │ 2. Check commercial_use vs commercial_intent         │ │
│  │ 3. Check derivatives_allowed vs request type         │ │
│  │ 4. Verify license token ownership (if required)      │ │
│  │ 5. Log access event (for revenue tracking)           │ │
│  │ 6. Inject attribution headers                        │ │
│  │ 7. Return file OR deny with license violation reason │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────┬─────────────────────────────────────┘
                       │
                       ↓
┌────────────────────────────────────────────────────────────┐
│ Layer 3: S3 Bucket (vault.genobank.io)                     │
│  Object Tags (auto-generated):                             │
│   - ip_asset_id                                            │
│   - license_type                                           │
│   - commercial_use: true/false                             │
│   - derivatives_allowed: true/false                        │
│   - revenue_share_pct: 0-100                               │
│   - nft_owner: 0x5f5a...                                   │
└────────────────────────────────────────────────────────────┘
```

---

## Sprint 1: License Management Commands (Week 1)

### 1.1 View License Terms (`biofs license show`)

**Command**:
```bash
biofs license show <biocid|ip_id>
```

**Output**:
```
┌─────────────────────────────────────────────────────────────┐
│ License Terms for BioIP 0xCCe14315...                       │
├─────────────────────────────────────────────────────────────┤
│ License Type:        Non-Commercial Social Remixing         │
│ License ID:          1                                      │
│                                                             │
│ ✓ Commercial Use:    Not Allowed                           │
│ ✓ Derivatives:       Allowed                               │
│ ✓ Approval Required: No                                    │
│ ✓ Attribution:       Required                              │
│ ✓ Revenue Share:     0%                                    │
│                                                             │
│ Minting Fee:         Free                                  │
│ License Tokens:      No token required                     │
│                                                             │
│ What you can do:                                           │
│  ✓ Download for research                                   │
│  ✓ Create derivative works                                 │
│  ✓ Share with attribution                                  │
│                                                             │
│ What you cannot do:                                        │
│  ✗ Use for commercial purposes                             │
│  ✗ Sell access to this data                                │
│                                                             │
│ Story Protocol Explorer:                                   │
│ https://explorer.story.foundation/license/1                │
└─────────────────────────────────────────────────────────────┘
```

**Implementation**:
```typescript
// src/commands/license/show.ts

export async function showLicenseCommand(biocidOrIpId: string) {
  // 1. Resolve BioCID to IP Asset ID
  const ipAssetId = await resolver.resolveToIPAsset(biocidOrIpId);

  // 2. Fetch license terms from Story Protocol
  const licenseTerms = await storyProtocol.getLicenseTerms(ipAssetId);

  // 3. Fetch enforcement status from GenoBank API
  const enforcement = await api.getLicenseEnforcement(ipAssetId);

  // 4. Display formatted output
  displayLicenseTerms(licenseTerms, enforcement);
}
```

**API Integration**:
```python
# GenoBank API: GET /api_bioip/get_license_terms?ip_id={id}

@app.route('/api_bioip/get_license_terms', methods=['GET'])
def get_license_terms():
    ip_id = request.args.get('ip_id')

    # Query Story Protocol via RPC
    license_terms_id = story_protocol.getIpLicenseTerms(ip_id)
    license_terms = story_protocol.getLicenseTerms(license_terms_id)

    # Fetch S3 enforcement status
    s3_tags = get_s3_object_tags(ip_id)

    return jsonify({
        'license_terms': license_terms,
        's3_enforcement': {
            'enabled': s3_tags.get('license_enforcement') == 'true',
            'last_updated': s3_tags.get('license_updated_at')
        }
    })
```

### 1.2 Mint License Token (`biofs license mint`)

**Use Case**: User wants to use BioIP commercially → must purchase license token

**Command**:
```bash
biofs license mint <biocid|ip_id> [--commercial]
```

**Flow**:
1. Check if license token required (`minting_fee > 0`)
2. Display cost in USD + crypto
3. Initiate Stripe/crypto payment
4. Call Story Protocol smart contract to mint license token
5. Update MongoDB with license token ownership
6. Regenerate S3 session token with commercial access

**Implementation**:
```typescript
// src/commands/license/mint.ts

export async function mintLicenseCommand(biocidOrIpId: string, options: {commercial?: boolean}) {
  const ipAssetId = await resolver.resolveToIPAsset(biocidOrIpId);
  const licenseTerms = await storyProtocol.getLicenseTerms(ipAssetId);

  if (licenseTerms.minting_fee === 0) {
    Logger.info('This BioIP does not require a license token (minting fee = 0)');
    return;
  }

  // Display cost
  const costUSD = await convertWeiToUSD(licenseTerms.minting_fee);
  Logger.info(`License Token Cost: ${costUSD} USD (${formatWei(licenseTerms.minting_fee)} ${licenseTerms.currency})`);

  // Confirm purchase
  const confirmed = await confirmPrompt('Proceed with purchase?');
  if (!confirmed) return;

  // Initiate payment
  const payment = await api.createLicensePayment({
    ip_asset_id: ipAssetId,
    license_terms_id: licenseTerms.id,
    amount: licenseTerms.minting_fee
  });

  // Wait for payment confirmation
  const spinner = Logger.spinner('Waiting for payment confirmation...');
  await waitForPayment(payment.id);
  spinner.succeed('Payment confirmed!');

  // Mint license token on Story Protocol
  const tx = await storyProtocol.mintLicenseToken(ipAssetId, licenseTerms.id);
  Logger.success(`License token minted! Token ID: ${tx.tokenId}`);
  Logger.info(`Transaction: ${tx.hash}`);

  // Update local credentials with license token
  await saveCredential('license_tokens', {
    ip_asset_id: ipAssetId,
    token_id: tx.tokenId,
    purchased_at: new Date().toISOString()
  });
}
```

### 1.3 List License Tokens (`biofs license list`)

**Command**:
```bash
biofs license list [--mine]
```

**Output**:
```
Your License Tokens (3):

┌────────────────────────────────────────────────────────────┐
│ Token #1234                                                │
├────────────────────────────────────────────────────────────┤
│ BioIP:      55052008714000.deepvariant.vcf                │
│ IP Asset:   0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7    │
│ Type:       Commercial Use License                         │
│ Purchased:  2025-10-05                                     │
│ Cost:       $100 USD                                       │
│ Status:     ✓ Active                                       │
│                                                            │
│ This token grants:                                         │
│  ✓ Commercial use rights                                  │
│  ✓ Derivative creation                                    │
│  ✓ 10% revenue share to original owner                    │
└────────────────────────────────────────────────────────────┘
```

### 1.4 Check License Compliance (`biofs license check`)

**Command**:
```bash
biofs license check <biocid> --commercial-intent
```

**Purpose**: Verify if user's intended use complies with license before downloading

**Output**:
```
License Compliance Check:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BioIP: 55052008714000.deepvariant.vcf
Your Intent: Commercial Use

License Terms:
  ✗ Commercial use: Not allowed
  ✓ Derivatives: Allowed
  ✓ Attribution: Required

Compliance Status: ✗ VIOLATION

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ Your intended use violates the license terms.

To use this BioIP commercially, you must:
  1. Purchase a commercial license token:
     $ biofs license mint biocid://...

  2. Or request owner to change license:
     $ biofs access request biocid://... --message "Request commercial license"

Current owner: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
```

---

## Sprint 2: S3 Policy Enforcement (Week 1-2)

### 2.1 S3 Object Lambda Deployment

**Infrastructure**:
```yaml
# CloudFormation: bioip-s3-enforcement.yaml

Resources:
  # Step 1: Create S3 Access Point
  BioIPAccessPoint:
    Type: AWS::S3::AccessPoint
    Properties:
      Bucket: vault.genobank.io
      Name: biocid-access-point
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true

  # Step 2: Create Lambda function for enforcement
  BioIPAccessValidator:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: bioip-access-validator
      Runtime: python3.12
      Handler: index.lambda_handler
      MemorySize: 512
      Timeout: 30
      Code:
        ZipFile: |
          # See full implementation in BIONFT_GATED_S3_ARCHITECTURE.md
          import json
          import boto3
          import jwt

          def lambda_handler(event, context):
              # Verify session token
              # Check PIL compliance
              # Log access
              # Return file or deny
              pass
      Environment:
        Variables:
          GENOBANK_API_ENDPOINT: https://genobank.app
          STORY_PROTOCOL_RPC: https://rpc.story.foundation
          DYNAMODB_TABLE: bioip-access-logs

  # Step 3: Create Object Lambda Access Point
  BioIPObjectLambdaAccessPoint:
    Type: AWS::S3ObjectLambda::AccessPoint
    Properties:
      Name: biocid-lambda-access-point
      ObjectLambdaConfiguration:
        SupportingAccessPoint: !GetAtt BioIPAccessPoint.Arn
        TransformationConfigurations:
          - Actions: [GetObject]
            ContentTransformation:
              AwsLambda:
                FunctionArn: !GetAtt BioIPAccessValidator.Arn

  # Step 4: DynamoDB table for access logging
  BioIPAccessLogsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: bioip-access-logs
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: ip_asset_id
          AttributeType: S
        - AttributeName: timestamp
          AttributeType: S
      KeySchema:
        - AttributeName: ip_asset_id
          KeyType: HASH
        - AttributeName: timestamp
          KeyType: RANGE
      TimeToLiveSpecification:
        Enabled: true
        AttributeName: ttl

  # Step 5: EventBridge rule for Story Protocol events
  StoryProtocolEventRule:
    Type: AWS::Events::Rule
    Properties:
      Name: story-protocol-license-updates
      EventPattern:
        source: [story.protocol]
        detail-type: [LicenseTermsAttached]
      Targets:
        - Arn: !GetAtt StoryLicenseSyncFunction.Arn
          Id: SyncLicenseToS3
```

**Deployment**:
```bash
# Deploy CloudFormation stack
aws cloudformation deploy \
  --template-file bioip-s3-enforcement.yaml \
  --stack-name bioip-enforcement \
  --capabilities CAPABILITY_IAM

# Test Lambda function
biofs config test-enforcement --biocid biocid://...
```

### 2.2 Dynamic S3 Object Tagging

**Auto-tagging on Upload**:
```python
# GenoBank API enhancement: Auto-tag S3 objects during tokenization

def upload_with_license_tags(file_path, ip_asset_id, license_terms):
    """
    Upload file to S3 with comprehensive license tagging
    """

    s3_client.upload_file(
        Filename=file_path,
        Bucket='vault.genobank.io',
        Key=s3_path,
        ExtraArgs={
            'Tagging': generate_license_tags(license_terms),
            'ServerSideEncryption': 'AES256',
            'Metadata': {
                'ip-asset-id': ip_asset_id,
                'license-enforced': 'true'
            }
        }
    )

def generate_license_tags(license_terms):
    """
    Generate S3 object tags from PIL license terms
    """
    return urllib.parse.urlencode({
        # Identifiers
        'ip_asset_id': license_terms['ip_asset_id'],
        'license_terms_id': str(license_terms['id']),

        # Enforcement flags
        'commercial_use': str(license_terms['commercial_use']).lower(),
        'derivatives_allowed': str(license_terms['derivatives_allowed']).lower(),
        'derivatives_approval': str(license_terms['derivatives_approval']).lower(),
        'attribution_required': str(license_terms['derivatives_attribution']).lower(),

        # Revenue sharing
        'revenue_share_pct': str(license_terms['derivatives_revenue_share']),
        'minting_fee': str(license_terms['minting_fee']),

        # Metadata
        'license_updated_at': datetime.now().isoformat(),
        'enforcement_enabled': 'true'
    })
```

### 2.3 Session Token Integration in biofs

**Update download flow to use session tokens**:
```typescript
// src/commands/s3/cp.ts - Enhanced download

async function downloadFile(biocid: string, destination: string) {
  // 1. Resolve BioCID
  const ipAsset = await resolver.resolveToIPAsset(biocid);

  // 2. Prompt user for commercial intent
  const commercialIntent = await confirmPrompt(
    'Will you use this data for commercial purposes?'
  );

  // 3. Generate session token via API
  const sessionToken = await api.generateSessionToken({
    ip_asset_id: ipAsset.ipId,
    commercial_intent: commercialIntent,
    user_type: commercialIntent ? 'commercial' : 'academic'
  });

  // 4. Get presigned URL (includes session token)
  const presignedUrl = await api.getPresignedLink({
    s3_path: ipAsset.s3_path,
    session_token: sessionToken
  });

  // 5. Download via S3 Object Lambda Access Point
  const response = await axios.get(presignedUrl, {
    headers: {
      'x-amz-security-token': sessionToken
    },
    responseType: 'stream',
    onDownloadProgress: (progress) => {
      updateProgressBar(progress);
    }
  });

  // 6. Save file
  const writer = fs.createWriteStream(destination);
  response.data.pipe(writer);

  // 7. Display attribution from headers
  const attribution = response.headers['x-bioip-attribution'];
  if (attribution) {
    Logger.info(`\n📝 Attribution: ${attribution}`);
  }
}
```

---

## Sprint 3: Revenue Share Tracking (Week 2)

### 3.1 Access Event Logging

**DynamoDB Schema**:
```json
{
  "ip_asset_id": "0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7",
  "accessor_wallet": "0xResearcher...",
  "timestamp": "2025-10-05T12:00:00Z",
  "object_key": "biowallet/.../file.vcf",
  "file_size": 32145728,
  "access_type": "read",
  "commercial_intent": false,
  "license_compliant": true,
  "revenue_share_owed": 0,
  "ttl": 1728134400
}
```

### 3.2 Revenue Calculation Lambda

**Triggered monthly via EventBridge**:
```python
# Lambda: calculate-revenue-share
# Triggered: 1st day of each month

def calculate_monthly_revenue():
    """
    Calculate revenue share owed to IP owners based on access logs
    """

    # Query DynamoDB for last month's access events
    last_month_start = (datetime.now() - timedelta(days=30)).isoformat()
    last_month_end = datetime.now().isoformat()

    events = table.query(
        IndexName='timestamp-index',
        KeyConditionExpression='timestamp BETWEEN :start AND :end',
        FilterExpression='revenue_share_owed > 0',
        ExpressionAttributeValues={
            ':start': last_month_start,
            ':end': last_month_end
        }
    )

    # Group by IP Asset
    revenue_by_asset = {}
    for event in events:
        ip_asset_id = event['ip_asset_id']
        if ip_asset_id not in revenue_by_asset:
            revenue_by_asset[ip_asset_id] = {
                'owner': get_ip_owner(ip_asset_id),
                'total_owed': 0,
                'access_count': 0
            }

        revenue_by_asset[ip_asset_id]['total_owed'] += event['revenue_share_owed']
        revenue_by_asset[ip_asset_id]['access_count'] += 1

    # Trigger blockchain payments
    for ip_asset_id, revenue in revenue_by_asset.items():
        if revenue['total_owed'] > MINIMUM_PAYOUT_THRESHOLD:
            execute_payment(
                recipient=revenue['owner'],
                amount=revenue['total_owed'],
                ip_asset_id=ip_asset_id
            )
```

---

## Sprint 4: Collection System (Week 2)

### 4.1 Create Collection (`biofs collection create`)

**Command**:
```bash
biofs collection create <name> --symbol <SYMBOL> --category <category>
```

**Example**:
```bash
biofs collection create "Rare Disease Genomics" \
  --symbol RDG \
  --category vcf \
  --license non_commercial
```

**Implementation**: Uses existing `/create_bioip_collection` endpoint

### 4.2 Add to Collection (`biofs collection add`)

**Command**:
```bash
biofs collection add <biocid> <collection_address>
```

**Effect**: Updates S3 object tags with collection metadata

---

## Success Metrics

### Technical Metrics
- [ ] S3 Object Lambda enforcement: 100% of requests
- [ ] License violation detection rate: >99%
- [ ] Access latency overhead: <200ms (p95)
- [ ] Session token generation: <100ms
- [ ] PIL sync from Story Protocol: <5 seconds

### Business Metrics
- [ ] Commercial license sales: Track conversion rate
- [ ] Revenue share distributed: ≥$1000/month (pilot)
- [ ] Compliance violations: <1% of total access

### User Experience Metrics
- [ ] License clarity: User survey score ≥4.5/5
- [ ] CLI usability: Task completion rate ≥95%
- [ ] Error messages: Actionable guidance rate 100%

---

## Testing Strategy

### Unit Tests
- [ ] License term parsing
- [ ] Session token generation
- [ ] PIL compliance checker
- [ ] Revenue calculation logic

### Integration Tests
- [ ] End-to-end: biofs → API → Lambda → S3
- [ ] Story Protocol event listener
- [ ] Commercial vs non-commercial scenarios
- [ ] License token purchase flow

### Load Tests
- [ ] 10,000 concurrent downloads
- [ ] Lambda cold start performance
- [ ] DynamoDB throughput limits

---

## Documentation Deliverables

1. **User Guide**: `docs/LICENSE_MANAGEMENT.md`
   - How to view license terms
   - How to mint license tokens
   - What each license type allows
   - Commercial use guidelines

2. **Developer Guide**: `docs/S3_ENFORCEMENT.md`
   - How Object Lambda works
   - How to extend enforcement logic
   - How to add new PIL parameters

3. **API Reference**: Update `API.md` with new endpoints

---

## Rollout Plan

### Phase 1: Pilot (Week 3)
- Deploy to testnet only
- Test with 10 pilot users
- Monitor Lambda logs for violations
- Collect feedback

### Phase 2: Production (Week 4)
- Deploy to mainnet
- Enable enforcement for new uploads
- Grandfather existing uploads (enforcement off by default)
- Announce feature to community

### Phase 3: Full Enforcement (Week 5)
- Enable enforcement for all uploads
- Mandatory session tokens
- Block non-compliant access

---

**Document Version**: 1.0
**Last Updated**: October 5, 2025
**Status**: Ready for Sprint Planning
**Estimated Effort**: 160 hours (2 engineers × 2 weeks)
