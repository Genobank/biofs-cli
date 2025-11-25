/**
 * PaymentRouter - x402 Protocol Atomic USDC Payments
 *
 * Enables atomic multi-recipient USDC payments for complex genomic workflows:
 * - Sequential payment execution (all-or-nothing)
 * - Payment route escrow
 * - Automatic refund on failure
 * - Revenue sharing for derivative works
 *
 * Example payment routes:
 * - Lab: 70% ($700 USDC)
 * - OpenCRAVAT: 20% ($200 USDC)
 * - GenoBank: 10% ($100 USDC)
 * Total: $1,000 USDC (atomic distribution)
 */

import { ethers } from 'ethers';
import { Logger } from '../utils/logger';

// Sequentia Network Configuration
const SEQUENTIA_RPC_URL = 'http://52.90.163.112:8545';
const PAYMENT_ROUTER_ADDRESS = '0x4b46D8A0533bc17503349F86a909C2FEcFD04489'; // Deployed Nov 24, 2025
const USDC_TOKEN_ADDRESS = '0xD837B344e931cc265ec54879A0B388DE6F0015c9'; // SeqUSDC

export interface PaymentRecipient {
    recipient: string;
    amount: string;                 // USDC amount (6 decimals)
    description: string;
}

export interface PaymentRoute {
    id: string;
    creator: string;
    totalAmount: string;            // USDC total
    recipients: PaymentRecipient[];
    status: 'pending' | 'executed' | 'failed' | 'refunded';
    executedAt?: number;
}

export class PaymentRouter {
    private contract: ethers.Contract;
    private usdcContract: ethers.Contract;
    private signer: ethers.Wallet;
    

