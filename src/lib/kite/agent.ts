/**
 * Kite Agent Manager
 *
 * Manages BioFS agents on the Kite network:
 * - Agent registration and discovery
 * - SLA monitoring
 * - Reputation tracking
 * - Inter-agent coordination
 */

import { ethers } from 'ethers';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import {
  KiteAgent,
  KitePassport,
  KiteNetwork,
  AgentServiceType,
  AgentSLA,
  AgentPricing,
  AgentReputation,
  KITE_NETWORKS,
  BIOFS_AGENTS,
  AGENT_DERIVATION_PATHS
} from '../../types/kite';
import {
  createPassport,
  createStandingIntent,
  loadPassport,
  savePassport,
  listPassports,
  createDID
} from './passport';
import { Logger } from '../utils/logger';
import { getCredentials } from '../auth/credentials';

// Agent registry storage
const AGENT_REGISTRY_DIR = path.join(process.env.HOME || '~', '.biofs', 'agents');

/**
 * Agent Manager - Handles agent lifecycle on Kite
 */
export class AgentManager {
  private network: KiteNetwork;
  private provider: ethers.JsonRpcProvider;
  private namespace: string;

  constructor(network: KiteNetwork = 'kite-testnet', namespace: string = 'genobank.eth') {
    this.network = network;
    this.namespace = namespace;
    this.provider = new ethers.JsonRpcProvider(KITE_NETWORKS[network].rpcUrl);
  }

  /**
   * Register a new agent on Kite
   */
  async registerAgent(
    agentName: string,
    serviceType: AgentServiceType,
    endpoint: string,
    options: {
      sla?: Partial<AgentSLA>;
      pricing?: Partial<AgentPricing>;
      capabilities?: string[];
      description?: string;
    } = {}
  ): Promise<KiteAgent> {
    Logger.info(`Registering agent: ${agentName}`);

    // Get default config if exists
    const defaultConfig = BIOFS_AGENTS[agentName] || {};

    // Create passport
    const capabilities = options.capabilities || this.getDefaultCapabilities(serviceType);
    const description = options.description || `BioFS ${serviceType} agent`;

    const passport = await createPassport(
      this.namespace,
      agentName,
      capabilities,
      {
        maxPerTransaction: '$100',
        maxDaily: '$1000'
      },
      description
    );

    // Create SLA
    const sla: AgentSLA = {
      responseTime: options.sla?.responseTime || defaultConfig.sla?.responseTime || 60000,
      availability: options.sla?.availability || defaultConfig.sla?.availability || 0.99,
      accuracy: options.sla?.accuracy || defaultConfig.sla?.accuracy || 0.99,
      throughput: options.sla?.throughput || defaultConfig.sla?.throughput || 100,
      penalties: options.sla?.penalties || defaultConfig.sla?.penalties || []
    };

    // Create pricing
    const pricing: AgentPricing = {
      protocol: 'x402',
      network: this.network,
      currency: options.pricing?.currency || 'USDC',
      basePrice: options.pricing?.basePrice || defaultConfig.pricing?.basePrice || '$0.01',
      perGBPrice: options.pricing?.perGBPrice,
      perMinutePrice: options.pricing?.perMinutePrice,
      receiver: options.pricing?.receiver || defaultConfig.pricing?.receiver ||
        '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a'
    };

    // Initialize reputation
    const reputation: AgentReputation = {
      score: 500,  // Start at mid-range
      totalJobs: 0,
      successfulJobs: 0,
      failedJobs: 0,
      averageResponseTime: 0,
      uptimePercent: 100,
      lastUpdated: Date.now()
    };

    const now = Date.now();

    const agent: KiteAgent = {
      passport,
      serviceType,
      endpoint,
      sla,
      pricing,
      reputation,
      status: 'active',
      registeredAt: now,
      lastActiveAt: now
    };

    // Save agent
    await this.saveAgent(agent);

    // Save passport separately
    await savePassport(passport);

    Logger.success(`Agent registered: ${passport.did}`);
    Logger.info(`  Wallet: ${passport.walletAddress}`);
    Logger.info(`  Endpoint: ${endpoint}`);

    return agent;
  }

