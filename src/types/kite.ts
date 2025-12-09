/**
 * Kite AI Network Types for BioFS
 *
 * Kite is the first AI payment blockchain - foundational infrastructure
 * empowering autonomous agents to operate and transact with identity,
 * payment, governance, and verification.
 *
 * Reference: https://docs.gokite.ai/
 */

// Supported Kite networks
export type KiteNetwork = 'kite-testnet' | 'kite-mainnet';

// Kite network configuration
export interface KiteNetworkConfig {
  chainName: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  faucetUrl?: string;
  nativeToken: string;
}

// Network configurations
export const KITE_NETWORKS: Record<KiteNetwork, KiteNetworkConfig> = {
  'kite-testnet': {
    chainName: 'KiteAI Testnet',
    chainId: 2368,
    rpcUrl: 'https://rpc-testnet.gokite.ai/',
    explorerUrl: 'https://testnet.kitescan.ai/',
    faucetUrl: 'https://faucet.gokite.ai',
    nativeToken: 'KITE'
  },
  'kite-mainnet': {
    chainName: 'KiteAI Mainnet',
    chainId: 2368,  // TBD - Coming soon
    rpcUrl: 'https://rpc.gokite.ai/',  // TBD
    explorerUrl: 'https://kitescan.ai/',  // TBD
    nativeToken: 'KITE'
  }
};

/**
 * Decentralized Identifier (DID) for Kite
 * Format: did:kite:<namespace>/<agent-name>-<version>
 * Example: did:kite:genobank.eth/augenomics-clara-v1
 */
export interface KiteDID {
  method: 'kite';
  namespace: string;      // e.g., 'genobank.eth'
  agentName: string;      // e.g., 'augenomics-clara'
  version: string;        // e.g., 'v1'
}

/**
 * Kite Passport - Cryptographic identity card for agents
 */
export interface KitePassport {
  // Core identity
  did: string;                    // Full DID string
  walletAddress: string;          // BIP-32 derived wallet address
  derivationPath: string;         // BIP-32 path (e.g., m/44'/60'/0'/0/1)

  // Capabilities and permissions
  capabilities: string[];         // ['fastq-to-vcf', 'variant-calling', etc.]
  spendingCaps: SpendingCaps;     // Financial limits

  // Metadata
  name: string;                   // Human-readable name
  description: string;            // Service description
  createdAt: number;              // Unix timestamp
  expiresAt?: number;             // Optional expiration

  // Verification
  ownerSignature: string;         // Signature from master wallet
  publicKey: string;              // Agent's public key
}

/**
 * Spending caps for agents - enforced by smart contracts
 */
export interface SpendingCaps {
  maxPerTransaction: string;      // Max per single transaction (e.g., '$100')
  maxDaily: string;               // Max daily aggregate (e.g., '$1000')
  maxMonthly?: string;            // Optional monthly limit
  whitelistedRecipients?: string[]; // Only these addresses can receive
}

/**
 * Standing Intent (SI) - User's signed declaration of what agent may do
 */
export interface StandingIntent {
  issuer: string;                 // User wallet address
  subject: string;                // Agent DID
  capabilities: SpendingCaps;     // Hard limits
  expiration: number;             // Unix timestamp
  signature: string;              // User's signature
}

/**
 * Delegation Token (DT) - Agent authorization for specific sessions
 */
export interface DelegationToken {
  issuer: string;                 // Agent DID
  subject: string;                // Session public key
  intentHash: string;             // Hash of Standing Intent
  operation: OperationDetails;    // Specific operation authorized
  expiration: number;             // Short-lived (typically 60s)
  signature: string;              // Agent's signature
}

/**
 * Operation details for delegation tokens
 */
export interface OperationDetails {
  type: 'payment' | 'api_call' | 'data_access';
  target: string;                 // Target service/address
  amount?: string;                // For payments
  method?: string;                // For API calls
  params?: Record<string, any>;   // Additional parameters
}

/**
 * Service Level Agreement (SLA) - Smart contract enforced guarantees
 */
export interface AgentSLA {
  // Performance guarantees
  responseTime: number;           // Max response time in ms (e.g., 7200000 = 2hr)
  availability: number;           // Uptime percentage (e.g., 0.999 = 99.9%)
  accuracy: number;               // Error rate threshold (e.g., 0.999 = <0.1% errors)
  throughput: number;             // Min requests/hour capacity

  // Penalty conditions
  penalties: SLAPenalty[];

