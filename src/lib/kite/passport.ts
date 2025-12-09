/**
 * Kite Passport - Agent Identity Management
 *
 * Implements cryptographic identity for BioFS agents using:
 * - BIP-32 hierarchical deterministic key derivation
 * - Decentralized Identifiers (DIDs)
 * - Verifiable credentials and capabilities
 */

import { ethers, HDNodeWallet } from 'ethers';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  KitePassport,
  KiteDID,
  SpendingCaps,
  StandingIntent,
  DelegationToken,
  OperationDetails,
  AGENT_DERIVATION_PATHS
} from '../../types/kite';
import { Logger } from '../utils/logger';
import { getCredentials } from '../auth/credentials';

// Passport storage directory
const PASSPORT_DIR = path.join(process.env.HOME || '~', '.biofs', 'passports');

/**
 * Parse a DID string into components
 * Format: did:kite:<namespace>/<agent-name>-<version>
 */
export function parseDID(didString: string): KiteDID | null {
  const match = didString.match(/^did:kite:([^/]+)\/([^-]+)-(.+)$/);
  if (!match) return null;

  return {
    method: 'kite',
    namespace: match[1],
    agentName: match[2],
    version: match[3]
  };
}

/**
 * Create a DID string from components
 */
export function createDID(namespace: string, agentName: string, version: string = 'v1'): string {
  return `did:kite:${namespace}/${agentName}-${version}`;
}

/**
 * Derive agent wallet from master wallet using BIP-32
 */
export async function deriveAgentWallet(
  masterPrivateKey: string,
  derivationPath: string
): Promise<HDNodeWallet> {
  // Create HD wallet from master key
  const masterWallet = ethers.HDNodeWallet.fromSeed(
    ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(masterPrivateKey)))
  );

  // Derive child wallet at specified path
  const agentWallet = masterWallet.derivePath(derivationPath);

  return agentWallet;
}

/**
 * Derive agent wallet from user signature (for CLI use)
 */
export async function deriveAgentWalletFromSignature(
  userSignature: string,
  derivationPath: string
): Promise<HDNodeWallet> {
  // Create deterministic seed from signature
  const seed = ethers.keccak256(ethers.toUtf8Bytes(userSignature));

  // Create HD wallet from seed
  const masterWallet = ethers.HDNodeWallet.fromSeed(ethers.getBytes(seed));

  // Derive child wallet
  const agentWallet = masterWallet.derivePath(derivationPath);

  return agentWallet;
}

/**
 * Create a Kite Passport for an agent
 */
export async function createPassport(
  namespace: string,
  agentName: string,
  capabilities: string[],
  spendingCaps: SpendingCaps,
  description: string,
  options: {
    version?: string;
    expiresAt?: number;
    masterPrivateKey?: string;
    userSignature?: string;
  } = {}
): Promise<KitePassport> {
  const version = options.version || 'v1';
  const did = createDID(namespace, agentName, version);

  // Get derivation path for agent
  const agentKey = agentName.toLowerCase().replace(/\s+/g, '-');
  const derivationPath = AGENT_DERIVATION_PATHS[agentKey] || "m/44'/60'/0'/0/99";

  // Derive agent wallet
  let agentWallet: HDNodeWallet;

  if (options.masterPrivateKey) {
    agentWallet = await deriveAgentWallet(options.masterPrivateKey, derivationPath);
  } else if (options.userSignature) {
    agentWallet = await deriveAgentWalletFromSignature(options.userSignature, derivationPath);
  } else {
    // Try to get from credentials
    const credentials = await getCredentials();
    if (!credentials?.user_signature) {
      throw new Error('No credentials available. Please login first.');
    }
    agentWallet = await deriveAgentWalletFromSignature(credentials.user_signature, derivationPath);
  }

  const now = Math.floor(Date.now() / 1000);

  // Create passport
  const passport: KitePassport = {
    did,
    walletAddress: agentWallet.address,
    derivationPath,
    capabilities,
    spendingCaps,
    name: agentName,
    description,
    createdAt: now,
    expiresAt: options.expiresAt,
    ownerSignature: '', // Will be signed below
    publicKey: agentWallet.publicKey
  };

  // Sign the passport with agent's key to prove ownership
  const passportHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({
      did: passport.did,
      walletAddress: passport.walletAddress,
      capabilities: passport.capabilities,
      createdAt: passport.createdAt
    }))
  );

  passport.ownerSignature = await agentWallet.signMessage(ethers.getBytes(passportHash));

  return passport;
}

/**
 * Create a Standing Intent (SI) - user authorization for agent
 */
