import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';

export interface TokenizationRecord {
  fileName: string;
  filePath: string;
  ipId: string;
  bioCID: string;
  collection: string;
  license: string;
  title: string;
  description: string;
  fingerprint: string;
  snpCount?: number;
  txHash?: string;
  timestamp: string;
  wallet: string;
  network?: string;  // Added network field
}

/**
 * Get the tokenizations directory path
 */
function getTokenizationsDir(): string {
  return join(homedir(), '.genobank', 'tokenizations');
}

/**
 * Save tokenization record to local storage
 */
export async function saveTokenizationRecord(record: TokenizationRecord): Promise<string> {
  const dir = getTokenizationsDir();

  // Ensure directory exists
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Create filename based on the original filename and timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseFileName = record.fileName.replace(/\.[^/.]+$/, ''); // Remove extension
  const recordFileName = `${baseFileName}_${timestamp}.json`;
  const recordPath = join(dir, recordFileName);

  // Save the record
  await writeFile(recordPath, JSON.stringify(record, null, 2));

  return recordPath;
}

/**
 * Load all tokenization records
 */
export async function loadTokenizationRecords(): Promise<TokenizationRecord[]> {
  const dir = getTokenizationsDir();

  if (!existsSync(dir)) {
    return [];
  }

  // Read all JSON files in the directory
  const { readdir, readFile } = await import('fs/promises');
  const files = await readdir(dir);
  const records: TokenizationRecord[] = [];

  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        const record = JSON.parse(content) as TokenizationRecord;
        records.push(record);
      } catch (error) {
        // Skip invalid JSON files
        continue;
      }
    }
  }

  // Sort by timestamp (newest first)
  records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return records;
}

/**
 * Find tokenization record by fingerprint
 */
export async function findTokenizationByFingerprint(fingerprint: string): Promise<TokenizationRecord | null> {
  const records = await loadTokenizationRecords();
  return records.find(r => r.fingerprint === fingerprint) || null;
}

/**
 * Find tokenization record by IP ID
 */
export async function findTokenizationByIpId(ipId: string): Promise<TokenizationRecord | null> {
  const records = await loadTokenizationRecords();
  return records.find(r => r.ipId === ipId) || null;
}

/**
 * Find tokenization record by BioCID
 */
export async function findTokenizationByBioCID(bioCID: string): Promise<TokenizationRecord | null> {
  const records = await loadTokenizationRecords();
  return records.find(r => r.bioCID === bioCID) || null;
}