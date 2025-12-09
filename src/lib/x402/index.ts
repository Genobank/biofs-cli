/**
 * x402 Protocol Library for BioFS
 *
 * HTTP 402 Payment Required protocol implementation for Avalanche
 */

// Client
export { X402Client, createBioFSPaymentClient, getPaymentClient } from './client';

// Server Middleware
export {
  x402Middleware,
  priceTag,
  requirePayment,
  dynamicPricing,
  downloadPricing
} from './middleware';

// Re-export types
export * from '../../types/x402';