export async function createStandingIntent(
  agentDID: string,
  capabilities: SpendingCaps,
  expirationDays: number = 30,
  userWallet?: ethers.Wallet
): Promise<StandingIntent> {
  // Get user wallet
  let wallet = userWallet;
  if (!wallet) {
    const credentials = await getCredentials();
    if (!credentials?.user_signature) {
      throw new Error('No credentials available. Please login first.');
    }
    const hash = ethers.keccak256(ethers.toUtf8Bytes(credentials.user_signature));
    wallet = new ethers.Wallet(hash);
  }

  const expiration = Math.floor(Date.now() / 1000) + (expirationDays * 24 * 60 * 60);

  const intent: StandingIntent = {
    issuer: wallet.address,
    subject: agentDID,
    capabilities,
    expiration,
    signature: ''
  };

  // Sign the intent
  const intentHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({
      issuer: intent.issuer,
      subject: intent.subject,
      capabilities: intent.capabilities,
      expiration: intent.expiration
    }))
  );

  intent.signature = await wallet.signMessage(ethers.getBytes(intentHash));

  return intent;
}

/**
 * Create a Delegation Token (DT) - short-lived session authorization
 */
export async function createDelegationToken(
  agentWallet: ethers.Wallet | HDNodeWallet,
  standingIntent: StandingIntent,
  operation: OperationDetails,
  expirationSeconds: number = 60
): Promise<DelegationToken> {
  // Generate random session key
  const sessionWallet = ethers.Wallet.createRandom();
  const expiration = Math.floor(Date.now() / 1000) + expirationSeconds;

  // Hash the standing intent for linkage
  const intentHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(standingIntent))
  );

  const token: DelegationToken = {
    issuer: standingIntent.subject,  // Agent DID
    subject: sessionWallet.publicKey,
    intentHash,
    operation,
    expiration,
    signature: ''
  };

  // Sign with agent's key
  const tokenHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify({
      issuer: token.issuer,
      subject: token.subject,
      intentHash: token.intentHash,
      operation: token.operation,
      expiration: token.expiration
    }))
  );

  token.signature = await agentWallet.signMessage(ethers.getBytes(tokenHash));

  return token;
}

/**
 * Verify a Kite Passport
 */
export function verifyPassport(passport: KitePassport): boolean {
  try {
    const passportHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify({
        did: passport.did,
        walletAddress: passport.walletAddress,
        capabilities: passport.capabilities,
        createdAt: passport.createdAt
      }))
    );

    const recoveredAddress = ethers.verifyMessage(
      ethers.getBytes(passportHash),
      passport.ownerSignature
    );

    return recoveredAddress.toLowerCase() === passport.walletAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verify a Standing Intent
 */
export function verifyStandingIntent(intent: StandingIntent): boolean {
  try {
    // Check expiration
    if (intent.expiration < Math.floor(Date.now() / 1000)) {
      return false;
    }

    const intentHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify({
        issuer: intent.issuer,
        subject: intent.subject,
        capabilities: intent.capabilities,
        expiration: intent.expiration
      }))
    );

    const recoveredAddress = ethers.verifyMessage(
      ethers.getBytes(intentHash),
      intent.signature
    );

    return recoveredAddress.toLowerCase() === intent.issuer.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Save passport to file
 */
export async function savePassport(passport: KitePassport): Promise<string> {
  await fs.ensureDir(PASSPORT_DIR);

  const filename = `${passport.did.replace(/[:/]/g, '_')}.json`;
  const filepath = path.join(PASSPORT_DIR, filename);

  await fs.writeJson(filepath, passport, { spaces: 2 });

  Logger.debug(`Passport saved to ${filepath}`);
  return filepath;
}

/**
 * Load passport from file
 */
export async function loadPassport(did: string): Promise<KitePassport | null> {
  const filename = `${did.replace(/[:/]/g, '_')}.json`;
  const filepath = path.join(PASSPORT_DIR, filename);

  if (!await fs.pathExists(filepath)) {
    return null;
  }

  return fs.readJson(filepath);
}

/**
 * List all saved passports
 */
export async function listPassports(): Promise<KitePassport[]> {
  await fs.ensureDir(PASSPORT_DIR);

  const files = await fs.readdir(PASSPORT_DIR);
  const passports: KitePassport[] = [];

  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const passport = await fs.readJson(path.join(PASSPORT_DIR, file));
        passports.push(passport);
      } catch {
        // Skip invalid files
      }
    }
  }

  return passports;
}

/**
 * Delete a passport
 */
export async function deletePassport(did: string): Promise<boolean> {
  const filename = `${did.replace(/[:/]/g, '_')}.json`;
  const filepath = path.join(PASSPORT_DIR, filename);

  if (await fs.pathExists(filepath)) {
    await fs.remove(filepath);
    return true;
  }

  return false;
}