  // Staking (optional)
  stakedAmount?: string;          // Amount staked as collateral
}

/**
 * SLA penalty configuration
 */
export interface SLAPenalty {
  condition: 'response_timeout' | 'downtime' | 'error' | 'throughput_fail';
  threshold: number;              // Violation threshold
  penaltyPercent: number;         // % of payment refunded
  reputationImpact: number;       // Reputation points deducted
}

/**
 * Agent registration for Kite network
 */
export interface KiteAgent {
  // Identity
  passport: KitePassport;

  // Service configuration
  serviceType: AgentServiceType;
  endpoint: string;               // API endpoint URL

  // SLA and pricing
  sla: AgentSLA;
  pricing: AgentPricing;

  // Reputation
  reputation: AgentReputation;

  // Status
  status: 'active' | 'inactive' | 'suspended';
  registeredAt: number;
  lastActiveAt: number;
}

/**
 * Agent service types for BioFS
 */
export type AgentServiceType =
  | 'orchestrator'          // BioFS-CLI
  | 'gpu-compute'           // Clara Parabricks
  | 'vcf-annotator'         // OpenCRAVAT
  | 'ai-analysis'           // Claude AI
  | 'storage'               // BioFS Node
  | 'tokenization';         // Story Protocol

/**
 * Agent pricing configuration (x402 compatible)
 */
export interface AgentPricing {
  protocol: 'x402';
  network: KiteNetwork;
  currency: 'KITE' | 'USDC';
  basePrice: string;              // Base price per job
  perGBPrice?: string;            // Additional per-GB pricing
  perMinutePrice?: string;        // Time-based pricing
  receiver: string;               // Payment receiver address
}

/**
 * Agent reputation - accumulated from verifiable behavior
 */
export interface AgentReputation {
  score: number;                  // 0-1000
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  averageResponseTime: number;    // ms
  uptimePercent: number;
  lastUpdated: number;
}

/**
 * Pre-defined BioFS agents
 */
export const BIOFS_AGENTS: Record<string, Partial<KiteAgent>> = {
  'biofs-orchestrator': {
    serviceType: 'orchestrator',
    endpoint: 'https://biofs.genobank.app/api',
    pricing: {
      protocol: 'x402',
      network: 'kite-testnet',
      currency: 'USDC',
      basePrice: '$0.00',  // Orchestrator is free
      receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a'
    },
    sla: {
      responseTime: 5000,       // 5 seconds
      availability: 0.999,
      accuracy: 0.999,
      throughput: 1000,
      penalties: []
    }
  },

  'augenomics-clara': {
    serviceType: 'gpu-compute',
    endpoint: 'https://clara.genobank.app/api',
    pricing: {
      protocol: 'x402',
      network: 'kite-testnet',
      currency: 'USDC',
      basePrice: '$0.25',
      receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a'
    },
    sla: {
      responseTime: 7200000,    // 2 hours
      availability: 0.999,
      accuracy: 0.999,
      throughput: 10,
      penalties: [
        { condition: 'response_timeout', threshold: 7200000, penaltyPercent: 50, reputationImpact: 10 },
        { condition: 'error', threshold: 0.01, penaltyPercent: 100, reputationImpact: 50 }
      ]
    }
  },

  'opencravat-annotator': {
    serviceType: 'vcf-annotator',
    endpoint: 'https://cravat.genobank.app/api',
    pricing: {
      protocol: 'x402',
      network: 'kite-testnet',
      currency: 'USDC',
      basePrice: '$0.05',
      receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a'
    },
    sla: {
      responseTime: 1800000,    // 30 minutes
      availability: 0.999,
      accuracy: 0.999,
      throughput: 50,
      penalties: [
        { condition: 'response_timeout', threshold: 1800000, penaltyPercent: 25, reputationImpact: 5 },
        { condition: 'downtime', threshold: 0.001, penaltyPercent: 10, reputationImpact: 20 }
      ]
    }
  }
};

/**
 * BIP-32 derivation paths for BioFS agents
 */
export const AGENT_DERIVATION_PATHS: Record<string, string> = {
  'biofs-orchestrator': "m/44'/60'/0'/0/0",
  'augenomics-clara': "m/44'/60'/0'/0/1",
  'opencravat-annotator': "m/44'/60'/0'/0/2",
  'claude-ai': "m/44'/60'/0'/0/3",
  'biofs-node': "m/44'/60'/0'/0/4",
  'story-tokenizer': "m/44'/60'/0'/0/5"
};


