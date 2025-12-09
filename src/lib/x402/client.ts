/**
 * x402 Client for BioFS
 *
 * Handles x402 payment protocol on Avalanche C-Chain
 * - Automatic payment handling for HTTP 402 responses
 * - EIP-712 typed signature generation
 * - Facilitator integration for settlement
 */

import { ethers } from 'ethers';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  X402Network,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402SettlementResult,
  X402ClientConfig,
  X402_TYPES,
  USDC_ADDRESSES,
  RPC_URLS,
  CHAIN_IDS,
  FACILITATOR_URLS
} from '../../types/x402';
import { Logger } from '../utils/logger';
import { getCredentials } from '../auth/credentials';

// USDC has 6 decimals
const USDC_DECIMALS = 6;

/**
 * X402 Payment Client
 *
 * Wraps HTTP client with automatic x402 payment handling
 */
export class X402Client {
  private config: X402ClientConfig;
  private signer: ethers.Wallet | null = null;
  private provider: ethers.JsonRpcProvider;
  private httpClient: AxiosInstance;
  private nonce: bigint = BigInt(0);

  constructor(config: Partial<X402ClientConfig> = {}) {
    this.config = {
      facilitatorUrl: config.facilitatorUrl || FACILITATOR_URLS.public,
      network: config.network || 'avalanche-fuji',
      maxAmount: config.maxAmount || '10.00',  // Default $10 max auto-approve
      privateKey: config.privateKey
    };

    // Initialize provider
    this.provider = new ethers.JsonRpcProvider(RPC_URLS[this.config.network]);

    // Initialize HTTP client
    this.httpClient = axios.create({
      timeout: 60000,
      validateStatus: () => true  // Handle all status codes
    });
  }

  /**
   * Initialize signer from credentials or config
   */
  async initSigner(): Promise<void> {
    if (this.signer) return;

    if (this.config.privateKey) {
      this.signer = new ethers.Wallet(this.config.privateKey, this.provider);
    } else {
      // Try to get from BioFS credentials
      const credentials = await getCredentials();
      if (credentials?.user_signature) {
        // Derive ephemeral key from signature (for CLI use)
        // This creates a deterministic wallet from the user's signature
        const hash = ethers.keccak256(ethers.toUtf8Bytes(credentials.user_signature));
        this.signer = new ethers.Wallet(hash, this.provider);
        Logger.debug('Using ephemeral key derived from signature');
      }
    }

    if (!this.signer) {
      throw new Error('No signer available. Please run "biofs login" or provide private key.');
    }

    // Initialize nonce
    this.nonce = BigInt(Date.now());
  }

  /**
   * Get current signer address
   */
  async getAddress(): Promise<string> {
    await this.initSigner();
    return this.signer!.address;
  }

  /**
   * Convert price string to USDC amount (wei)
   * e.g., "$5.00" -> 5000000 (6 decimals)
   */
  parsePrice(priceStr: string): bigint {
    // Remove $ and parse as float
    const amount = parseFloat(priceStr.replace('$', ''));
    // Convert to USDC units (6 decimals)
    return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  }

  /**
   * Format USDC amount to human readable
   */
  formatPrice(amount: bigint): string {
    const value = Number(amount) / 10 ** USDC_DECIMALS;
    return `$${value.toFixed(2)}`;
  }

  /**
   * Create EIP-712 signature for payment
   */
  async signPayment(requirement: X402PaymentRequirement): Promise<X402PaymentPayload> {
    await this.initSigner();

    const chainId = CHAIN_IDS[this.config.network];
    const usdcAddress = USDC_ADDRESSES[this.config.network];
    const amount = this.parsePrice(requirement.amount);
    const deadline = Math.floor(Date.now() / 1000) + 3600;  // 1 hour expiry
    this.nonce += BigInt(1);

    // EIP-712 domain
    const domain = {
      name: 'x402 Payment',
      version: '1',
      chainId: chainId,
      verifyingContract: usdcAddress
    };

    // Payment data
    const message = {
      token: usdcAddress,
      amount: amount,
      receiver: requirement.receiver,
      sender: this.signer!.address,
      nonce: this.nonce,
      deadline: deadline
    };

    // Sign typed data
    const signature = await this.signer!.signTypedData(domain, X402_TYPES, message);

    return {
      network: this.config.network,
      token: usdcAddress,
      amount: requirement.amount,
      receiver: requirement.receiver,
      sender: this.signer!.address,
      signature: signature,
      nonce: this.nonce.toString(),
      deadline: deadline,
      chainId: chainId
    };
  }

