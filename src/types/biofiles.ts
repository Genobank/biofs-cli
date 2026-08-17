export interface BioCID {
  wallet: string;
  type: string;
  identifier: string;
  fullCID: string;
  /** Bioagent / lab prefix on the canonical 4-part form. */
  lab?: string;
}

/**
 * Storage backend the asset lives on.
 * BioFS = BioNFT-Gated storage protocol (S3 or GCS).
 * GCS added v2.6.2 (April 2026 AWS→GCS migration).
 * S3 retained for backwards-compat during the transition; new writes go to GCS.
 */
export type StorageSource =
  | 'S3'
  | 'GCS'
  | 'BioFS'
  | 'IPFS'
  | 'Sequentia'
  | 'Avalanche'
  | 'BioRouter';

export interface BioFile {
  filename: string;
  biocid: string;
  type: string;
  size?: number;
  source: StorageSource;
  created_at?: string;
  ip_asset?: string;
  /** Legacy path field. Populated by older backends and for files still on AWS S3. */
  s3_path?: string;
  /** Preferred path field since the April 2026 GCS migration. */
  gcs_path?: string;
  ipfs_hash?: string;
  presigned_url?: string;
  granted?: boolean;       // True if access granted via license token
  owner?: string;          // Owner wallet (for granted files)
  license_type?: string;   // License type (for granted files)
}

export interface FileLocation {
  type: StorageSource;
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
