/**
 * x402 Protocol Types for BioFS
 *
 * HTTP 402 Payment Required protocol for blockchain payments on Avalanche
 * Reference: https://build.avax.network/integrations/x402-rs
 */

// Supported networks
export type X402Network = 'avalanche' | 'avalanche-fuji';

// USDC token addresses on Avalanche
export const USDC_ADDRESSES: Record<X402Network, string> = {
  'avalanche': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',  // USDC on Avalanche C-Chain
  'avalanche-fuji': '0x5425890298aed601595a70AB815c96711a31Bc65'  // USDC on Fuji testnet
};

// RPC URLs
export const RPC_URLS: Record<X402Network, string> = {
  'avalanche': 'https://api.avax.network/ext/bc/C/rpc',
  'avalanche-fuji': 'https://api.avax-test.network/ext/bc/C/rpc'
};

// Chain IDs
export const CHAIN_IDS: Record<X402Network, number> = {
  'avalanche': 43114,
  'avalanche-fuji': 43113
};

// Payment requirement header returned by server
export interface X402PaymentRequirement {
  // Payment details
  network: X402Network;
  token: string;           // Token contract address (USDC)
  amount: string;          // Amount in token units (e.g., "0.025" USDC)
  receiver: string;        // Payment recipient address

  // Optional metadata
  description?: string;
  expiresAt?: number;      // Unix timestamp

  // Route information
  route: string;
  method: string;
}

// Payment payload signed by client
export interface X402PaymentPayload {
  // Payment details
  network: X402Network;
  token: string;
  amount: string;
  receiver: string;
  sender: string;

  // Signature
  signature: string;       // EIP-712 typed signature
  nonce: string;           // Unique nonce for this payment
  deadline: number;        // Expiry timestamp

  // Transaction metadata
  chainId: number;
}

// Response from facilitator after settlement
export interface X402SettlementResult {
  success: boolean;
  transactionHash?: string;
  blockNumber?: number;
  error?: string;
}

// Facilitator verification request
export interface X402VerifyRequest {
  payment: X402PaymentPayload;
  requirement: X402PaymentRequirement;
}

// Facilitator verification response
export interface X402VerifyResponse {
  valid: boolean;
  error?: string;
}

// Price tag for protecting routes
export interface X402PriceTag {
  price: string;           // Price in USD (e.g., "$0.10")
  network: X402Network;
  receiver: string;
  description?: string;
}

// Protected routes configuration
export interface X402RouteConfig {
  [route: string]: X402PriceTag;
}

// BioFS-specific pricing (TESTNET: 100x reduced for testing)
export const BIOFS_PRICING: X402RouteConfig = {
  // OpenCRAVAT annotation
  '/annotate/submit': {
    price: '$0.05',
    network: 'avalanche-fuji',
    receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a',  // GenoBank treasury
    description: 'VCF annotation with 146 OpenCRAVAT annotators'
  },

  // Clara Parabricks GPU processing
  '/job/submit-clara': {
    price: '$0.25',
    network: 'avalanche-fuji',
    receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a',
    description: 'Clara Parabricks FASTQ to VCF variant calling'
  },

  // BioNFT tokenization
  '/tokenize/file': {
    price: '$0.02',
    network: 'avalanche-fuji',
    receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a',
    description: 'Tokenize genomic file as BioNFT on Sequentia'
  },

  // Large file download (per GB)
  '/download/large': {
    price: '$0.001',
    network: 'avalanche-fuji',
    receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a',
    description: 'Large file download (per GB)'
  },

  // AI Claude analysis
  '/claude/analyze': {
    price: '$0.01',
    network: 'avalanche-fuji',
    receiver: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a',
    description: 'AI-powered genomic analysis with Claude'
  }
};

// EIP-712 domain for signing
export interface X402Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

// EIP-712 types for payment signing
export const X402_TYPES = {
  Payment: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'receiver', type: 'address' },
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
};

// Client configuration
export interface X402ClientConfig {
  facilitatorUrl: string;
  network: X402Network;
  privateKey?: string;     // For CLI signing
  maxAmount?: string;      // Maximum auto-approve amount
}

// Default facilitator URLs
export const FACILITATOR_URLS = {
  public: 'https://x402.org/facilitator/',
  docker: 'http://localhost:8080'
};