  /**
   * Verify and settle payment through facilitator
   */
  async settlePayment(payment: X402PaymentPayload): Promise<X402SettlementResult> {
    try {
      const response = await this.httpClient.post(
        `${this.config.facilitatorUrl}/verify`,
        { payment },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );

      if (response.status === 200 && response.data.valid) {
        // Submit to chain
        const settleResponse = await this.httpClient.post(
          `${this.config.facilitatorUrl}/settle`,
          { payment },
          {
            headers: { 'Content-Type': 'application/json' }
          }
        );

        if (settleResponse.status === 200) {
          return {
            success: true,
            transactionHash: settleResponse.data.transactionHash,
            blockNumber: settleResponse.data.blockNumber
          };
        }

        return {
          success: false,
          error: settleResponse.data.error || 'Settlement failed'
        };
      }

      return {
        success: false,
        error: response.data.error || 'Verification failed'
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Parse 402 response to extract payment requirement
   */
  parsePaymentRequirement(response: AxiosResponse): X402PaymentRequirement | null {
    const paymentHeader = response.headers['x-payment-required'];
    if (!paymentHeader) return null;

    try {
      return JSON.parse(paymentHeader) as X402PaymentRequirement;
    } catch {
      // Try parsing from body
      if (response.data?.payment_required) {
        return response.data.payment_required as X402PaymentRequirement;
      }
      return null;
    }
  }

  /**
   * Make HTTP request with automatic x402 payment handling
   */
  async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    // Make initial request
    let response = await this.httpClient.request<T>(config);

    // Check for 402 Payment Required
    if (response.status === 402) {
      const requirement = this.parsePaymentRequirement(response);

      if (!requirement) {
        throw new Error('402 Payment Required but no payment details provided');
      }

      // Check if amount exceeds max auto-approve
      const amount = this.parsePrice(requirement.amount);
      const maxAmount = this.parsePrice(this.config.maxAmount!);

      if (amount > maxAmount) {
        throw new Error(
          `Payment of ${this.formatPrice(amount)} exceeds max auto-approve of ${this.formatPrice(maxAmount)}. ` +
          `Use --approve-payment flag to proceed.`
        );
      }

      Logger.info(`Payment required: ${requirement.amount} for ${requirement.description || requirement.route}`);

      // Sign payment
      const payment = await this.signPayment(requirement);

      // Settle payment
      const result = await this.settlePayment(payment);

      if (!result.success) {
        throw new Error(`Payment failed: ${result.error}`);
      }

      Logger.success(`Payment settled: ${result.transactionHash}`);

      // Retry original request with payment proof
      config.headers = {
        ...config.headers,
        'X-Payment-Proof': JSON.stringify({
          transactionHash: result.transactionHash,
          payment: payment
        })
      };

      response = await this.httpClient.request<T>(config);
    }

    return response;
  }

  /**
   * GET request with payment handling
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  /**
   * POST request with payment handling
   */
  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }

  /**
   * Check USDC balance
   */
  async getUSDCBalance(): Promise<string> {
    await this.initSigner();

    const usdcAddress = USDC_ADDRESSES[this.config.network];
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(usdcAddress, usdcAbi, this.provider);

    const balance = await usdc.balanceOf(this.signer!.address);
    return this.formatPrice(balance);
  }

  /**
   * Approve USDC spending for facilitator
   */
  async approveUSDC(amount: string = '1000000'): Promise<string> {
    await this.initSigner();

    const usdcAddress = USDC_ADDRESSES[this.config.network];
    const usdcAbi = [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)'
    ];
    const usdc = new ethers.Contract(usdcAddress, usdcAbi, this.signer!);

    // Parse amount
    const amountWei = this.parsePrice(amount);

    // Check existing allowance
    // For now, approve a high amount (no specific facilitator contract needed for EIP-712)
    // In production, you'd approve the specific payment contract

    Logger.info(`Approving ${amount} USDC for payments...`);

    // This is a simplified version - actual x402 uses permit or direct EIP-712
    return 'EIP-712 payments do not require pre-approval';
  }
}

/**
 * Create a pre-configured x402 client for BioFS
 */
export async function createBioFSPaymentClient(
  network: X402Network = 'avalanche-fuji'
): Promise<X402Client> {
  const client = new X402Client({
    network,
    facilitatorUrl: process.env.X402_FACILITATOR_URL || FACILITATOR_URLS.public
  });

  await client.initSigner();
  return client;
}

/**
 * Singleton instance for CLI
 */
let _clientInstance: X402Client | null = null;

export async function getPaymentClient(): Promise<X402Client> {
  if (!_clientInstance) {
    _clientInstance = await createBioFSPaymentClient();
  }
  return _clientInstance;
}