  /**
   * Register pre-defined BioFS agents
   */
  async registerBioFSAgents(): Promise<KiteAgent[]> {
    const agents: KiteAgent[] = [];

    // Register BioFS Orchestrator
    const orchestrator = await this.registerAgent(
      'biofs-orchestrator',
      'orchestrator',
      'https://biofs.genobank.app/api',
      {
        description: 'BioFS CLI orchestrator - coordinates genomic processing agents',
        capabilities: ['orchestration', 'job-coordination', 'payment-routing']
      }
    );
    agents.push(orchestrator);

    // Register AUgenomics Clara
    const clara = await this.registerAgent(
      'augenomics-clara',
      'gpu-compute',
      'https://clara.genobank.app/api',
      {
        description: 'NVIDIA Clara Parabricks GPU variant calling (FASTQ to VCF)',
        capabilities: ['fastq-to-vcf', 'variant-calling', 'gpu-processing', 'deepvariant']
      }
    );
    agents.push(clara);

    // Register OpenCRAVAT Annotator
    const opencravat = await this.registerAgent(
      'opencravat-annotator',
      'vcf-annotator',
      'https://cravat.genobank.app/api',
      {
        description: 'OpenCRAVAT VCF annotation with 146 annotators',
        capabilities: ['vcf-annotation', 'clinical-interpretation', 'gene-analysis', '146-annotators']
      }
    );
    agents.push(opencravat);

    return agents;
  }

  /**
   * Get default capabilities for service type
   */
  private getDefaultCapabilities(serviceType: AgentServiceType): string[] {
    const capabilityMap: Record<AgentServiceType, string[]> = {
      'orchestrator': ['orchestration', 'job-coordination', 'payment-routing'],
      'gpu-compute': ['fastq-to-vcf', 'variant-calling', 'gpu-processing'],
      'vcf-annotator': ['vcf-annotation', 'clinical-interpretation'],
      'ai-analysis': ['genomic-analysis', 'variant-interpretation', 'report-generation'],
      'storage': ['file-storage', 'nft-gating', 'access-control'],
      'tokenization': ['nft-minting', 'ip-registration', 'license-management']
    };

    return capabilityMap[serviceType] || [];
  }

  /**
   * Save agent to registry
   */
  private async saveAgent(agent: KiteAgent): Promise<void> {
    await fs.ensureDir(AGENT_REGISTRY_DIR);

    const filename = `${agent.passport.did.replace(/[:/]/g, '_')}.json`;
    const filepath = path.join(AGENT_REGISTRY_DIR, filename);

    await fs.writeJson(filepath, agent, { spaces: 2 });
  }

  /**
   * Load agent from registry
   */
  async loadAgent(did: string): Promise<KiteAgent | null> {
    const filename = `${did.replace(/[:/]/g, '_')}.json`;
    const filepath = path.join(AGENT_REGISTRY_DIR, filename);

    if (!await fs.pathExists(filepath)) {
      return null;
    }

    return fs.readJson(filepath);
  }

