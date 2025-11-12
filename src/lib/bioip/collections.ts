/**
 * BioIP Collection mappings for Story Protocol
 */

// Collection addresses mapped by category
export const BIOIP_COLLECTIONS: Record<string, string> = {
  'genomic': '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5',
  'variant': '0x19A615224D03487AaDdC43e4520F9D83923d9512',
  'vcf': '0x19A615224D03487AaDdC43e4520F9D83923d9512',
  'alignment': '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269',
  'bam': '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269',
  'sam': '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269',
  'sequence': '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'fastq': '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'fasta': '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'annotation': '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'bed': '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'gff': '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171',
  'microarray': '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'snp': '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'gwas': '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'dtc': '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  '23andme': '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'ancestry': '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401',
  'medical_imaging': '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5',
  'medical': '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5',
  'dicom': '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5'
};

// IPFS images for each category - synchronized with bioip.js and api_bioip.py
// CRITICAL: Story Protocol REQUIRES IPFS URLs - external domain images are flagged as BAD_IMAGE
// Updated: October 5, 2025 - All CIDs verified and pinned on local ipfs.genobank.app node
const DEFAULT_IMAGES: Record<string, string> = {
  // Primary categories - pinned on local IPFS node
  'vcf': 'https://ipfs.genobank.app/ipfs/Qmctc6PAZoJcfpy27Fggzvq5bxnHoL2ZTCvXQ4Cj1jQYqy',
  'genomic': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'alphagenome': 'https://ipfs.genobank.app/ipfs/QmfBBByBE9gj5H99XYLGsuSz8RMQKKZzzTmbDA92mcgFWC',
  'newborn': 'https://ipfs.genobank.app/ipfs/QmVxBF6FNaqmbFEN5xbUxmoF43rWNedDXd3en8Z9PRhFnC',
  'llm': 'https://ipfs.genobank.app/ipfs/QmZT1rvf7uF8Aru8J4LZNgU3d3YUAQ8YKhXzbJR2SskCE8',
  'medical': 'https://ipfs.genobank.app/ipfs/QmcyV6Lw3vM6Zv7iymCoKPa39U6i99Zy25PsHe9BAVK8nz',
  'medical_imaging': 'https://ipfs.genobank.app/ipfs/QmcyV6Lw3vM6Zv7iymCoKPa39U6i99Zy25PsHe9BAVK8nz',
  'dicom': 'https://ipfs.genobank.app/ipfs/QmcyV6Lw3vM6Zv7iymCoKPa39U6i99Zy25PsHe9BAVK8nz',
  'microarray': 'https://ipfs.genobank.app/ipfs/QmYdZDWBmECcTrnZGWG9QKa316DZq9qz6cSPnGeqPkdByf',
  'snp': 'https://ipfs.genobank.app/ipfs/QmYdZDWBmECcTrnZGWG9QKa316DZq9qz6cSPnGeqPkdByf',
  'gwas': 'https://ipfs.genobank.app/ipfs/QmYdZDWBmECcTrnZGWG9QKa316DZq9qz6cSPnGeqPkdByf',
  '23andme': 'https://ipfs.genobank.app/ipfs/QmYdZDWBmECcTrnZGWG9QKa316DZq9qz6cSPnGeqPkdByf',
  'ancestry': 'https://ipfs.genobank.app/ipfs/QmYdZDWBmECcTrnZGWG9QKa316DZq9qz6cSPnGeqPkdByf',
  'dtc': 'https://ipfs.genobank.app/ipfs/QmYdZDWBmECcTrnZGWG9QKa316DZq9qz6cSPnGeqPkdByf',

  // Additional categories - use genomic placeholder for now
  'variant': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'alignment': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'bam': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'sam': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'sequence': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'fastq': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'fasta': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'annotation': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'bed': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'gff': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
  'gff3': 'https://ipfs.genobank.app/ipfs/QmP3iuWxFraZJpaMdLWHneBqz7C6HakTm9ppVdzYzsWc2W',
};

/**
 * Get the Story Protocol collection address for a category
 */
export function getCollectionForCategory(category: string): string {
  const normalizedCategory = category.toLowerCase().trim();

  // Direct match
  if (BIOIP_COLLECTIONS[normalizedCategory]) {
    return BIOIP_COLLECTIONS[normalizedCategory];
  }

  // Check for partial matches
  for (const [key, address] of Object.entries(BIOIP_COLLECTIONS)) {
    if (normalizedCategory.includes(key) || key.includes(normalizedCategory)) {
      return address;
    }
  }

  // Default to genomic collection
  return BIOIP_COLLECTIONS['genomic'];
}

/**
 * Get the default image URL for a category
 */
export function getDefaultImageForCategory(category: string): string {
  const normalizedCategory = category.toLowerCase().trim();

  // Direct match
  if (DEFAULT_IMAGES[normalizedCategory]) {
    return DEFAULT_IMAGES[normalizedCategory];
  }

  // Check for partial matches
  for (const [key, url] of Object.entries(DEFAULT_IMAGES)) {
    if (normalizedCategory.includes(key) || key.includes(normalizedCategory)) {
      return url;
    }
  }

  // Default to genomic image
  return DEFAULT_IMAGES['genomic'];
}

/**
 * Get collection metadata
 */
export function getCollectionMetadata(address: string): {
  name: string;
  symbol: string;
  category: string;
} {
  const collectionInfo: Record<string, { name: string; symbol: string; category: string }> = {
    '0x5021F7438ea502b0c346cB59F8E92B749Ecd74B5': {
      name: 'BioNFT Ownership IP Assets',
      symbol: 'OWNERSHIP',
      category: 'genomic'
    },
    '0x19A615224D03487AaDdC43e4520F9D83923d9512': {
      name: 'VCF IP Assets',
      symbol: 'VCF',
      category: 'vcf'
    },
    '0xB8d03f2E1C02e4cC5b5fe1613c575c01BDD12269': {
      name: 'VCF Annotation IP Assets',
      symbol: 'VCFANNOTATION',
      category: 'alignment'
    },
    '0x88Ed5b47ea8f609Ee14ac60968C3f76f9138a171': {
      name: 'AlphaGenome AI IP Assets',
      symbol: 'AGENOME',
      category: 'sequence'
    },
    '0x29853ed299B8FBBe16568840F3Bb2A8E40dc7401': {
      name: 'SNP/Microarray IP Assets',
      symbol: 'SNP',
      category: 'microarray'
    },
    '0x495B1E8C54b572d78B16982BFb97908823C9358A': {
      name: 'VCF Analyst IP Assets',
      symbol: 'VCFANALYST',
      category: 'analysis'
    }
  };

  return collectionInfo[address] || {
    name: 'Custom Collection',
    symbol: 'CUSTOM',
    category: 'genomic'
  };
}

/**
 * Validate if an address is a known BioIP collection
 */
export function isValidCollection(address: string): boolean {
  const knownCollections = new Set(Object.values(BIOIP_COLLECTIONS));
  return knownCollections.has(address);
}