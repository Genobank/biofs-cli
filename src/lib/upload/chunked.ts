import { readFile } from 'fs/promises';
import FormData from 'form-data';
import axios from 'axios';
import { API_CONFIG } from '../config/constants';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

export interface ChunkedUploadOptions {
  filePath: string;
  fileName: string;
  userSignature: string;
  userWallet: string;
  service?: string;
  onProgress?: (percent: number, chunkNumber: number, totalChunks: number) => void;
}

export interface ChunkedUploadResult {
  s3_path: string;
  filename: string;
  file_size: number;
  status: string;
}

/**
 * Upload a file in chunks to bypass Cloudflare size limits
 */
export async function chunkedUpload(options: ChunkedUploadOptions): Promise<ChunkedUploadResult> {
  const {
    filePath,
    fileName,
    userSignature,
    userWallet,
    service = 'BIOIP',
    onProgress
  } = options;

  // Read the entire file
  const fileBuffer = await readFile(filePath);
  const fileSize = fileBuffer.length;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

  // Upload metadata
  const uploadData = {
    filename: fileName,
    extension: fileName.split('.').pop(),
    userAddress: userWallet,
    userSignature,
    service
  };

  let finalResult: ChunkedUploadResult | null = null;

  for (let chunkNumber = 1; chunkNumber <= totalChunks; chunkNumber++) {
    const start = (chunkNumber - 1) * CHUNK_SIZE;
    const end = Math.min(fileSize, start + CHUNK_SIZE);
    const chunk = fileBuffer.slice(start, end);

    const formData = new FormData();
    // Append chunk as a file with a filename (3rd parameter is filename)
    formData.append('chunk', chunk, fileName);
    formData.append('chunkNumber', chunkNumber.toString());
    formData.append('totalChunks', totalChunks.toString());
    formData.append('data', JSON.stringify(uploadData));

    if (process.env.DEBUG) {
      console.log(`[ChunkedUpload] Chunk ${chunkNumber}/${totalChunks}:`, {
        chunkSize: chunk.length,
        fileName,
        uploadData
      });
    }

    const response = await axios.post(
      `${API_CONFIG.base}/upload_dataset_chunk`,
      formData,
      {
        headers: {
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    if (process.env.DEBUG) {
      console.log(`[ChunkedUpload] Response ${chunkNumber}:`, response.data);
    }

    if (response.data.status === 'OK' && chunkNumber === totalChunks) {
      finalResult = {
        filename: fileName,
        s3_path: response.data.s3_path || `users/${userWallet}/${fileName}`,
        file_size: fileSize,
        status: 'Success'
      };
    }

    // Call progress callback
    if (onProgress) {
      const percent = Math.round((chunkNumber / totalChunks) * 100);
      onProgress(percent, chunkNumber, totalChunks);
    }
  }

  if (!finalResult) {
    throw new Error('Chunked upload failed - no final result received');
  }

  return finalResult;
}


