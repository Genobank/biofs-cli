/**
 * x402 Express Middleware for BioFS Node Server
 *
 * Protects routes with HTTP 402 Payment Required
 * Uses Avalanche C-Chain USDC for payments
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ethers } from 'ethers';
import {
  X402Network,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402PriceTag,
  X402RouteConfig,
  BIOFS_PRICING,
  USDC_ADDRESSES,
  RPC_URLS,
  CHAIN_IDS,
  X402_TYPES
} from '../../types/x402';
import { Logger } from '../utils/logger';

const USDC_DECIMALS = 6;

/**
 * Verify EIP-712 payment signature
 */
async function verifyPaymentSignature(
  payment: X402PaymentPayload,
  network: X402Network
): Promise<{ valid: boolean; error?: string }> {
  try {
    const chainId = CHAIN_IDS[network];
    const usdcAddress = USDC_ADDRESSES[network];

    // EIP-712 domain
    const domain = {
      name: 'x402 Payment',
      version: '1',
      chainId: chainId,
      verifyingContract: usdcAddress
    };

    // Parse amount
    const amount = parseFloat(payment.amount.replace('$', ''));
    const amountWei = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));

    // Payment message
    const message = {
      token: usdcAddress,
      amount: amountWei,
      receiver: payment.receiver,
      sender: payment.sender,
      nonce: BigInt(payment.nonce),
      deadline: payment.deadline
    };

    // Verify signature
    const recoveredAddress = ethers.verifyTypedData(
      domain,
      X402_TYPES,
      message,
      payment.signature
    );

    if (recoveredAddress.toLowerCase() !== payment.sender.toLowerCase()) {
      return { valid: false, error: 'Signature does not match sender' };
    }

    // Check deadline
    if (payment.deadline < Math.floor(Date.now() / 1000)) {
      return { valid: false, error: 'Payment has expired' };
    }

    return { valid: true };
  } catch (error: any) {
    return { valid: false, error: error.message };
  }
}

/**
 * Check if payment proof is valid and settled on-chain
 */
async function verifyPaymentProof(
  proofHeader: string,
  network: X402Network
): Promise<boolean> {
  try {
    const proof = JSON.parse(proofHeader);

    // First verify signature
    const sigResult = await verifyPaymentSignature(proof.payment, network);
    if (!sigResult.valid) {
      Logger.warn(`Payment signature invalid: ${sigResult.error}`);
      return false;
    }

    // If transaction hash provided, verify on-chain
    if (proof.transactionHash) {
      const provider = new ethers.JsonRpcProvider(RPC_URLS[network]);
      const receipt = await provider.getTransactionReceipt(proof.transactionHash);

      if (!receipt || receipt.status !== 1) {
        Logger.warn('Payment transaction not confirmed');
        return false;
      }
    }

    return true;
  } catch (error: any) {
    Logger.warn(`Payment proof verification failed: ${error.message}`);
    return false;
  }
}

/**
 * x402 Payment Middleware Factory
 *
 * Creates Express middleware that requires payment for protected routes
 */
export function x402Middleware(options: {
  receiver: string;
  pricing?: X402RouteConfig;
  network?: X402Network;
  facilitatorUrl?: string;
}): RequestHandler {
  const network = options.network || 'avalanche-fuji';
  const pricing = options.pricing || BIOFS_PRICING;

  return async (req: Request, res: Response, next: NextFunction) => {
    const route = req.path;

    // Check if route requires payment
    const priceTag = pricing[route];
    if (!priceTag) {
      return next();  // No payment required for this route
    }

    // Check for payment proof header
    const paymentProof = req.headers['x-payment-proof'] as string;

    if (paymentProof) {
      // Verify payment
      const valid = await verifyPaymentProof(paymentProof, network);
      if (valid) {
        Logger.info(`Payment verified for ${route}`);
        return next();  // Payment verified, proceed
      }
    }

    // Return 402 Payment Required
    const requirement: X402PaymentRequirement = {
      network: priceTag.network,
      token: USDC_ADDRESSES[priceTag.network],
      amount: priceTag.price,
      receiver: priceTag.receiver || options.receiver,
      description: priceTag.description,
      route: route,
      method: req.method,
      expiresAt: Math.floor(Date.now() / 1000) + 3600  // 1 hour
    };

    res.status(402);
    res.setHeader('X-Payment-Required', JSON.stringify(requirement));
    res.setHeader('Content-Type', 'application/json');

    return res.json({
      error: 'Payment Required',
      status: 402,
      payment_required: requirement,
      message: `This endpoint requires a payment of ${priceTag.price} USDC on ${priceTag.network}`,
      instructions: {
        step1: 'Sign an EIP-712 payment message with your wallet',
        step2: 'Submit the signature to the facilitator for verification',
        step3: 'Include the payment proof in X-Payment-Proof header',
        facilitator: options.facilitatorUrl || 'https://x402.org/facilitator/',
        network: network,
        usdc_address: USDC_ADDRESSES[network]
      }
    });
  };
}

/**
 * Create price tag for a route
 */
export function priceTag(
  price: string,
  receiver: string,
  description?: string,
  network: X402Network = 'avalanche-fuji'
): X402PriceTag {
  return {
    price,
    network,
    receiver,
    description
  };
}

/**
 * Helper to wrap existing route handlers with payment requirement
 */
export function requirePayment(
  priceTag: X402PriceTag,
  handler: RequestHandler
): RequestHandler[] {
  const middleware = x402Middleware({
    receiver: priceTag.receiver,
    pricing: { '*': priceTag },
    network: priceTag.network
  });

  return [middleware, handler];
}

/**
 * Dynamic pricing based on request parameters
 * (e.g., price per GB for downloads)
 */
export function dynamicPricing(
  calculatePrice: (req: Request) => X402PriceTag | null
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const priceTag = calculatePrice(req);

    if (!priceTag) {
      return next();  // No payment required
    }

    // Check for existing payment
    const paymentProof = req.headers['x-payment-proof'] as string;
    if (paymentProof) {
      const valid = await verifyPaymentProof(paymentProof, priceTag.network);
      if (valid) {
        return next();
      }
    }

    // Return 402
    const requirement: X402PaymentRequirement = {
      network: priceTag.network,
      token: USDC_ADDRESSES[priceTag.network],
      amount: priceTag.price,
      receiver: priceTag.receiver,
      description: priceTag.description,
      route: req.path,
      method: req.method
    };

    res.status(402);
    res.setHeader('X-Payment-Required', JSON.stringify(requirement));
    return res.json({
      error: 'Payment Required',
      payment_required: requirement
    });
  };
}

/**
 * Example: Dynamic pricing for file downloads (per GB)
 */
export function downloadPricing(pricePerGB: string, receiver: string): RequestHandler {
  return dynamicPricing((req: Request) => {
    const fileSize = parseInt(req.query.size as string) || 0;
    const sizeGB = fileSize / (1024 * 1024 * 1024);

    if (sizeGB <= 0.1) {
      return null;  // Free for files under 100MB
    }

    const priceNum = parseFloat(pricePerGB.replace('$', ''));
    const totalPrice = (priceNum * sizeGB).toFixed(2);

    return {
      price: `$${totalPrice}`,
      network: 'avalanche-fuji',
      receiver,
      description: `Download ${sizeGB.toFixed(2)} GB file`
    };
  });
}
