import { BioCIDParser } from './biocid';
import { GenoBankAPIClient } from '../api/client';
import { FuseAPIClient } from '../api/fuse-client';
import { CredentialsManager } from '../auth/credentials';
import { FileLocation, BioFile } from '../../types/biofiles';
import { CONFIG } from '../config/constants';
import { Logger } from '../utils/logger';
import { BioRoutesClient, biocidToKey } from '../bioroutes/client';

export class BioCIDResolver {
  private api: GenoBankAPIClient;

  constructor() {
    this.api = GenoBankAPIClient.getInstance();
  }

  async resolve(biocidOrFilename: string): Promise<FileLocation> {
    let searchIdentifier: string;

    // G.2 BioRoutes-first: attempt on-chain resolution before legacy paths.
    // BioRoutes resolves biocid:// URIs and plain biocid strings to GCS storage URIs
    // anchored on Sequentia. Falls through to legacy on miss (during parallel window).
    if (biocidOrFilename.startsWith('biocid://') || biocidOrFilename.includes('/')) {
      try {
        const bioRoutesClient = new BioRoutesClient();
        const result = await bioRoutesClient.resolveBiocid(biocidOrFilename);
        if (result.primary) {
          Logger.debug(`BioRoutes hit: ${result.primary.storageURI} (${result.routeCount} routes)`);
          const uri = result.primary.storageURI;
          const isGCS = uri.startsWith('gs://');
          const parts = isGCS ? uri.replace('gs://', '').split('/') : [];
          const bucket = isGCS ? parts[0] : undefined;
          const objectPath = isGCS ? parts.slice(1).join('/') : uri;

          let presignedUrl: string | undefined;
          try {
            presignedUrl = (await bioRoutesClient.getPresignedUrl(uri)) || undefined;
          } catch { /* presign is best-effort */ }

          return {
            type: isGCS ? 'GCS' : 'S3',
            path: objectPath,
            bucket,
            presigned_url: presignedUrl,
            filename: objectPath?.split('/').pop(),
          };
        }
      } catch (err: any) {
        Logger.debug(`BioRoutes lookup failed (falling through): ${err.message}`);
      }
    }

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

        // GCS migration (v2.6.2): prefer gcs_path when backend returns it,
        // fall back to legacy s3_path. Backend's stream endpoint name
        // (`stream_s3_file`) is a stable URL contract — it now streams from GCS
        // server-side even though the name is legacy.
        const storagePath: string | undefined =
          downloadInfo.gcs_path || downloadInfo.s3_path;
        const storageType: 'GCS' | 'S3' =
          downloadInfo.gcs_path ? 'GCS' : 'S3';

        // Use stream endpoint with IP Asset validation
        let streamUrl = downloadInfo.presigned_url;
        if (!streamUrl || streamUrl.includes('/get_presigned_link')) {
          const signature = await this.api.getSignature();
          // Include ip_asset_id for mainnet validation
          streamUrl = `${CONFIG.API_BASE_URL}/api_vcf_annotator/stream_s3_file?user_signature=${encodeURIComponent(signature)}&file_path=${encodeURIComponent(storagePath || '')}&ip_asset_id=${encodeURIComponent(biocidOrFilename)}`;
          Logger.debug(`Using stream URL with IP validation: ${streamUrl}`);
        }

        return {
          type: storageType,
          path: storagePath,
          bucket: downloadInfo.bucket || (storageType === 'GCS' ? 'genobank-biorouter' : 'test.vault.genoverse.io'),
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

    // Resolve to storage location — GCS preferred, S3 legacy-compat.
    const storagePath: string | undefined = file.gcs_path || file.s3_path;
    if (storagePath) {
      const storageType: 'GCS' | 'S3' = file.gcs_path ? 'GCS' : 'S3';
      // Use the working stream endpoint instead of broken presigned link.
      // `stream_s3_file` name is legacy URL contract; backend now streams from GCS.
      let streamUrl = file.presigned_url;
      if (!streamUrl) {
        const signature = await this.api.getSignature();
        streamUrl = `${CONFIG.API_BASE_URL}/api_vcf_annotator/stream_s3_file?user_signature=${encodeURIComponent(signature)}&file_path=${encodeURIComponent(storagePath)}`;
        Logger.debug(`Using stream URL: ${streamUrl}`);
      }

      return {
        type: storageType,
        path: storagePath,
        bucket: file.bucket || (storageType === 'GCS' ? 'genobank-biorouter' : 'vault.genobank.io'),
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

  async discoverAllBioFiles(verbose: boolean = false, targetOwner?: string): Promise<BioFile[]> {
    const bioFiles: BioFile[] = [];

    // The caller's wallet — always known post-login, always a valid fallback
    // origin for any BioNFT we list. BioRouter's role as the "source of truth
    // of biodata origin" is defeated if we ever emit `biocid://unknown/...`,
    // so every resolution below MUST prefer (in order):
    //   1. the on-chain collection contract address for the asset, if present,
    //   2. the asset's owner wallet from the backend response,
    //   3. the caller's own wallet (always ≥ cryptographic proof of custody).
    // If none of the three are available we LOG LOUDLY and tag the biocid
    // with `resolver_err/<reason>` so the bug is discoverable downstream
    // instead of silently producing `unknown`.
    let callerWallet = '';
    try {
      const credManager = CredentialsManager.getInstance();
      const creds = await credManager.loadCredentials();
      callerWallet = (creds?.wallet_address || '').toLowerCase();
    } catch { /* stays empty */ }

    const originFor = (asset: any, hint?: string): string => {
      const candidates = [
        asset?.collection_address,
        asset?.collection?.address,
        asset?.ip_metadata?.collection,
        asset?.nft_contract,
        asset?.contract_address,
        asset?.owner,
        asset?.wallet_address,
        asset?.owner_address,
        callerWallet,
      ];
      for (const c of candidates) {
        if (typeof c === 'string' && c.startsWith('0x') && c.length === 42) {
          return c.toLowerCase();
        }
      }
      const reason = hint || 'no-owner-no-collection';
      Logger.debug(`BioCID origin fallback failed (${reason}); tagging as resolver_err`);
      return `resolver_err/${reason}`;
    };

    // Data Sources 1-5 are scoped to the CALLER's own signature, so they only
    // describe the caller's own files. For an admin "--wallet <other>" view we
    // run ONLY the BioRouter inventory source (6), which can target any owner.
    if (!targetOwner) {
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
          biocid: `biocid://${originFor(asset, 'sequentia-asset')}/sequentia/${asset.ipId}`,
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

    // Data Source 3: Uploaded Files (GCS since April 2026; S3 before).
    // Backend field name is still `s3_path` (legacy API contract); we also
    // honor `gcs_path` if the backend has been updated to emit it.
    try {
      if (verbose) console.log('🔍 Fetching uploaded files...');
      const uploadedFiles = await this.api.getMyUploadedFilesUrls();
      if (verbose) console.log(`✅ Found ${uploadedFiles.length} uploaded files`);

      for (const file of uploadedFiles) {
        const filename = file.original_name || file.filename || 'unknown';
        const type = BioCIDParser.detectFileType(filename);
        const gcsPath = (file as any).gcs_path;
        const s3Path = file.s3_path;
        // The caller uploaded this file, so the caller's wallet is the canonical
        // origin when the backend didn't stamp an explicit biocid. Never fall
        // back to 'unknown' — BioRouter is an oracle, not an amnesia.
        const uploaderWallet = callerWallet || originFor(file, 'uploaded-file');
        bioFiles.push({
          filename,
          biocid: file.biocid || BioCIDParser.generate(uploaderWallet, filename),
          type,
          size: file.size,
          source: gcsPath ? 'GCS' : 'S3',
          created_at: file.created_at,
          gcs_path: gcsPath,
          s3_path: s3Path || file.path,
          presigned_url: file.presigned_url
        });
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching uploaded files:', error);
    }

    // Data Source 4: Granted BioIP files (via license tokens)
    try {
      if (verbose) console.log('🔍 Fetching granted BioIP files...');
      const grantedBioips = await this.api.getMyGrantedBioIPs();
      if (verbose) console.log(`✅ Found ${grantedBioips.length} granted BioIP files`);

      for (const bioip of grantedBioips) {
        if (bioip.s3_path || bioip.gcs_path || bioip.ipfs_hash) {
          bioFiles.push({
            filename: (bioip.filename || 'Granted BioIP') + ' 🔑',
            biocid: `biocid://${bioip.owner}/bioip/${bioip.ip_id}`,
            type: bioip.file_category || bioip.type || 'bioip',
            source: 'BioFS',  // BioNFT-Gated storage (GCS since April 2026)
            created_at: bioip.granted_at,
            gcs_path: bioip.gcs_path,
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
    } // end caller-own sources (1-5)

    // Data Source 6: BioRouter inventory (bioroutes.inventory) — the protocol's
    // own lineage source of truth. Surfaces files instantiated in the biorouter
    // (and now on Sequentia via `biofs route anchor`) even before they're minted
    // as Story IP assets. With targetOwner set (admin --wallet) it lists that
    // owner's files; otherwise the caller's. biofs-node enforces the admin gate.
    try {
      if (verbose) console.log('🔍 Fetching BioRouter inventory...');
      const inv = await this.api.getBioRouterInventory(targetOwner);
      if (verbose) console.log(`✅ Found ${inv.length} BioRouter files`);

      for (const row of inv) {
        const owner = String(row.owner_wallet || targetOwner || callerWallet || '').toLowerCase();
        const objName: string = row.object_name || '';
        const filename = row.biofile || (objName ? objName.split('/').pop() : '') || row.biocid || 'unknown';
        bioFiles.push({
          filename,
          biocid: row.biocid || `biocid://${owner || 'resolver_err/no-owner'}/biorouter/${row.sample_serial || 'na'}`,
          type: row.filetype || row.file_type_guess || BioCIDParser.detectFileType(filename),
          source: 'BioRouter',
          size: row.size_bytes,
          created_at: row.time_created,
          owner: owner || undefined,
        });
      }
    } catch (error) {
      if (verbose) console.error('❌ Error fetching BioRouter inventory:', error);
    }

    if (verbose) console.log(`\n📊 Total BioFiles discovered: ${bioFiles.length}`);
    return bioFiles;
  }
}

