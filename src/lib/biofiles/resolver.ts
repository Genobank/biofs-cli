import { BioCIDParser } from './biocid';
import { GenoBankAPIClient } from '../api/client';
import { FuseAPIClient } from '../api/fuse-client';
import { CredentialsManager } from '../auth/credentials';
import { FileLocation, BioFile } from '../../types/biofiles';
import { CONFIG } from '../config/constants';
import { Logger } from '../utils/logger';

export class BioCIDResolver {
  private api: GenoBankAPIClient;

  constructor() {
    this.api = GenoBankAPIClient.getInstance();
  }

  async resolve(biocidOrFilename: string): Promise<FileLocation> {
    let searchIdentifier: string;

    // Check if it's an IP Asset ID (starts with 0x and 42 chars)
    if (biocidOrFilename.startsWith('0x') && biocidOrFilename.length === 42) {
      Logger.debug(`Detected IP Asset ID: ${biocidOrFilename}`);
      try {
        Logger.debug('Calling getBioIPDownloadURL API...');
        const downloadInfo = await this.api.getBioIPDownloadURL(biocidOrFilename);
        Logger.debug(`API Response: ${JSON.stringify(downloadInfo, null, 2)}`);

        if (!downloadInfo.access_granted) {
          throw new Error(downloadInfo.reason || 'Access denied to this BioIP asset');
        }

        Logger.debug(`Access granted! Filename: ${downloadInfo.filename}`);

        // Use stream endpoint with IP Asset validation
        let streamUrl = downloadInfo.presigned_url;
        if (!streamUrl || streamUrl.includes('/get_presigned_link')) {
          const signature = await this.api.getSignature();
          // Include ip_asset_id for mainnet validation
          streamUrl = `${CONFIG.API_BASE_URL}/api_vcf_annotator/stream_s3_file?user_signature=${encodeURIComponent(signature)}&file_path=${encodeURIComponent(downloadInfo.s3_path)}&ip_asset_id=${encodeURIComponent(biocidOrFilename)}`;
          Logger.debug(`Using stream URL with IP validation: ${streamUrl}`);
        }

        return {
          type: 'S3',
          path: downloadInfo.s3_path,
          bucket: 'test.vault.genoverse.io',
          presigned_url: streamUrl,
          filename: downloadInfo.filename,
          // GDPR consent metadata
          ip_id: biocidOrFilename,
          owner: downloadInfo.owner,
          license_type: downloadInfo.license_type,
          license_token_id: downloadInfo.license_token_id
        };
      } catch (error: any) {
        Logger.debug(`Error details: ${error}`);
        Logger.debug(`Error message: ${error.message}`);
        Logger.debug(`Error response: ${JSON.stringify(error.response?.data)}`);
        throw new Error(`Failed to access IP Asset: ${error.message || error}`);
      }
    }

    // Check if it's a BioCID
    const biocid = BioCIDParser.parse(biocidOrFilename);
    if (biocid) {
      searchIdentifier = biocid.identifier;
    } else {
      searchIdentifier = biocidOrFilename;
    }

    // Get user's files
    const files = await this.api.getMyUploadedFilesUrls();

    // Find the file
    const file = files.find(f =>
      f.filename === searchIdentifier ||
      f.original_name === searchIdentifier ||
      f.file_path?.includes(searchIdentifier) ||
      (biocid && f.biocid === biocid.fullCID)
    );

    if (!file) {
      throw new Error(`File not found: ${biocidOrFilename}`);
    }

    // Resolve to storage location
    if (file.s3_path) {
      // Use the working stream endpoint instead of broken presigned link
      let streamUrl = file.presigned_url;
      if (!streamUrl) {
        const signature = await this.api.getSignature();
        // Construct stream URL like OpenCRAVAT does
        streamUrl = `${CONFIG.API_BASE_URL}/api_vcf_annotator/stream_s3_file?user_signature=${encodeURIComponent(signature)}&file_path=${encodeURIComponent(file.s3_path)}`;
        Logger.debug(`Using stream URL: ${streamUrl}`);
      }

      return {
        type: 'S3',
        path: file.s3_path,
        bucket: file.bucket || 'vault.genobank.io',
        presigned_url: streamUrl
      };
    }

    if (file.ipfs_hash) {
      return {
        type: 'IPFS',
        hash: file.ipfs_hash,
        gateway_url: `${CONFIG.IPFS_GATEWAY}/${file.ipfs_hash}`
      };
    }

    if (file.ip_id) {
      return {
        type: 'Sequentia',
        ip_id: file.ip_id,
        metadata_uri: undefined // Would need separate API call
      };
    }

    throw new Error(`No storage location found for: ${biocidOrFilename}`);
  }