  /**
   * List all registered agents
   */
  async listAgents(): Promise<KiteAgent[]> {
    await fs.ensureDir(AGENT_REGISTRY_DIR);

    const files = await fs.readdir(AGENT_REGISTRY_DIR);
    const agents: KiteAgent[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const agent = await fs.readJson(path.join(AGENT_REGISTRY_DIR, file));
          agents.push(agent);
        } catch {
          // Skip invalid files
        }
      }
    }

    return agents;
  }

  /**
   * Find agents by service type
   */
  async findAgentsByType(serviceType: AgentServiceType): Promise<KiteAgent[]> {
    const agents = await this.listAgents();
    return agents.filter(a => a.serviceType === serviceType);
  }

  /**
   * Find agents by capability
   */
  async findAgentsByCapability(capability: string): Promise<KiteAgent[]> {
    const agents = await this.listAgents();
    return agents.filter(a =>
      a.passport.capabilities.some(c => c.toLowerCase().includes(capability.toLowerCase()))
    );
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(did: string, status: 'active' | 'inactive' | 'suspended'): Promise<void> {
    const agent = await this.loadAgent(did);
    if (!agent) {
      throw new Error(`Agent not found: ${did}`);
    }

    agent.status = status;
    agent.lastActiveAt = Date.now();

    await this.saveAgent(agent);
  }

  /**
   * Update agent reputation after job completion
   */
  async updateReputation(
    did: string,
    success: boolean,
    responseTimeMs: number
  ): Promise<AgentReputation> {
    const agent = await this.loadAgent(did);
    if (!agent) {
      throw new Error(`Agent not found: ${did}`);
    }

    const rep = agent.reputation;

    // Update job counts
    rep.totalJobs++;
    if (success) {
      rep.successfulJobs++;
    } else {
      rep.failedJobs++;
    }

    // Update average response time
    rep.averageResponseTime = (
      (rep.averageResponseTime * (rep.totalJobs - 1) + responseTimeMs) / rep.totalJobs
    );

    // Calculate new score (0-1000)
    const successRate = rep.successfulJobs / rep.totalJobs;
    const speedBonus = Math.max(0, 1 - (rep.averageResponseTime / agent.sla.responseTime));

    rep.score = Math.min(1000, Math.max(0,
      Math.floor(successRate * 700 + speedBonus * 200 + (rep.uptimePercent / 100) * 100)
    ));

    rep.lastUpdated = Date.now();

    await this.saveAgent(agent);

    return rep;
  }

  /**
   * Check if agent meets SLA requirements
   */
  checkSLACompliance(agent: KiteAgent, responseTimeMs: number): {
    compliant: boolean;
    violations: string[];
  } {
    const violations: string[] = [];

    if (responseTimeMs > agent.sla.responseTime) {
      violations.push(`Response time ${responseTimeMs}ms exceeds SLA ${agent.sla.responseTime}ms`);
    }

    if (agent.reputation.uptimePercent < agent.sla.availability * 100) {
      violations.push(`Uptime ${agent.reputation.uptimePercent}% below SLA ${agent.sla.availability * 100}%`);
    }

    const errorRate = agent.reputation.failedJobs / Math.max(1, agent.reputation.totalJobs);
    if (errorRate > (1 - agent.sla.accuracy)) {
      violations.push(`Error rate ${(errorRate * 100).toFixed(1)}% exceeds SLA ${((1 - agent.sla.accuracy) * 100).toFixed(1)}%`);
    }

    return {
      compliant: violations.length === 0,
      violations
    };
  }

  /**
   * Get agent health status
   */
  async checkAgentHealth(did: string): Promise<{
    online: boolean;
    responseTime?: number;
    error?: string;
  }> {
    const agent = await this.loadAgent(did);
    if (!agent) {
      return { online: false, error: 'Agent not found' };
    }

    try {
      const start = Date.now();
      const response = await axios.get(`${agent.endpoint}/health`, { timeout: 10000 });
      const responseTime = Date.now() - start;

      return {
        online: response.status === 200,
        responseTime
      };
    } catch (error: any) {
      return {
        online: false,
        error: error.message
      };
    }
  }

  /**
   * Delete an agent
   */
  async deleteAgent(did: string): Promise<boolean> {
    const filename = `${did.replace(/[:/]/g, '_')}.json`;
    const filepath = path.join(AGENT_REGISTRY_DIR, filename);

    if (await fs.pathExists(filepath)) {
      await fs.remove(filepath);
      return true;
    }

    return false;
  }
}

/**
 * Get singleton agent manager
 */
let _agentManager: AgentManager | null = null;

export function getAgentManager(
  network: KiteNetwork = 'kite-testnet',
  namespace: string = 'genobank.eth'
): AgentManager {
  if (!_agentManager) {
    _agentManager = new AgentManager(network, namespace);
  }
  return _agentManager;
}


