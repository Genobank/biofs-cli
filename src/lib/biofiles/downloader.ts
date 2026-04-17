import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as cliProgress from 'cli-progress';
import { BioCIDResolver } from './resolver';
import { FileLocation } from '../../types/biofiles';
import { CONFIG } from '../config/constants';
import chalk from 'chalk';

export class FileDownloader {
  private resolver: BioCIDResolver;

  constructor() {
    this.resolver = new BioCIDResolver();
  }

  async download(
    biocidOrFilename: string,
    destination?: string,
    showProgress: boolean = true
  ): Promise<string> {
    // Resolve the file location
    const location = await this.resolver.resolve(biocidOrFilename);

    // Use original filename from server if available, otherwise extract from input
    const originalFilename = location.filename || path.basename(biocidOrFilename);

    // Determine output path
    let outputPath: string;
    if (destination) {
      if (await fs.pathExists(destination) && (await fs.stat(destination)).isDirectory()) {
        outputPath = path.join(destination, originalFilename);
      } else {
        outputPath = destination;
      }
    } else {
      const downloadDir = path.join(CONFIG.HOME_DIR, 'Downloads', 'genobank');
      await fs.ensureDir(downloadDir);
      outputPath = path.join(downloadDir, originalFilename);
    }

    // Download based on location type.
    // S3, GCS, and BioFS all present the same client-side interface — a
    // presigned URL to stream from. The storage backend is a server-side detail.
    switch (location.type) {
      case 'S3':
      case 'GCS':
      case 'BioFS':
        return await this.downloadFromPresignedUrl(location, outputPath, showProgress);
      case 'IPFS':
        return await this.downloadFromIPFS(location, outputPath, showProgress);
      case 'Sequentia':
        throw new Error('Direct download from Sequentia not yet implemented (use GCS/S3 backend)');
      default:
        throw new Error(`Unknown location type: ${location.type}`);
    }
  }

  /**
   * Stream a file from a presigned URL. Works transparently for S3 and GCS
   * since both use HTTPS + Range-capable responses.
   * Previously named `downloadFromS3`; renamed in 2.6.2 after GCS migration.
   */
  private async downloadFromPresignedUrl(
    location: FileLocation,
    outputPath: string,
    showProgress: boolean
  ): Promise<string> {
    if (!location.presigned_url) {
      throw new Error('No presigned URL available');
    }

    const response = await axios.get(location.presigned_url, {
      responseType: 'stream',
      timeout: 0 // No timeout for large files
    });

    const totalSize = parseInt(response.headers['content-length'] || '0', 10);
    const writer = fs.createWriteStream(outputPath);

    if (showProgress && totalSize > 0) {
      const progressBar = new cliProgress.SingleBar({
        format: `📥 Downloading | ${chalk.cyan('{bar}')} | {percentage}% | {value}/{total} bytes | {speed}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true
      });

      let downloadedSize = 0;
      let lastTime = Date.now();
      let lastSize = 0;

      progressBar.start(totalSize, 0, { speed: '0 B/s' });

      response.data.on('data', (chunk: Buffer) => {
        downloadedSize += chunk.length;

        const currentTime = Date.now();
        const timeDiff = (currentTime - lastTime) / 1000;
        if (timeDiff >= 0.5) { // Update speed every 0.5 seconds
          const sizeDiff = downloadedSize - lastSize;
          const speed = sizeDiff / timeDiff;
          const speedStr = this.formatBytes(speed) + '/s';
          progressBar.update(downloadedSize, { speed: speedStr });
          lastTime = currentTime;
          lastSize = downloadedSize;
        } else {
          progressBar.update(downloadedSize);
        }
      });

      return new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', () => {
          progressBar.stop();
          resolve(outputPath);
        });
        writer.on('error', (error: Error) => {
          progressBar.stop();
          reject(error);
        });
      });
    } else {
      return new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', () => resolve(outputPath));
        writer.on('error', reject);
      });
    }
  }

  private async downloadFromIPFS(
    location: FileLocation,
    outputPath: string,
    showProgress: boolean
  ): Promise<string> {
    if (!location.gateway_url) {
      throw new Error('No IPFS gateway URL available');
    }

    const response = await axios.get(location.gateway_url, {
      responseType: 'stream',
      timeout: 0
    });

    const writer = fs.createWriteStream(outputPath);

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', () => resolve(outputPath));
      writer.on('error', reject);
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

