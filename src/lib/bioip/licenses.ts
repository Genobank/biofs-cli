/**
 * Story Protocol PIL (Programmable IP License) mappings
 */

// PIL License types mapped to Story Protocol license IDs
export const LICENSE_TYPES: Record<string, string> = {
  'commercial': 'PIL_COMMERCIAL_REMIX',
  'non-commercial': 'PIL_NON_COMMERCIAL_REMIX',
  'research': 'PIL_NON_COMMERCIAL_REMIX',
  'clinical': 'PIL_COMMERCIAL_REMIX',
  'personal': 'PIL_NON_COMMERCIAL_REMIX'
};

// PIL License IDs from Story Protocol
export const PIL_LICENSE_IDS: Record<string, string> = {
  'PIL_COMMERCIAL_REMIX': '1',
  'PIL_NON_COMMERCIAL_REMIX': '2',
  'PIL_COMMERCIAL_NO_DERIVATIVES': '3',
  'PIL_NON_COMMERCIAL_NO_DERIVATIVES': '4'
};

// License descriptions
const LICENSE_DESCRIPTIONS: Record<string, string> = {
  'commercial': 'Allows commercial use with attribution and derivative works',
  'non-commercial': 'Non-commercial use only with attribution and derivative works',
  'research': 'For research purposes only, non-commercial',
  'clinical': 'Clinical and commercial use permitted',
  'personal': 'Personal use only, non-commercial'
};

/**
 * Get the PIL license type for a given license option
 */
export function getLicenseType(licenseOption: string): string {
  const normalized = licenseOption.toLowerCase().trim();

  // Direct match
  if (LICENSE_TYPES[normalized]) {
    return LICENSE_TYPES[normalized];
  }

  // Check for partial matches
  if (normalized.includes('commercial') && !normalized.includes('non')) {
    return LICENSE_TYPES['commercial'];
  }

  // Default to non-commercial
  return LICENSE_TYPES['non-commercial'];
}

/**
 * Get the PIL license ID for a license type
 */
export function getLicenseId(licenseType: string): string {
  return PIL_LICENSE_IDS[licenseType] || PIL_LICENSE_IDS['PIL_NON_COMMERCIAL_REMIX'];
}

/**
 * Get license description
 */
export function getLicenseDescription(licenseOption: string): string {
  const normalized = licenseOption.toLowerCase().trim();
  return LICENSE_DESCRIPTIONS[normalized] || LICENSE_DESCRIPTIONS['non-commercial'];
}

/**
 * Get license terms for display
 */
export function getLicenseTerms(licenseType: string): {
  commercialUse: boolean;
  derivativesAllowed: boolean;
  attributionRequired: boolean;
  shareAlike: boolean;
} {
  switch (licenseType) {
    case 'PIL_COMMERCIAL_REMIX':
      return {
        commercialUse: true,
        derivativesAllowed: true,
        attributionRequired: true,
        shareAlike: false
      };
    case 'PIL_NON_COMMERCIAL_REMIX':
      return {
        commercialUse: false,
        derivativesAllowed: true,
        attributionRequired: true,
        shareAlike: false
      };
    case 'PIL_COMMERCIAL_NO_DERIVATIVES':
      return {
        commercialUse: true,
        derivativesAllowed: false,
        attributionRequired: true,
        shareAlike: false
      };
    case 'PIL_NON_COMMERCIAL_NO_DERIVATIVES':
      return {
        commercialUse: false,
        derivativesAllowed: false,
        attributionRequired: true,
        shareAlike: false
      };
    default:
      return {
        commercialUse: false,
        derivativesAllowed: true,
        attributionRequired: true,
        shareAlike: false
      };
  }
}

/**
 * Validate license option
 */
export function isValidLicenseOption(option: string): boolean {
  const normalized = option.toLowerCase().trim();
  return Object.keys(LICENSE_TYPES).includes(normalized);
}

/**
 * Get all available license options for display
 */
export function getAvailableLicenses(): Array<{
  key: string;
  name: string;
  description: string;
  pilType: string;
}> {
  return [
    {
      key: 'non-commercial',
      name: 'Non-Commercial Remix',
      description: 'Non-commercial use with derivatives allowed',
      pilType: 'PIL_NON_COMMERCIAL_REMIX'
    },
    {
      key: 'commercial',
      name: 'Commercial Remix',
      description: 'Commercial use with derivatives allowed',
      pilType: 'PIL_COMMERCIAL_REMIX'
    },
    {
      key: 'research',
      name: 'Research Only',
      description: 'For research purposes only (non-commercial)',
      pilType: 'PIL_NON_COMMERCIAL_REMIX'
    },
    {
      key: 'clinical',
      name: 'Clinical Use',
      description: 'Clinical and commercial use permitted',
      pilType: 'PIL_COMMERCIAL_REMIX'
    },
    {
      key: 'personal',
      name: 'Personal Use',
      description: 'Personal use only (non-commercial)',
      pilType: 'PIL_NON_COMMERCIAL_REMIX'
    }
  ];
}