  async discoverAllBioFiles(verbose: boolean = false): Promise<BioFile[]> {
    const bioFiles: BioFile[] = [];

    // Data Source 1: Sequentia IP Assets (includes BioIP files registered on Sequentia)
    try {
      if (verbose) console.log('🔍 Fetching Sequentia assets...');
      const ipAssets = await this.api.getStoryIPAssets();
      if (verbose) console.log(`✅ Found ${ipAssets.length} Sequentia assets`);

      for (const asset of ipAssets) {
        // Extract meaningful filename from metadata
        const filename = asset.metadata?.name ||
                        asset.filename ||
                        asset.original_filename ||
                        `IP Asset ${asset.ipId?.slice(0, 8)}...`;

        const fileType = asset.file_type ||
                        asset.type ||
                        BioCIDParser.detectFileType(filename);

        bioFiles.push({
          filename,
          biocid: `biocid://${asset.owner || asset.wallet_address || 'unknown'}/sequentia/${asset.ipId}`,
          type: fileType,
          source: 'Sequentia',
          created_at: asset.created_at,
          ip_asset: asset.ipId,
          s3_path: asset.s3_path,
          ipfs_hash: asset.ipfs_hash
        });
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching Sequentia assets:', error);
    }

    // Data Source 2: Avalanche Biosamples
    try {
      if (verbose) console.log('🔍 Fetching Avalanche biosamples...');
      const avalancheBiosamples = await this.api.getAvalancheBiosamples();
      if (verbose) console.log(`✅ Found ${avalancheBiosamples.length} Avalanche biosamples`);

      for (const biosample of avalancheBiosamples) {
        bioFiles.push({
          filename: biosample.name || `Biosample #${biosample.serial}`,
          biocid: `biocid://${biosample.owner_address}/avalanche/${biosample.serial}`,
          type: 'biosample',
          source: 'Avalanche',
          created_at: biosample.created_at,
          // Avalanche biosamples may have associated files
          s3_path: biosample.file_path
        });
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching Avalanche biosamples:', error);
    }

    // Data Source 3: S3 Uploaded Files (non-Story Protocol files)
    try {
      if (verbose) console.log('🔍 Fetching S3 uploaded files...');
      const s3Files = await this.api.getMyUploadedFilesUrls();
      if (verbose) console.log(`✅ Found ${s3Files.length} S3 files`);

      for (const file of s3Files) {
        const filename = file.original_name || file.filename || 'unknown';
        const type = BioCIDParser.detectFileType(filename);
        bioFiles.push({
          filename,
          biocid: file.biocid || BioCIDParser.generate('unknown', filename),
          type,
          size: file.size,
          source: 'S3',
          created_at: file.created_at,
          s3_path: file.s3_path || file.path,
          presigned_url: file.presigned_url
        });
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching S3 files:', error);
    }

    // Data Source 4: Granted BioIP files (via license tokens)
    try {
      if (verbose) console.log('🔍 Fetching granted BioIP files...');
      const grantedBioips = await this.api.getMyGrantedBioIPs();
      if (verbose) console.log(`✅ Found ${grantedBioips.length} granted BioIP files`);

      for (const bioip of grantedBioips) {
        if (bioip.s3_path || bioip.ipfs_hash) {
          bioFiles.push({
            filename: (bioip.filename || 'Granted BioIP') + ' 🔑',
            biocid: `biocid://${bioip.owner}/bioip/${bioip.ip_id}`,
            type: bioip.file_category || bioip.type || 'bioip',
            source: 'BioFS',  // BioNFT-Gated S3
            created_at: bioip.granted_at,
            s3_path: bioip.s3_path,
            ipfs_hash: bioip.ipfs_hash,
            ip_asset: bioip.ip_id,
            granted: true,
            owner: bioip.owner,
            license_type: bioip.license_type
          });
        }
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching granted BioIP files:', error);
    }

    // Data Source 5: BioNFT-gated FUSE files (via BioFS FUSE API)
    try {
      if (verbose) console.log('🔍 Fetching BioNFT-gated FUSE files...');
      const credManager = CredentialsManager.getInstance();
      const creds = await credManager.loadCredentials();

      if (creds && creds.wallet_address && creds.user_signature) {
        const fuseClient = new FuseAPIClient();
        const fuseFiles = await fuseClient.getAllFiles(creds.wallet_address, creds.user_signature);

        let totalFuseFiles = 0;
        for (const biosample of fuseFiles) {
          for (const filename of biosample.files) {
            const type = BioCIDParser.detectFileType(filename);
            bioFiles.push({
              filename: filename + ' 🔐',  // Lock emoji indicates BioNFT-gated
              biocid: `biocid://${creds.wallet_address}/fuse/${biosample.biosample}/${filename}`,
              type,
              source: 'BioFS',  // BioNFT-Gated via FUSE
              granted: true,
              owner: biosample.biosample,  // Store biosample serial as owner
              created_at: new Date().toISOString()
            });
            totalFuseFiles++;
          }
        }

        if (verbose) console.log(`✅ Found ${totalFuseFiles} BioNFT-gated FUSE files across ${fuseFiles.length} biosamples`);
      } else {
        if (verbose) console.log('⚠️ Skipping FUSE files (no credentials)');
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching FUSE files:', error);
    }

    if (verbose) console.log(`\n📊 Total BioFiles discovered: ${bioFiles.length}`);
    return bioFiles;
  }
}

