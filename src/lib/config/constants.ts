import dotenv from 'dotenv';
import path from 'path';

// Load .env from CLI root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

export const CONFIG = {
  // API URLs
  API_BASE_URL: process.env.GENOBANK_API_BASE || 'https://genobank.app',
  AUTH_BASE_URL: process.env.GENOBANK_AUTH_BASE || 'https://auth.genobank.app',
  HEADLESS_AUTH_URL: process.env.GENOBANK_HEADLESS_AUTH || 'https://genobank.io/consent/consent-access.html?headless=true',
  IPFS_GATEWAY: 'https://ipfs.genobank.app/ipfs',

  // Local server
  CALLBACK_PORT: 44321,
  CALLBACK_PATH: '/callback',
  AUTH_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes

  // Storage paths
  HOME_DIR: process.env.HOME || process.env.USERPROFILE || '.',
  CONFIG_DIR_NAME: '.biofs',  // FIXED: was '.genobank' - caused login bug!
  CREDENTIALS_FILE: 'credentials.json',
  CONFIG_FILE: 'config.json',

  // File operations
  CHUNK_SIZE: 5 * 1024 * 1024, // 5MB chunks for upload
  STREAM_THRESHOLD: 100 * 1024 * 1024, // 100MB threshold for streaming
  CACHE_DURATION_MS: 5 * 60 * 1000, // 5 minute cache
  UPLOAD_TIMEOUT_MS: 300000, // 5 minutes for large file uploads

  // Credentials
  CREDENTIAL_EXPIRY_DAYS: 30,

  // Sequentia v4 Smart Contracts (Deployed Nov 15, 2025)
  CONTRACTS: {
    BIONFT: '0x1e7403430a367C83dF96d5492cCB114b3750B00A',
    BIOPIL: '0x6474485F6fE3c19Ac0cD069D4cBc421656942DA9',
    BIOAGENT_NFT: '0x04D716bb245b55c715872F00d80BfE1b1d03a121',
    X402_ROUTER: '0xe95f101dcBe711Ba9252043943ba28f7D9aE8014',
    VALIDATOR_MANAGER: '0x4E21d10CCd98D46CA7045C475C4B46bdC6244B3a',
    SEQUSDC: '0x85f8B3F5A3f6EA2E02BeE85a1C96F5e7e08f30F9',
    STAKING_VALIDATOR: '0xbe31AB4fb4631d89a3b2D69D1e0E496B3D2F5df3'
  }
};

// Sequentia Blockchain Network Configuration (Cosmos SDK + EVM Module v0.5.0)
export const SEQUENTIA_NETWORK = {
  rpc: process.env.SEQUENTIA_RPC_URL || 'http://52.90.163.112:8545',
  chainId: parseInt(process.env.SEQUENTIA_CHAIN_ID || '262144'),
  cosmosChainId: process.env.SEQUENTIA_COSMOS_CHAIN_ID || 'sequentia-15132025',
  explorer: process.env.SEQUENTIA_EXPLORER || 'http://52.90.163.112:26657',
  name: 'Sequentia v4 Mainnet'
};

// API Configuration
export const API_CONFIG = {
  base: process.env.GENOBANK_API_BASE || 'https://genobank.app',
  auth: process.env.GENOBANK_AUTH_BASE || 'https://auth.genobank.app',
  bioip: '/api_bioip',
  fuse: '/api_biofs_fuse',  // Mounted on main API, use relative path
  timeout: 300000 // 5 minutes for large file uploads
};

// Gemini AI Configuration
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

export const FILE_TYPES = {
  vcf: { ext: ['.vcf', '.vcf.gz'], desc: 'Variant Call Format' },
  fastq: { ext: ['.fastq', '.fastq.gz', '.fq', '.fq.gz'], desc: 'FASTQ sequence' },
  bam: { ext: ['.bam', '.sam'], desc: 'Alignment files' },
  pdf: { ext: ['.pdf'], desc: 'PDF documents' },
  csv: { ext: ['.csv'], desc: 'CSV files' },
  json: { ext: ['.json'], desc: 'JSON files' },
  txt: { ext: ['.txt'], desc: 'Text files' }
};