    constructor(privateKey: string) {
        

        try {
            const provider = new ethers.JsonRpcProvider(SEQUENTIA_RPC_URL);
            this.signer = new ethers.Wallet(privateKey, provider);

            const routerAbi = require('../../abi/sequentia/PaymentRouter.json');
            this.contract = new ethers.Contract(
                PAYMENT_ROUTER_ADDRESS,
                routerAbi,
                this.signer
            );

            const usdcAbi = require('../../abi/USDC.json');
            this.usdcContract = new ethers.Contract(
                USDC_TOKEN_ADDRESS,
                usdcAbi,
                this.signer
            );

            Logger.info('PaymentRouter initialized');
        } catch (error: any) {
            Logger.error(`Failed to initialize PaymentRouter: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create payment route
     */
    async createRoute(
        jobId: string,
        totalAmount: number,           // USDC amount
        recipients: PaymentRecipient[]
    ): Promise<string> {
        Logger.info(`Creating payment route for job: ${jobId}`);
        Logger.info(`Total: ${totalAmount} USDC`);
        Logger.info(`Recipients: ${recipients.length}`);

        try {
            // Verify amounts sum to total
            const sum = recipients.reduce((acc, r) => acc + parseFloat(r.amount), 0);
            if (Math.abs(sum - totalAmount) > 0.01) {
                throw new Error(`Recipient amounts (${sum}) don't sum to total (${totalAmount})`);
            }

            // Convert to Wei (6 decimals for USDC)
            const totalWei = ethers.parseUnits(totalAmount.toString(), 6);
            const recipientsWei = recipients.map(r => ({
                ...r,
                amount: ethers.parseUnits(r.amount, 6)
            }));

            // Approve USDC
            Logger.info('Approving USDC...');
            const approveTx = await this.usdcContract.approve(
                PAYMENT_ROUTER_ADDRESS,
                totalWei
            );
            await approveTx.wait();

            // Create route
            const tx = await this.contract.createRoute(jobId, totalWei, recipientsWei);
            const receipt = await tx.wait();
            Logger.info(`Payment route created in block ${receipt.blockNumber}`);

            return receipt.transactionHash;

        } catch (error: any) {
            Logger.error(`Route creation failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Execute payment route (atomic!)
     *
     * All payments succeed or all fail - no partial execution
     */
    async executeRoute(jobId: string): Promise<void> {
        Logger.info(`Executing payment route for job: ${jobId}`);

        try {
            const tx = await this.contract.executeRoute(jobId);
            const receipt = await tx.wait();

            Logger.info('✅ Payments distributed atomically via x402');
            Logger.info(`   Block: ${receipt.blockNumber}`);

            // Parse RouteExecuted event
            const event = receipt.logs.find((log: any) => {
                try {
                    return log.topics[0] === this.contract.interface.getEvent('RouteExecuted')!.topicHash;
                } catch {
                    return false;
                }
            });

            if (event) {
                const parsed = this.contract.interface.parseLog({
                    topics: event.topics as string[],
                    data: event.data
                });

                Logger.info(`   Recipients: ${parsed!.args.recipientCount}`);
                Logger.info(`   Total: ${ethers.formatUnits(parsed!.args.totalAmount, 6)} USDC`);
            }

        } catch (error: any) {
            Logger.error(`Route execution failed: ${error.message}`);
            Logger.error('   All payments reverted (x402 atomic guarantee)');
            throw error;
        }
    }

    /**
     * Get payment route details
     */
    async getRoute(jobId: string): Promise<PaymentRoute> {
        Logger.info(`Fetching payment route: ${jobId}`);

        try {
            const route = await this.contract.getRoute(jobId);

            return {
                id: jobId,
                creator: route.creator,
                totalAmount: ethers.formatUnits(route.totalAmount, 6),
                recipients: route.recipients.map((r: any) => ({
                    recipient: r.recipient,
                    amount: ethers.formatUnits(r.amount, 6),
                    description: r.description
                })),
                status: route.status,
                executedAt: route.executedAt
            };

        } catch (error: any) {
            Logger.error(`Failed to fetch route: ${error.message}`);
            throw error;
        }
    }

    /**
     * Refund payment route (if job cancelled)
     */
    async refundRoute(jobId: string): Promise<void> {
        Logger.warn(`⚠️  Refunding payment route: ${jobId}`);

        try {
            const tx = await this.contract.refundRoute(jobId);
            await tx.wait();
            Logger.info('Route refunded to creator');

        } catch (error: any) {
            Logger.error(`Route refund failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Helper: Calculate standard payment split
     */
    static calculateStandardSplit(totalAmount: number): PaymentRecipient[] {
        return [
            {
                recipient: '0x...', // Lab wallet (from job)
                amount: (totalAmount * 0.70).toFixed(2),
                description: 'Lab Processing (70%)'
            },
            {
                recipient: '0x...', // OpenCRAVAT wallet
                amount: (totalAmount * 0.20).toFixed(2),
                description: 'OpenCRAVAT License (20%)'
            },
            {
                recipient: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a', // GenoBank
                amount: (totalAmount * 0.10).toFixed(2),
                description: 'GenoBank Platform (10%)'
            }
        ];
    }

    /**
     * Helper: Calculate derivative revenue split
     */
    static calculateDerivativeSplit(
        totalAmount: number,
        creators: { wallet: string; share: number }[]
    ): PaymentRecipient[] {
        return creators.map(creator => ({
            recipient: creator.wallet,
            amount: (totalAmount * creator.share).toFixed(2),
            description: `Creator (${(creator.share * 100).toFixed(0)}%)`
        }));
    }

    /**
     * Helper: Validate payment route
     */
    static validateRoute(recipients: PaymentRecipient[], totalAmount: number): boolean {
        const sum = recipients.reduce((acc, r) => acc + parseFloat(r.amount), 0);
        return Math.abs(sum - totalAmount) < 0.01;
    }

    /**
     * Helper: Format payment route for display
     */
    static formatRoute(route: PaymentRoute): string {
        let output = `\n📊 Payment Route: ${route.id}\n`;
        output += `   Total: ${route.totalAmount} USDC\n`;
        output += `   Status: ${route.status}\n\n`;
        output += `   Recipients:\n`;

        route.recipients.forEach((r, i) => {
            output += `   ${i + 1}. ${r.recipient.substring(0, 10)}... - ${r.amount} USDC\n`;
            output += `      ${r.description}\n`;
        });

        return output;
    }
}
