/**
 * BioFiles Cache Manager
 *
 * Maintains a local registry of all user biofiles across:
 * - Story Protocol IP Assets
 * - Avalanche Biosamples
 * - S3 Storage
 * - BioCID Registry
 * - BioIP Registry
 * - Local Files
 *
 * Updated during login and on-demand with `biofs files --update`
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

export interface BioFileLocation {
  s3?: string;              // S3 path: production/users/0x.../variants/file.vcf
  biocid?: string;          // BioCID: biocid://0x.../sequentias/abc123
  story_ip?: string;        // Story IP Asset: 0x...
  avalanche_biosample?: string;  // Avalanche NFT token ID
  local_path?: string;      // Local filesystem path
}

export interface BioFileMetadata {
  file_type?: string;       // genomic, variant, alignment, etc.
  size?: number;            // File size in bytes
  created_at?: string;      // ISO timestamp
  uploaded_at?: string;     // ISO timestamp
  tokenized?: boolean;      // Has IP Asset?
  shared_with?: string[];   // Lab wallet addresses
  license_type?: string;    // non-commercial, gdpr-research, etc.
  fingerprint?: string;     // DNA fingerprint hash
  file_hash?: string;       // SHA256 file hash
}

export interface BioFile {
  filename: string;
  locations: BioFileLocation;
  metadata: BioFileMetadata;
}

export interface BioFilesCache {
  wallet_address: string;
  last_updated: string;     // ISO timestamp
  biofiles: BioFile[];
}

export class BioFilesCacheManager {
  private cacheDir: string;
  private cacheFile: string;

  constructor() {
    // Use ~/.biofs/cache/ directory
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.cacheDir = path.join(homeDir, '.biofs', 'cache');
    this.cacheFile = path.join(this.cacheDir, 'biofiles.json');

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Load cache from disk
   */
  load(): BioFilesCache | null {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        Logger.debug('No biofiles cache found');
        return null;
      }

      const data = fs.readFileSync(this.cacheFile, 'utf-8');
      const cache = JSON.parse(data) as BioFilesCache;

      Logger.debug(`Loaded cache: ${cache.biofiles.length} biofiles, last updated ${cache.last_updated}`);
      return cache;
    } catch (error) {
      Logger.debug(`Error loading cache: ${error}`);
      return null;
    }
  }

  /**
   * Save cache to disk
   */
  save(cache: BioFilesCache): void {
    try {
      const data = JSON.stringify(cache, null, 2);
      fs.writeFileSync(this.cacheFile, data, 'utf-8');
      Logger.debug(`Saved cache: ${cache.biofiles.length} biofiles`);
    } catch (error) {
      Logger.debug(`Error saving cache: ${error}`);
      throw new Error(`Failed to save biofiles cache: ${error}`);
    }
  }

  /**
   * Update cache with new biofiles data
   */
  update(walletAddress: string, biofiles: BioFile[]): void {
    const cache: BioFilesCache = {
      wallet_address: walletAddress,
      last_updated: new Date().toISOString(),
      biofiles
    };

    this.save(cache);
  }

  /**
   * Get all biofiles from cache
   */
  getAll(): BioFile[] {
    const cache = this.load();
    return cache ? cache.biofiles : [];
  }

  /**
   * Find biofile by filename
   */
  findByFilename(filename: string): BioFile | null {
    const cache = this.load();
    if (!cache) return null;

    return cache.biofiles.find(bf => bf.filename === filename) || null;
  }

  /**
   * Find biofile by any identifier (filename, BioCID, IP Asset ID)
   */
  findByIdentifier(identifier: string): BioFile | null {
    const cache = this.load();
    if (!cache) return null;

    return cache.biofiles.find(bf =>
      bf.filename === identifier ||
      bf.locations.biocid === identifier ||
      bf.locations.story_ip === identifier ||
      bf.locations.avalanche_biosample === identifier
    ) || null;
  }

  /**
   * Find all biofiles in a specific location type
   */
  findByLocationType(locationType: keyof BioFileLocation): BioFile[] {
    const cache = this.load();
    if (!cache) return [];

    return cache.biofiles.filter(bf => bf.locations[locationType] !== undefined);
  }

  /**
   * Get cache age in milliseconds
   */
  getCacheAge(): number | null {
    const cache = this.load();
    if (!cache) return null;

    const lastUpdated = new Date(cache.last_updated);
    return Date.now() - lastUpdated.getTime();
  }

  /**
   * Check if cache needs update (older than 1 hour)
   */
  needsUpdate(maxAgeMs: number = 3600000): boolean {
    const age = this.getCacheAge();
    if (age === null) return true;
    return age > maxAgeMs;
  }

  /**
   * Merge new biofiles with existing cache
   * Preserves local_path and other local-only metadata
   */
  merge(walletAddress: string, newBiofiles: BioFile[]): void {
    const existingCache = this.load();

    if (!existingCache || existingCache.wallet_address !== walletAddress) {
      // New wallet or no existing cache - just save
      this.update(walletAddress, newBiofiles);
      return;
    }

    // Merge: preserve local paths and metadata
    const mergedBiofiles = newBiofiles.map(newBf => {
      const existing = existingCache.biofiles.find(bf => bf.filename === newBf.filename);

      if (existing) {
        return {
          ...newBf,
          locations: {
            ...newBf.locations,
            local_path: existing.locations.local_path || newBf.locations.local_path
          },
          metadata: {
            ...newBf.metadata,
            // Preserve local-only metadata
            fingerprint: newBf.metadata.fingerprint || existing.metadata.fingerprint,
            file_hash: newBf.metadata.file_hash || existing.metadata.file_hash
          }
        };
      }

      return newBf;
    });

    // Add any biofiles that exist locally but weren't in server response
    const localOnlyFiles = existingCache.biofiles.filter(existing =>
      existing.locations.local_path &&
      !newBiofiles.find(newBf => newBf.filename === existing.filename)
    );

    const finalBiofiles = [...mergedBiofiles, ...localOnlyFiles];

    this.update(walletAddress, finalBiofiles);
  }

  /**
   * Add or update a single biofile in cache
   */
  upsertBioFile(biofile: BioFile): void {
    const cache = this.load();
    if (!cache) {
      Logger.debug('No cache to upsert into - create cache first');
      return;
    }

    const index = cache.biofiles.findIndex(bf => bf.filename === biofile.filename);

    if (index >= 0) {
      // Update existing
      cache.biofiles[index] = {
        ...cache.biofiles[index],
        ...biofile,
        locations: {
          ...cache.biofiles[index].locations,
          ...biofile.locations
        },
        metadata: {
          ...cache.biofiles[index].metadata,
          ...biofile.metadata
        }
      };
    } else {
      // Add new
      cache.biofiles.push(biofile);
    }

    cache.last_updated = new Date().toISOString();
    this.save(cache);
  }

  /**
   * Clear cache
   */
  clear(): void {
    if (fs.existsSync(this.cacheFile)) {
      fs.unlinkSync(this.cacheFile);
      Logger.debug('Cache cleared');
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    total: number;
    tokenized: number;
    with_biocid: number;
    with_story_ip: number;
    with_avalanche: number;
    in_s3: number;
    local: number;
    last_updated: string | null;
  } {
    const cache = this.load();

    if (!cache) {
      return {
        total: 0,
        tokenized: 0,
        with_biocid: 0,
        with_story_ip: 0,
        with_avalanche: 0,
        in_s3: 0,
        local: 0,
        last_updated: null
      };
    }

    return {
      total: cache.biofiles.length,
      tokenized: cache.biofiles.filter(bf => bf.metadata.tokenized).length,
      with_biocid: cache.biofiles.filter(bf => bf.locations.biocid).length,
      with_story_ip: cache.biofiles.filter(bf => bf.locations.story_ip).length,
      with_avalanche: cache.biofiles.filter(bf => bf.locations.avalanche_biosample).length,
      in_s3: cache.biofiles.filter(bf => bf.locations.s3).length,
      local: cache.biofiles.filter(bf => bf.locations.local_path).length,
      last_updated: cache.last_updated
    };
  }
}


