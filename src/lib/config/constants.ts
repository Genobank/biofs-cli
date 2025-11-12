import dotenv from 'dotenv';
import path from 'path';

// Load .env from CLI root
dotenv.config({ path: path.join(__dirname, '../../../.env') });

export const CONFIG = {
  // API URLs
  API_BASE_URL: process.env.GENOBANK_API_BASE || 'https://genobank.app',
  AUTH_BASE_URL: process.env.GENOBANK_AUTH_BASE || 'https://auth.genobank.app',
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

  // Story Protocol Collections
  COLLECTIONS: {
    VCF_OWNERSHIP: '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5',
    VCF_COLLECTION: '0x19A615224D03487AaDdC43e4520F9D83923d9512',
    VCF_ANNOTATION: '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269',
    ALPHAGENOME: '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171'
  }
};

// Story Protocol Network Configuration
export const STORY_NETWORKS = {
  mainnet: {
    rpc: process.env.STORY_MAINNET_RPC || 'https://rpc.story.foundation',
    chainId: parseInt(process.env.STORY_MAINNET_CHAIN_ID || '1516'),
    explorer: process.env.STORY_MAINNET_EXPLORER || 'https://explorer.story.foundation',
    name: 'Story Protocol Mainnet'
  },
  testnet: {
    rpc: process.env.STORY_TESTNET_RPC || 'https://testnet.storyrpc.io',
    chainId: parseInt(process.env.STORY_TESTNET_CHAIN_ID || '1315'),
    explorer: process.env.STORY_TESTNET_EXPLORER || 'https://aeneid.explorer.story.foundation',
    name: 'Story Protocol Testnet (Aeneid)'
  }
};

// API Configuration
export const API_CONFIG = {
  base: process.env.GENOBANK_API_BASE || 'https://genobank.app',
  auth: process.env.GENOBANK_AUTH_BASE || 'https://auth.genobank.app',
  bioip: '/api_bioip',
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