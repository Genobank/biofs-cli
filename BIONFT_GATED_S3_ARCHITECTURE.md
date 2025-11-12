# BioNFT-Gated AWS S3 Architecture
## Hybrid Smart Contract + Cloud Policy Enforcement System

**Date**: October 5, 2025
**Version**: 2.0 (Enhanced with PIL Enforcement)
**Status**: Architecture Design - Ready for Implementation
**Authors**: GenoBank Engineering Team

---

## Executive Summary

This document defines a **hybrid architecture** that enforces Story Protocol Programmable IP License (PIL) terms at the AWS S3 infrastructure level, creating the world's first **blockchain-gated cloud storage system** for genomic data.

### Key Innovation
Instead of relying solely on API-level access control (which can be bypassed), we enforce PIL terms using **AWS S3 Object Lambda**, creating a multi-layered defense where **smart contract conditions are automatically translated into S3 bucket policies**.

### Why This Matters
- **Sequencers generate data directly to S3** (Illumina, PacBio, ONT)
- **Researchers need S3-compatible tools** (boto3, AWS CLI, web3fuse)
- **PIL terms must be enforced**, not just checked
- **GDPR compliance** requires erasable storage (S3 ✓, IPFS ✗)

---

## Table of Contents

1. [AWS Services Analysis for Genomic Data](#1-aws-services-analysis-for-genomic-data)
2. [Story Protocol License Terms](#2-story-protocol-license-terms)
3. [PIL → S3 Policy Mapping](#3-pil--s3-policy-mapping)
4. [Multi-Layer Enforcement Architecture](#4-multi-layer-enforcement-architecture)
5. [S3 Object Lambda Implementation](#5-s3-object-lambda-implementation)
6. [Dynamic Policy Generation](#6-dynamic-policy-generation)
7. [Object-Level Access Control](#7-object-level-access-control)
8. [Integration with biofs CLI](#8-integration-with-biofs-cli)
9. [Performance & Scalability](#9-performance--scalability)
10. [Security Model](#10-security-model)
11. [Implementation Roadmap](#11-implementation-roadmap)
12. [Cost Analysis](#12-cost-analysis)

---

## 1. AWS Services Analysis for Genomic Data

### 1.1 Why Sequencers Use S3

**Illumina BaseSpace**
- Native S3 integration via AWS SDK
- Direct upload from sequencer to customer bucket
- Supports `s3://bucket/project/sample/run/` structure

**PacBio SMRT Link**
- S3 as primary storage backend
- Exports `.bam`, `.fastq.gz` directly to S3
- Metadata stored alongside files

**Oxford Nanopore MinKNOW**
- Real-time upload during sequencing
- Supports S3-compatible object storage
- `.fast5`, `.pod5`, `.fastq` formats

**Key Insight**: S3 is the **de facto standard** for lab-generated genomic data because:
1. Sequencer manufacturers provide native integrations
2. No custom development needed for labs
3. Scales to petabytes without infrastructure management
4. Cost-effective with lifecycle policies ($0.023/GB/month standard, $0.004/GB/month Glacier)

### 1.2 AWS Services Comparison

| Service | Purpose | Sequencer Integration | Cost (per TB/month) | Genomic Data Fit | BioNFT Gating Feasibility |
|---------|---------|----------------------|---------------------|------------------|---------------------------|
| **S3 Standard** | Active data storage | ✅ Native | $23 | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ Best option |
| **S3 Intelligent-Tiering** | Auto-tiering | ✅ Native | $23-4 (varies) | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ Best option |
| **S3 Glacier Deep Archive** | Long-term archive | ✅ Lifecycle | $1 | ⭐⭐⭐⭐ Good | ⭐⭐⭐ Limited (slow retrieval) |
| **S3 Access Points** | Multi-tenant access | ✅ Via S3 | $0.50/1M requests | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ **Critical for BioNFT** |
| **S3 Object Lambda** | Request transformation | ✅ Via Access Point | $0.20/GB processed | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ **Critical for PIL** |
| **EFS (Elastic File System)** | Shared filesystem | ❌ Manual mount | $300 | ⭐⭐ Poor | ⭐⭐ Difficult |
| **FSx for Lustre** | HPC scratch storage | ❌ Manual | $140 | ⭐⭐⭐ Good | ⭐ Very difficult |
| **AWS Lake Formation** | Data lake governance | ✅ On top of S3 | +$10 | ⭐⭐⭐⭐ Good | ⭐⭐⭐⭐ Future enhancement |
| **DynamoDB** | Metadata only | ❌ N/A | $125 | ❌ Wrong use case | N/A |
| **RDS** | Relational metadata | ❌ N/A | $115 | ❌ Wrong use case | N/A |

### 1.3 Recommended AWS Stack for BioNFT-Gated Genomics

```
┌─────────────────────────────────────────────────────────────┐
│                   AWS Service Architecture                   │
└─────────────────────────────────────────────────────────────┘

Primary Storage Layer:
  └─ S3 Intelligent-Tiering (vault.genobank.io)
      ├─ Frequent Access Tier (0-30 days): $23/TB
      ├─ Infrequent Access Tier (30-90 days): $12.50/TB
      └─ Archive Access Tier (90+ days): $4/TB

Access Control Layer:
  └─ S3 Access Points (per-user, per-collection)
      ├─ biocid-owner-access-point
      ├─ biocid-permittee-access-point
      └─ biocid-public-access-point (for open licenses)

Enforcement Layer:
  └─ S3 Object Lambda (bioip-access-validator)
      ├─ Verifies BioNFT ownership
      ├─ Checks PIL license terms
      ├─ Enforces commercial/non-commercial usage
      └─ Logs access events

Metadata Layer:
  └─ DynamoDB (bioip-registry)
      ├─ BioCID → IP Asset ID mapping
      ├─ Access control lists (permittees)
      ├─ Usage tracking (for revenue share)
      └─ License compliance logs

Future Analytics Layer (v2.0):
  └─ AWS Lake Formation
      ├─ Fine-grained column/row access control
      ├─ Data catalog with ML-generated tags
      └─ Integration with Athena for SQL queries
```

**Verdict**: S3 + Access Points + Object Lambda is the optimal architecture.

---

## 2. Story Protocol License Terms

### 2.1 PIL License Framework

Story Protocol uses **Programmable IP Licenses (PIL)** with these parameters:

| PIL Parameter | Type | Values | Enforcement Location |
|--------------|------|--------|---------------------|
| `commercial_use` | boolean | true/false | S3 Object Lambda |
| `derivatives_allowed` | boolean | true/false | S3 Bucket Policy |
| `derivatives_approval` | boolean | true/false | S3 Bucket Policy |
| `derivatives_attribution` | boolean | true/false | CloudWatch Logs |
| `derivatives_revenue_share` | uint32 | 0-100% | DynamoDB + Payment System |
| `revenue_ceiling` | uint256 | 0-∞ | DynamoDB + Payment System |
| `currency` | address | ERC20 token | Payment System |
| `royalty_policy` | address | Contract | Payment System |
| `minting_fee` | uint256 | Amount | Payment System |

### 2.2 Common PIL Configurations

**Non-Commercial Social Remixing (Most Common)**
```json
{
  "commercial_use": false,
  "derivatives_allowed": true,
  "derivatives_approval": false,
  "derivatives_attribution": true,
  "derivatives_revenue_share": 0
}
```
→ **S3 Policy**: Read-only access for non-commercial users, require attribution logging

**Commercial Use**
```json
{
  "commercial_use": true,
  "derivatives_allowed": true,
  "derivatives_approval": true,
  "derivatives_revenue_share": 10,
  "revenue_ceiling": 1000000,
  "minting_fee": 100000000000000000
}
```
→ **S3 Policy**: Require license token NFT, track usage, enforce revenue share

**Commercial Remix**
```json
{
  "commercial_use": true,
  "derivatives_allowed": true,
  "derivatives_approval": false,
  "derivatives_attribution": true,
  "derivatives_revenue_share": 5
}
```
→ **S3 Policy**: Allow commercial access, log attribution, track for revenue

---

## 3. PIL → S3 Policy Mapping

### 3.1 Mapping Strategy

Each PIL parameter maps to one or more AWS enforcement mechanisms:

#### `commercial_use: false`
**AWS Enforcement**:
1. **S3 Object Lambda**: Check session token for `commercial_intent` flag
2. **IAM Policy Condition**: `s3:ExistingObjectTag/license_type = "non_commercial"`
3. **CloudWatch Alarm**: Alert if commercial user detected

**Implementation**:
```json
{
  "Condition": {
    "StringEquals": {
      "s3:ExistingObjectTag/commercial_use": "false",
      "aws:RequestTag/user_type": "academic"
    }
  }
}
```

#### `derivatives_allowed: false`
**AWS Enforcement**:
1. **S3 Bucket Policy**: Allow only `s3:GetObject` (no `PutObject`, `CopyObject`)
2. **S3 Object Lambda**: Block requests with `x-amz-copy-source` header
3. **Access Point Policy**: Deny write operations

**Implementation**:
```json
{
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::vault.genobank.io/biowallet/*/bioip/*",
    "Condition": {
      "StringEquals": {
        "s3:ExistingObjectTag/derivatives_allowed": "false"
      }
    }
  }, {
    "Effect": "Deny",
    "Action": ["s3:PutObject", "s3:CopyObject"],
    "Resource": "arn:aws:s3:::vault.genobank.io/biowallet/*/bioip/*"
  }]
}
```

#### `derivatives_revenue_share: 10%`
**AWS Enforcement**:
1. **S3 Object Lambda**: Log download event to DynamoDB
2. **DynamoDB Streams**: Trigger Lambda to calculate revenue
3. **EventBridge**: Schedule monthly revenue distribution
4. **Smart Contract**: Execute payment on-chain

**Implementation**:
```python
# Lambda function triggered on S3 GetObject
def log_usage_event(event):
    biocid = extract_biocid(event['objectKey'])
    ip_asset = get_ip_asset(biocid)

    # Log to DynamoDB
    table.put_item(Item={
        'ip_asset_id': ip_asset['ipId'],
        'accessor_wallet': event['userWallet'],
        'timestamp': datetime.now().isoformat(),
        'file_size': event['objectSize'],
        'revenue_share_pct': ip_asset['license']['derivatives_revenue_share']
    })

    # Calculate revenue owed
    if ip_asset['license']['derivatives_revenue_share'] > 0:
        revenue_owed = calculate_revenue(event['userWallet'], event['objectSize'])
        queue_payment(ip_asset['owner'], revenue_owed)
```

#### `derivatives_attribution: true`
**AWS Enforcement**:
1. **CloudTrail**: Log all S3 access events
2. **S3 Object Lambda**: Inject attribution metadata into response headers
3. **DynamoDB**: Store attribution records
4. **SNS**: Notify owner of derivative creation

**Implementation**:
```python
# S3 Object Lambda adds attribution header
response_headers = {
    'x-bioip-attribution': f'This data derived from BioIP {ip_asset["ipId"]}',
    'x-bioip-owner': ip_asset['owner'],
    'x-bioip-license': ip_asset['license_type'],
    'x-bioip-citation': f'GenoBank BioIP {biocid}'
}
```

### 3.2 Complete Mapping Table

| PIL Term | S3 Mechanism | Implementation | Bypass Protection |
|----------|-------------|----------------|-------------------|
| `commercial_use` | Object Lambda + Tag | Check session token `commercial_intent` flag | Lambda enforcement mandatory |
| `derivatives_allowed` | Bucket Policy + Object Lambda | Deny write/copy operations | Policy + Lambda double-check |
| `derivatives_approval` | Lambda Authorizer + API | Check approval status in MongoDB | Owner must pre-approve in GenoBank API |
| `derivatives_attribution` | CloudTrail + Object Lambda | Inject attribution headers, log events | Automatic, can't bypass |
| `derivatives_revenue_share` | DynamoDB + EventBridge | Track usage, calculate payments | Blockchain settlement enforced |
| `minting_fee` | Lambda + Smart Contract | Check license token ownership | Blockchain proof required |

---

## 4. Multi-Layer Enforcement Architecture

### 4.1 Defense-in-Depth Strategy

We implement **6 layers of enforcement** to prevent bypass:

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Client-Side Validation (biofs CLI)                     │
│  ✓ Fast feedback to user                                        │
│  ✗ Can be bypassed (user can use direct AWS CLI)                │
│  → Purpose: UX, not security                                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│ Layer 2: GenoBank API Gateway (genobank.app)                    │
│  ✓ Verifies Web3 signature                                      │
│  ✓ Checks BioNFT ownership                                      │
│  ✓ Generates presigned URLs with constraints                    │
│  ✗ Can be bypassed if someone gets AWS credentials              │
│  → Purpose: Primary access control + presigned URL generation    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│ Layer 3: S3 Access Point Policy                                 │
│  ✓ Restricts which AWS principals can access                    │
│  ✓ Can limit to specific VPCs or IP ranges                      │
│  ✗ Still IAM-based, not blockchain-based                        │
│  → Purpose: Network-level isolation                              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│ Layer 4: S3 Object Lambda (CRITICAL ENFORCEMENT)                │
│  ✓ Executes on EVERY request (can't bypass)                     │
│  ✓ Verifies session token signed by GenoBank API                │
│  ✓ Checks PIL terms from Story Protocol                         │
│  ✓ Logs access events                                           │
│  ✓ Can modify/redact data based on license                      │
│  ✗ Adds latency (~50-200ms)                                     │
│  → Purpose: **MANDATORY PIL ENFORCEMENT**                        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│ Layer 5: S3 Bucket Policy                                       │
│  ✓ Baseline deny-all policy                                     │
│  ✓ Only allows access via S3 Access Point                       │
│  ✓ Object tagging enforcement                                   │
│  → Purpose: Prevent direct bucket access                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│ Layer 6: CloudWatch Monitoring + Alerting                       │
│  ✓ Detects anomalous access patterns                            │
│  ✓ Alerts on license violations                                 │
│  ✓ Audit trail for GDPR compliance                              │
│  → Purpose: Detection + compliance                               │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Request Flow Example

**Scenario**: Researcher wants to download VCF file with non-commercial license

```
1. Researcher: biofs s3 cp biocid://0x5f5a.../bioip/3931d9ff.../file.vcf local.vcf

2. biofs CLI (Layer 1):
   ├─ Loads ~/.biofs/credentials (Web3 signature)
   ├─ Resolves BioCID → IP Asset ID
   ├─ Checks license terms (cached from previous query)
   ├─ Warns if commercial_use = false and user is commercial
   └─ Continues to API

3. GenoBank API (Layer 2):
   ├─ Verifies Web3 signature → recovers wallet: 0xResearcher...
   ├─ Queries Story Protocol: getIpOwner(ipId) → 0x5f5a... (not researcher)
   ├─ Queries MongoDB: getPermittees(ipId) → [0xResearcher...] ✓ Found!
   ├─ Fetches PIL terms: { commercial_use: false, derivatives_allowed: true }
   ├─ Generates session token (JWT):
   │    {
   │      "wallet": "0xResearcher...",
   │      "ip_asset_id": "0xCCe14315...",
   │      "license_type": "non_commercial_remix",
   │      "commercial_intent": false,  ← User declares non-commercial use
   │      "expires_at": 1696550400,
   │      "signature": "0xAPI_SIGNATURE..."
   │    }
   ├─ Generates presigned URL via S3 Access Point:
   │    https://biocid-permittee-xyz.s3-accesspoint.us-east-1.amazonaws.com/
   │    biowallet/0x5f5a.../bioip/3931d9ff.../file.vcf
   │    ?X-Amz-Algorithm=AWS4-HMAC-SHA256
   │    &X-Amz-Credential=...
   │    &X-Amz-Date=20251005T120000Z
   │    &X-Amz-Expires=3600
   │    &X-Amz-SignedHeaders=host
   │    &X-Amz-Signature=...
   │    &x-amz-security-token=<SESSION_TOKEN>  ← Contains license metadata
   └─ Returns presigned URL to CLI

4. biofs CLI:
   ├─ Makes GET request to presigned URL
   └─ Request goes to S3 Access Point

5. S3 Access Point (Layer 3):
   ├─ Validates presigned URL signature
   ├─ Checks Access Point policy (allows GET from this network)
   └─ Routes request to S3 Object Lambda

6. S3 Object Lambda (Layer 4 - CRITICAL):
   ├─ Lambda function: bioip-access-validator executes
   ├─ Extracts session token from x-amz-security-token header
   ├─ Verifies token signature (signed by GenoBank API)
   ├─ Checks token expiry (not expired)
   ├─ Validates license compliance:
   │    ├─ commercial_use = false in license
   │    ├─ commercial_intent = false in token  ✓ Match!
   │    ├─ derivatives_allowed = true
   │    └─ User is permittee ✓
   ├─ Logs access event to DynamoDB:
   │    {
   │      "ip_asset_id": "0xCCe14315...",
   │      "accessor_wallet": "0xResearcher...",
   │      "timestamp": "2025-10-05T12:00:00Z",
   │      "object_key": "biowallet/.../file.vcf",
   │      "file_size": 32145728,
   │      "access_type": "read",
   │      "license_compliant": true
   │    }
   ├─ Fetches object from underlying S3 bucket
   ├─ Injects attribution headers:
   │    X-BioIP-Attribution: BioIP 0xCCe14315... owned by 0x5f5a...
   │    X-BioIP-License: non_commercial_remix
   │    X-BioIP-Citation: doi:10.genobank/bioip/3931d9ff...
   └─ Returns object to client

7. S3 Bucket (Layer 5):
   ├─ Object retrieved: biowallet/0x5f5a.../bioip/3931d9ff.../file.vcf
   ├─ Object tags verified:
   │    nft_owner: 0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
   │    ip_asset_id: 0xCCe14315eE3D6a41596EeB4a2839eE50A8ec59f7
   │    license_type: non_commercial_remix
   │    commercial_use: false
   └─ Data streamed back through Lambda

8. CloudWatch (Layer 6):
   ├─ CloudTrail logs S3 GetObject event
   ├─ Custom metric: bioip_access_count incremented
   ├─ If commercial_intent = true but commercial_use = false:
   │    └─ SNS alert sent to IP owner + GenoBank compliance team
   └─ Audit log preserved for 7 years (GDPR)

9. Researcher:
   └─ Receives file with attribution metadata
```

**Result**: File downloaded successfully with full license enforcement and audit trail.

---

## 5. S3 Object Lambda Implementation

### 5.1 Why S3 Object Lambda?

**S3 Object Lambda** allows you to add custom code to process data retrieved from S3 **before** it's returned to the client. This is perfect for BioNFT gating because:

1. **Mandatory Execution**: Can't bypass (request must go through Lambda)
2. **Data Transformation**: Can redact PHI based on license level
3. **Access Control**: Can deny requests that violate PIL terms
4. **Audit Trail**: Logs every access attempt
5. **License Injection**: Can add attribution metadata to responses

### 5.2 Lambda Function Architecture

```python
# Lambda: bioip-access-validator
# Runtime: Python 3.12
# Memory: 512 MB
# Timeout: 30 seconds
# Concurrent executions: 1000

import json
import boto3
import jwt
from datetime import datetime

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('bioip-access-logs')

def lambda_handler(event, context):
    """
    S3 Object Lambda handler for BioNFT-gated access control
    """

    # Extract request context
    request_context = event['getObjectContext']
    request_route = request_context['outputRoute']
    request_token = request_context['outputToken']
    s3_url = request_context['inputS3Url']

    # Extract session token from request headers
    session_token = event['userRequest']['headers'].get('x-amz-security-token')

    if not session_token:
        return deny_access(request_route, request_token,
                          "Missing session token - access denied")

    # Verify session token (signed by GenoBank API)
    try:
        token_payload = jwt.decode(
            session_token,
            GENOBANK_PUBLIC_KEY,
            algorithms=['RS256']
        )
    except jwt.InvalidTokenError as e:
        return deny_access(request_route, request_token,
                          f"Invalid session token: {str(e)}")

    # Check token expiry
    if token_payload['expires_at'] < datetime.now().timestamp():
        return deny_access(request_route, request_token,
                          "Session token expired")

    # Fetch PIL license terms from Story Protocol
    license_terms = get_license_terms(token_payload['ip_asset_id'])

    # Enforce license compliance
    compliance_check = check_license_compliance(
        license_terms=license_terms,
        user_intent=token_payload,
        request_type=event['userRequest']['method']
    )

    if not compliance_check['allowed']:
        log_violation(token_payload, compliance_check['reason'])
        return deny_access(request_route, request_token,
                          compliance_check['reason'])

    # Log access event (for revenue share calculation)
    log_access_event(
        ip_asset_id=token_payload['ip_asset_id'],
        accessor_wallet=token_payload['wallet'],
        object_key=event['userRequest']['url'],
        access_type='read'
    )

    # Fetch object from S3
    response = s3.get_object(Bucket=s3_url['bucket'], Key=s3_url['key'])

    # Inject attribution headers
    attribution_headers = generate_attribution_headers(
        ip_asset_id=token_payload['ip_asset_id'],
        license_terms=license_terms
    )

    # Transform data if needed (e.g., redact PHI for limited licenses)
    transformed_data = response['Body'].read()
    if license_terms.get('redact_phi'):
        transformed_data = redact_phi(transformed_data)

    # Return object to client via S3 Object Lambda
    s3.write_get_object_response(
        RequestRoute=request_route,
        RequestToken=request_token,
        Body=transformed_data,
        Metadata=attribution_headers,
        ContentType=response['ContentType']
    )

    return {'statusCode': 200}


def check_license_compliance(license_terms, user_intent, request_type):
    """
    Check if request complies with PIL license terms
    """

    # Commercial use check
    if not license_terms['commercial_use'] and user_intent['commercial_intent']:
        return {
            'allowed': False,
            'reason': 'Commercial use not permitted under this license. '
                     'Please purchase a commercial license token.'
        }

    # Derivatives check (write operations)
    if request_type in ['PUT', 'COPY'] and not license_terms['derivatives_allowed']:
        return {
            'allowed': False,
            'reason': 'Derivative works not permitted under this license.'
        }

    # Derivatives approval check
    if (license_terms['derivatives_approval'] and
        request_type in ['PUT', 'COPY'] and
        not user_has_approval(user_intent['wallet'], user_intent['ip_asset_id'])):
        return {
            'allowed': False,
            'reason': 'Derivative creation requires prior approval from IP owner.'
        }

    # License token check (for commercial use with minting fee)
    if license_terms['minting_fee'] > 0:
        if not user_owns_license_token(user_intent['wallet'], user_intent['ip_asset_id']):
            return {
                'allowed': False,
                'reason': f'License token required (minting fee: {license_terms["minting_fee"]} wei). '
                         f'Purchase via: biofs license mint {user_intent["ip_asset_id"]}'
            }

    return {'allowed': True}


def log_access_event(ip_asset_id, accessor_wallet, object_key, access_type):
    """
    Log access event to DynamoDB for audit trail and revenue calculation
    """
    table.put_item(Item={
        'ip_asset_id': ip_asset_id,
        'accessor_wallet': accessor_wallet,
        'timestamp': datetime.now().isoformat(),
        'object_key': object_key,
        'access_type': access_type,
        'ttl': int(datetime.now().timestamp()) + (365 * 24 * 60 * 60)  # 1 year retention
    })


def generate_attribution_headers(ip_asset_id, license_terms):
    """
    Generate attribution headers to inject into response
    """
    return {
        'x-bioip-attribution': f'Data from BioIP {ip_asset_id}',
        'x-bioip-license': license_terms['license_type'],
        'x-bioip-commercial-use': str(license_terms['commercial_use']).lower(),
        'x-bioip-derivatives-allowed': str(license_terms['derivatives_allowed']).lower(),
        'x-bioip-citation': f'GenoBank BioIP DOI: 10.genobank/bioip/{ip_asset_id}',
        'x-bioip-owner': get_ip_owner(ip_asset_id)
    }


def deny_access(request_route, request_token, reason):
    """
    Return 403 Forbidden with detailed error message
    """
    error_body = json.dumps({
        'error': 'Access Denied',
        'reason': reason,
        'help': 'Visit https://genobank.app/bioip/licenses for license options'
    })

    s3.write_get_object_response(
        RequestRoute=request_route,
        RequestToken=request_token,
        StatusCode=403,
        ErrorCode='AccessDenied',
        ErrorMessage=reason,
        Body=error_body
    )

    return {'statusCode': 403}
```

### 5.3 S3 Object Lambda Configuration

```yaml
# CloudFormation template
Resources:
  BioIPAccessPoint:
    Type: AWS::S3::AccessPoint
    Properties:
      Bucket: vault.genobank.io
      Name: biocid-permittee-access-point
      Policy:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: 'arn:aws:iam::ACCOUNT:role/GenoBank-BioNFT-Reader'
            Action:
              - 's3:GetObject'
            Resource: 'arn:aws:s3:us-east-1:ACCOUNT:accesspoint/biocid-permittee-access-point/object/*'

  BioIPObjectLambdaAccessPoint:
    Type: AWS::S3ObjectLambda::AccessPoint
    Properties:
      Name: biocid-lambda-access-point
      ObjectLambdaConfiguration:
        SupportingAccessPoint: !GetAtt BioIPAccessPoint.Arn
        TransformationConfigurations:
          - Actions:
              - GetObject
            ContentTransformation:
              AwsLambda:
                FunctionArn: !GetAtt BioIPAccessValidatorFunction.Arn
                FunctionPayload: '{}'

  BioIPAccessValidatorFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: bioip-access-validator
      Runtime: python3.12
      Handler: index.lambda_handler
      MemorySize: 512
      Timeout: 30
      Role: !GetAtt BioIPLambdaExecutionRole.Arn
      Environment:
        Variables:
          GENOBANK_API_ENDPOINT: https://genobank.app
          STORY_PROTOCOL_RPC: https://rpc.story.foundation
          DYNAMODB_TABLE: bioip-access-logs
```

---

## 6. Dynamic Policy Generation

### 6.1 Story Protocol Event Listener

When PIL license terms change on Story Protocol, we must update S3 policies dynamically.

**Architecture**:
```
Story Protocol Smart Contract
  ↓ emit LicenseTermsAttached(ipId, licenseTermsId)
  ↓
EventBridge (via RPC polling or webhook)
  ↓ trigger
Lambda: story-license-sync
  ↓
1. Fetch new license terms from Story Protocol
2. Query MongoDB for BioCID → S3 path mapping
3. Generate new S3 object tags
4. Update S3 object metadata
5. Update DynamoDB cache
6. (Optional) Regenerate S3 bucket policy if major change
```

**Implementation**:
```python
# Lambda: story-license-sync
# Triggered by EventBridge on Story Protocol license events

def handle_license_update(event):
    """
    Sync Story Protocol license changes to S3 object tags
    """

    # Extract event data
    ip_asset_id = event['detail']['ipId']
    license_terms_id = event['detail']['licenseTermsId']

    # Fetch new license terms from Story Protocol
    license_terms = story_protocol.getLicenseTerms(license_terms_id)

    # Query MongoDB for all files under this IP Asset
    bioip_records = mongodb.bioip_registry.find({'ip_id': ip_asset_id})

    for bioip in bioip_records:
        s3_path = bioip['s3_path']

        # Update S3 object tags
        s3.put_object_tagging(
            Bucket='vault.genobank.io',
            Key=s3_path,
            Tagging={
                'TagSet': [
                    {'Key': 'ip_asset_id', 'Value': ip_asset_id},
                    {'Key': 'license_type', 'Value': license_terms['licenseType']},
                    {'Key': 'commercial_use', 'Value': str(license_terms['commercialUse'])},
                    {'Key': 'derivatives_allowed', 'Value': str(license_terms['derivativesAllowed'])},
                    {'Key': 'revenue_share_pct', 'Value': str(license_terms['derivativesRevenueShare'])},
                    {'Key': 'last_updated', 'Value': datetime.now().isoformat()}
                ]
            }
        )

        # Update MongoDB cache
        mongodb.bioip_registry.update_one(
            {'_id': bioip['_id']},
            {'$set': {
                'license_terms': license_terms,
                'license_updated_at': datetime.now()
            }}
        )

    # Log sync event
    logger.info(f"Synced license update for IP Asset {ip_asset_id}")
```

### 6.2 S3 Bucket Policy Template Generator

For major policy changes (e.g., making IP Asset public), regenerate bucket policy:

```python
def generate_bucket_policy(ip_asset_id, license_terms):
    """
    Generate S3 bucket policy JSON from PIL license terms
    """

    statements = []

    # Base statement: Deny all except via Access Point
    statements.append({
        "Sid": "DenyDirectAccess",
        "Effect": "Deny",
        "Principal": "*",
        "Action": "s3:*",
        "Resource": "arn:aws:s3:::vault.genobank.io/*",
        "Condition": {
            "StringNotEquals": {
                "s3:DataAccessPointArn": "arn:aws:s3:us-east-1:ACCOUNT:accesspoint/biocid-*"
            }
        }
    })

    # If commercial_use = true, allow commercial principals
    if license_terms['commercial_use']:
        statements.append({
            "Sid": "AllowCommercialAccess",
            "Effect": "Allow",
            "Principal": {"AWS": "arn:aws:iam::ACCOUNT:role/GenoBank-Commercial-User"},
            "Action": "s3:GetObject",
            "Resource": f"arn:aws:s3:::vault.genobank.io/biowallet/*/bioip/{ip_asset_id}/*",
            "Condition": {
                "StringEquals": {
                    "s3:ExistingObjectTag/commercial_use": "true"
                }
            }
        })

    # If derivatives_allowed = false, deny write operations
    if not license_terms['derivatives_allowed']:
        statements.append({
            "Sid": "DenyDerivatives",
            "Effect": "Deny",
            "Principal": "*",
            "Action": ["s3:PutObject", "s3:CopyObject"],
            "Resource": f"arn:aws:s3:::vault.genobank.io/biowallet/*/bioip/{ip_asset_id}/*"
        })

    return {
        "Version": "2012-10-17",
        "Statement": statements
    }
```

---

## 7. Object-Level Access Control

### 7.1 S3 Object Tagging Strategy

Every uploaded file gets tagged with BioNFT metadata:

```python
def upload_with_bionft_tags(file_path, biocid, ip_asset_id, license_terms):
    """
    Upload file to S3 with comprehensive BioNFT tagging
    """

    s3.upload_file(
        Filename=file_path,
        Bucket='vault.genobank.io',
        Key=f'biowallet/{wallet}/bioip/{registration_id}/{filename}',
        ExtraArgs={
            'Tagging': urllib.parse.urlencode({
                # BioNFT identifiers
                'biocid': biocid,
                'ip_asset_id': ip_asset_id,
                'nft_owner': wallet,
                'collection_address': collection_address,

                # License terms
                'license_type': license_terms['license_type'],
                'commercial_use': str(license_terms['commercial_use']).lower(),
                'derivatives_allowed': str(license_terms['derivatives_allowed']).lower(),
                'derivatives_approval': str(license_terms['derivatives_approval']).lower(),
                'revenue_share_pct': str(license_terms['derivatives_revenue_share']),

                # Genomic metadata
                'file_category': file_category,  # vcf, bam, fastq, etc.
                'snp_fingerprint': snp_fingerprint[:32],  # First 32 chars
                'snp_count': str(snp_count),

                # Compliance
                'gdpr_compliant': 'true',
                'phi_removed': str(has_phi_removed).lower(),
                'created_at': datetime.now().isoformat()
            }),

            # Server-side encryption
            'ServerSideEncryption': 'AES256',

            # Metadata (not tags, but object metadata)
            'Metadata': {
                'biocid': biocid,
                'license-type': license_terms['license_type'],
                'owner-wallet': wallet
            }
        }
    )
```

### 7.2 Tag-Based Access Control in S3 Policies

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowNonCommercialUsers",
    "Effect": "Allow",
    "Principal": {
      "AWS": "arn:aws:iam::ACCOUNT:role/GenoBank-Academic-User"
    },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::vault.genobank.io/*",
    "Condition": {
      "StringEquals": {
        "s3:ExistingObjectTag/commercial_use": "false"
      },
      "StringEquals": {
        "aws:PrincipalTag/user_type": "academic"
      }
    }
  }]
}
```

---

## 8. Integration with biofs CLI

### 8.1 Enhanced S3 Commands

```bash
# biofs automatically handles BioNFT gating behind the scenes

# List files (only shows files user has access to)
biofs s3 ls
→ Layer 2 (API) filters by NFT ownership/permittee status

# Download file
biofs s3 cp biocid://... local.vcf
→ Layer 2 generates presigned URL with session token
→ Layer 4 (Object Lambda) enforces PIL terms
→ Layer 6 (CloudWatch) logs access

# Upload file with tokenization
biofs s3 cp local.vcf biocid://...
→ Automatically tags object with license metadata
→ Registers in MongoDB
→ Mints BioNFT if --tokenize flag

# Check access permissions
biofs access check biocid://...
→ Shows: Owner/Permittee/None
→ Shows: License terms
→ Shows: What operations are allowed
```

### 8.2 Session Token Generation in biofs

```typescript
// src/lib/auth/session.ts

export async function generateSessionToken(
  wallet: string,
  ipAssetId: string,
  commercialIntent: boolean
): Promise<string> {

  // Call GenoBank API to generate token
  const response = await api.post('/generate_session_token', {
    user_signature: await getSignature(),
    ip_asset_id: ipAssetId,
    commercial_intent: commercialIntent,
    user_type: commercialIntent ? 'commercial' : 'academic'
  });

  // API returns JWT signed with API private key
  return response.data.session_token;
}
```

---

## 9. Performance & Scalability

### 9.1 Latency Analysis

| Operation | Without Object Lambda | With Object Lambda | Overhead |
|-----------|----------------------|-------------------|----------|
| Small file download (<1MB) | 50ms | 150ms | +100ms |
| Large file download (1GB) | 5s | 5.2s | +200ms |
| List objects | 100ms | 100ms | 0ms (no Lambda) |
| Upload | 2s | 2s | 0ms (Lambda on read only) |

**Mitigation Strategies**:
1. **Lambda warmup**: Keep 10 instances warm via CloudWatch Events
2. **Caching**: Cache license terms in Lambda memory (5 min TTL)
3. **Async logging**: Don't wait for DynamoDB write before returning file
4. **Regional**: Deploy Lambda in same region as S3 bucket

### 9.2 Cost Analysis (1TB data, 10,000 downloads/month)

| Service | Usage | Cost/Month | Annual Cost |
|---------|-------|-----------|-------------|
| S3 Standard Storage | 1TB | $23 | $276 |
| S3 GET Requests | 10,000 | $0.04 | $0.48 |
| S3 Object Lambda Requests | 10,000 | $2.00 | $24 |
| Lambda Compute (10,000 × 200ms @ 512MB) | 2,000 GB-sec | $0.03 | $0.36 |
| DynamoDB Writes (access logs) | 10,000 | $1.25 | $15 |
| CloudWatch Logs | 100MB | $0.50 | $6 |
| **Total** | | **$27** | **$322** |

**Vs. No Enforcement**: $23/month (S3 only)
**Cost of BioNFT Gating**: +$4/month (+17%)

**Verdict**: **Negligible cost increase for massive security benefit**

### 9.3 Scalability Limits

| Metric | Limit | Notes |
|--------|-------|-------|
| Lambda concurrent executions | 1,000 (default) | Can request increase to 10,000+ |
| S3 requests per second | 3,500 GET/sec | Per prefix, unlimited with partitioning |
| DynamoDB writes per second | 40,000 | Auto-scaling enabled |
| Session token expiry | 1 hour | Can extend to 12 hours |

**Scalability Strategy**:
- Use S3 prefix partitioning: `biowallet/{wallet[:4]}/{wallet[4:8]}/...`
- Lambda auto-scaling handles traffic spikes
- DynamoDB on-demand mode for unpredictable workloads

---

## 10. Security Model

### 10.1 Threat Model

| Threat | Mitigation | Layer |
|--------|-----------|-------|
| Direct S3 access (bypass API) | Bucket policy denies all except via Access Point | Layer 5 |
| Stolen AWS credentials | Object Lambda validates session token | Layer 4 |
| Replay attack (reuse session token) | Token expiry (1 hour) + nonce validation | Layer 2 + 4 |
| Commercial user claiming non-commercial | Manual audit + usage pattern analysis | Layer 6 |
| License term bypass | Object Lambda mandatory enforcement | Layer 4 |
| MITM attack on presigned URL | HTTPS required + short expiry | Layer 2 |
| Deleted but still accessible (GDPR) | S3 Delete Marker + Lambda checks deletion flag | Layer 4 |

### 10.2 Security Best Practices

1. **Least Privilege IAM**:
   ```json
   {
     "Effect": "Allow",
     "Action": "s3:GetObject",
     "Resource": "arn:aws:s3:::vault.genobank.io/biowallet/${aws:userid}/*"
   }
   ```

2. **Encryption at Rest**: AES-256 (S3-managed) or KMS for sensitive data

3. **Encryption in Transit**: TLS 1.3 required

4. **Audit Logging**: CloudTrail + custom DynamoDB logs (7-year retention)

5. **Secrets Management**: AWS Secrets Manager for API keys

6. **Network Isolation**: VPC endpoints for S3 (optional for high-security)

---

## 11. Implementation Roadmap

### Phase 1: Core Infrastructure (v1.2.0 - Week 1-2)
- [ ] Create S3 Access Point for BioNFT gating
- [ ] Implement S3 Object Lambda basic validation
- [ ] Set up DynamoDB access logging table
- [ ] Deploy CloudFormation templates
- [ ] Integrate with biofs CLI (session token generation)

### Phase 2: PIL Enforcement (v1.3.0 - Week 3-4)
- [ ] Implement commercial_use enforcement in Lambda
- [ ] Implement derivatives_allowed enforcement
- [ ] Add attribution header injection
- [ ] Set up revenue share tracking in DynamoDB
- [ ] Create Story Protocol event listener for license updates
- [ ] Deploy dynamic policy generation Lambda

### Phase 3: Advanced Features (v1.4.0 - Week 5-7)
- [ ] Implement PHI redaction for limited licenses
- [ ] Add derivative approval workflow
- [ ] Create license token verification
- [ ] Set up revenue distribution automation
- [ ] Implement object-level tagging automation
- [ ] Add compliance reporting dashboard

### Phase 4: Production Hardening (v1.5.0 - Week 8-10)
- [ ] Performance optimization (Lambda warmup, caching)
- [ ] Security audit (penetration testing)
- [ ] Scalability testing (10,000+ concurrent downloads)
- [ ] Documentation for researchers
- [ ] Integration testing with boto-biofs
- [ ] Disaster recovery planning

---

## 12. Cost Analysis

### 12.1 Cost Breakdown (Per 1TB dataset)

**Scenario 1: Low Usage (1,000 downloads/month)**
- S3 Storage: $23
- S3 Requests: $0.004
- Object Lambda: $0.20
- Lambda Compute: $0.003
- DynamoDB: $0.125
- **Total**: $23.33/month → **+1.4% overhead**

**Scenario 2: Medium Usage (10,000 downloads/month)**
- S3 Storage: $23
- S3 Requests: $0.04
- Object Lambda: $2.00
- Lambda Compute: $0.03
- DynamoDB: $1.25
- **Total**: $26.32/month → **+14% overhead**

**Scenario 3: High Usage (100,000 downloads/month)**
- S3 Storage: $23
- S3 Requests: $0.40
- Object Lambda: $20.00
- Lambda Compute: $0.30
- DynamoDB: $12.50
- **Total**: $56.20/month → **+144% overhead**

**Recommendation**: For high-usage BioIPs (>50,000 downloads/month), cache license validation results for 5 minutes to reduce Lambda invocations by 80%.

---

## Conclusion

This architecture achieves the vision of **BioNFT-Gated AWS S3** by:

1. ✅ **Enforcing PIL terms at infrastructure level** (not just API)
2. ✅ **Supporting sequencer-native S3 integration** (no workflow changes for labs)
3. ✅ **Multi-layer defense** (6 enforcement layers)
4. ✅ **Scalable** (handles petabytes of genomic data)
5. ✅ **Cost-effective** (+1-14% overhead for most use cases)
6. ✅ **GDPR compliant** (erasable S3 storage + audit trails)
7. ✅ **Blockchain-verified** (Story Protocol smart contracts are source of truth)

**Next Steps**:
1. Review this architecture with team
2. Approve Phase 1 implementation (v1.2.0)
3. Deploy S3 Access Point + Object Lambda
4. Integrate with biofs CLI
5. Test with real genomic datasets

---

**Document Version**: 1.0
**Last Updated**: October 5, 2025
**Status**: Ready for Implementation
**Estimated Implementation Time**: 10 weeks (4 phases)
