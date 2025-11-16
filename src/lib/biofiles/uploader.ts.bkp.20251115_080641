import * as fs from 'fs-extra';
import * as path from 'path';
import * as cliProgress from 'cli-progress';
import { GenoBankAPIClient } from '../api/client';
import { BioCIDParser } from './biocid';
import { CONFIG } from '../config/constants';
import chalk from 'chalk';
import { CredentialsManager } from '../auth/credentials';

export class FileUploader {
  private api: GenoBankAPIClient;
  private credManager: CredentialsManager;

  constructor() {
    this.api = GenoBankAPIClient.getInstance();
    this.credManager = CredentialsManager.getInstance();
  }

  async upload(
    filePath: string,
    options: {
      type?: string;
      tokenize?: boolean;
      shareWith?: string;
      showProgress?: boolean;
    } = {}
  ): Promise<{
    success: boolean;
    biocid?: string;
    ipId?: string;
  }> {
    // Check if file exists
    if (!await fs.pathExists(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const filename = path.basename(filePath);
    const fileSize = stats.size;
    const fileType = options.type || BioCIDParser.detectFileType(filename);

    // Get current wallet for BioCID
    const creds = await this.credManager.loadCredentials();
    if (!creds) {
      throw new Error('Not authenticated');
    }

    // Upload in chunks
    const chunkSize = CONFIG.CHUNK_SIZE;
    const totalChunks = Math.ceil(fileSize / chunkSize);

    let progressBar: cliProgress.SingleBar | null = null;
    if (options.showProgress !== false) {
      progressBar = new cliProgress.SingleBar({
        format: `📤 Uploading | ${chalk.cyan('{bar}')} | {percentage}% | Chunk {value}/{total}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
      });
      progressBar.start(totalChunks, 0);
    }

    const fileBuffer = await fs.readFile(filePath);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileSize);
      const chunk = fileBuffer.subarray(start, end);

      await this.api.uploadDatasetChunk(chunk, {
        filename,
        chunkIndex: i,
        totalChunks,
        fileType
      });

      if (progressBar) {
        progressBar.update(i + 1);
      }
    }

    if (progressBar) {
      progressBar.stop();
    }

    // Generate BioCID
    const biocid = BioCIDParser.generate(creds.wallet_address, filename);

    // Optionally tokenize
    let ipId: string | undefined;
    if (options.tokenize) {
      console.log('\n🔗 Minting NFT on Story Protocol...');
      try {
        const result = await this.api.mintVariantsStoryNFT({
          filename,
          collection_address: this.getCollectionForType(fileType)
        });
        ipId = result.ipId;
        console.log(chalk.green(`✅ NFT minted: ${ipId}`));
      } catch (error) {
        console.error(chalk.yellow('⚠️  NFT minting failed:', error));
      }
    }

    return {
      success: true,
      biocid,
      ipId
    };
  }

  private getCollectionForType(fileType: string): string {
    switch (fileType) {
      case 'vcf':
        return CONFIG.COLLECTIONS.VCF_COLLECTION;
      default:
        return CONFIG.COLLECTIONS.VCF_OWNERSHIP; // Default collection
    }
  }
}