export interface ApiResponse<T = any> {
  status: 'Success' | 'Failure';
  status_details?: {
    message: string;
    description?: string;
    data?: T;
  };
}

export interface FileInfo {
  filename: string;
  file_path?: string;
  s3_path?: string;
  ipfs_hash?: string;
  ip_id?: string;
  size?: number;
  created_at?: string;
  file_type?: string;
  bucket?: string;
  biocid?: string;
}

export interface FileWithURL extends FileInfo {
  presigned_url?: string;
  download_url?: string;
  original_name?: string;
  path?: string;
  extension?: string;
  type?: string;
}

export interface IPAsset {
  ipId: string;
  owner: string;
  wallet_address?: string;
  metadata_uri?: string;
  metadata?: {
    name?: string;
    description?: string;
    image?: string;
    [key: string]: any;
  };
  nft_id?: string;
  token_id?: number;
  created_at?: string;
  collection?: string;
  collection_address?: string;
  filename?: string;
  original_filename?: string;
  file_type?: string;
  type?: string;
  s3_path?: string;
  ipfs_hash?: string;
  source?: string;
  chain?: string;
}

export interface Biosample {
  biosample_serial: string;
  owner_address?: string;
  created_at?: string;
  status?: string;
  metadata?: any;
}

