export interface BioCID {
  wallet: string;
  type: string;
  identifier: string;
  fullCID: string;
}

export interface BioFile {
  filename: string;
  biocid: string;
  type: string;
  size?: number;
  source: 'S3' | 'BioFS' | 'IPFS' | 'Sequentia' | 'Avalanche';  // BioFS = BioNFT-Gated S3 protocol
  created_at?: string;
  ip_asset?: string;
  s3_path?: string;
  ipfs_hash?: string;
  presigned_url?: string;
  granted?: boolean;       // True if access granted via license token
  owner?: string;          // Owner wallet (for granted files)
  license_type?: string;   // License type (for granted files)
}

export interface FileLocation {
  type: 'S3' | 'BioFS' | 'IPFS' | 'Sequentia' | 'Avalanche';  // BioFS = BioNFT-Gated S3 protocol
  path?: string;
  bucket?: string;
  presigned_url?: string;
  hash?: string;
  gateway_url?: string;
  ip_id?: string;
  metadata_uri?: string;
  filename?: string;

  // GDPR consent metadata (for genomic data access)
  owner?: string;              // Data owner wallet address
  license_type?: string;       // License type (non-commercial, commercial, etc.)
  license_token_id?: number;   // License token ID
}

