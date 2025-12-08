const { ethers } = require('ethers');

const CLARA_JOB_NFT_V2 = '0x9B70040299efd49C0BBC607395F92a9492DCcc20';
const BIONFT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const RPC = 'http://54.226.180.9:8545';
const MINTER_KEY = '***REMOVED***';

const FAMILY = [
  { serial: '56102007614180', name: 'Memo', role: 'father' },
  { serial: '56102007614196', name: 'Julieta', role: 'mother' },
  { serial: '56102007614194', name: 'Valeria', role: 'child' }
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(MINTER_KEY, provider);
  console.log('Wallet:', wallet.address);

  const bionft = new ethers.Contract(BIONFT, [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function serialToTokenId(string serial) view returns (uint256)',
    'function linkDerivative(uint256 parentTokenId, address derivativeContract, uint256 derivativeTokenId, string derivativeType, string description, bytes32 dataHash)',
    'function derivativeCount(uint256 tokenId) view returns (uint256)'
  ], wallet);

  const clara = new ethers.Contract(CLARA_JOB_NFT_V2, [
    'function mintJob(address to, string biosampleSerial, string vcfPath, string pipeline, string referenceGenome, bytes32 vcfHash, string metadataUri) returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function biosampleToTokenId(string biosample) view returns (uint256)'
  ], wallet);

  for (const member of FAMILY) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing ${member.name} (${member.serial})`);
    console.log('='.repeat(60));

    // Get BioNFT token ID
    const bionftTokenId = await bionft.serialToTokenId(member.serial);
    console.log(`BioNFT Token ID: ${bionftTokenId}`);

    // Check if already has Clara derivative linked
    const derivCount = await bionft.derivativeCount(bionftTokenId);
    console.log(`Existing derivatives: ${derivCount}`);

    // Check if Clara NFT already minted for this biosample
    const existingClaraTokenId = await clara.biosampleToTokenId(member.serial);
    console.log(`Existing ClaraJobNFT for biosample: ${existingClaraTokenId}`);

    let claraTokenId;

    if (existingClaraTokenId > 0n) {
      console.log(`ClaraJobNFT #${existingClaraTokenId} already exists, using it`);
      claraTokenId = existingClaraTokenId;
    } else {
      // Mint new ClaraJobNFT
      const bionftOwner = await bionft.ownerOf(bionftTokenId);
      const checksumOwner = ethers.getAddress(bionftOwner);

      const vcfPath = `s3://deepvariant-fastq-to-vcf-genobank.app/output/${member.serial}/${member.serial}.deepvariant.g.vcf`;
      const vcfHash = ethers.keccak256(ethers.toUtf8Bytes(vcfPath));

      const metadata = {
        name: `Clara DeepVariant VCF: ${member.serial}`,
        description: `DeepVariant variant calling results for ${member.name} (${member.role}) biosample ${member.serial}.`,
        image: 'https://genobank.io/images/clara-job-nft.png',
        attributes: [
          { trait_type: 'Biosample ID', value: member.serial },
          { trait_type: 'Name', value: member.name },
          { trait_type: 'Role', value: member.role },
          { trait_type: 'Pipeline', value: 'deepvariant' },
          { trait_type: 'Reference', value: 'hg38' },
          { trait_type: 'Parent BioNFT', value: `#${bionftTokenId}` }
        ]
      };
      const metadataUri = 'data:application/json;base64,' +
        Buffer.from(JSON.stringify(metadata)).toString('base64');

      console.log(`Minting ClaraJobNFT for ${member.name}...`);
      const mintTx = await clara.mintJob(
        checksumOwner,
        member.serial,
        vcfPath,
        'deepvariant',
        'hg38',
        vcfHash,
        metadataUri,
        { gasLimit: 1000000n }
      );
      const mintReceipt = await mintTx.wait();
      console.log(`Mint TX: ${mintReceipt.hash}`);

      const supply = await clara.totalSupply();
      claraTokenId = supply;
      console.log(`Minted ClaraJobNFT #${claraTokenId}`);
    }

    // Check if we need to link
    if (derivCount > 0n) {
      console.log('Derivative already linked, skipping...');
      continue;
    }

    // Link as derivative
    console.log(`Linking ClaraJobNFT #${claraTokenId} to BioNFT #${bionftTokenId}...`);

    const vcfPath = `s3://deepvariant-fastq-to-vcf-genobank.app/output/${member.serial}/${member.serial}.deepvariant.g.vcf`;
    const vcfHash = ethers.keccak256(ethers.toUtf8Bytes(vcfPath));

    const linkTx = await bionft.linkDerivative(
      bionftTokenId,
      CLARA_JOB_NFT_V2,
      claraTokenId,
      'clara_job',
      `Clara Parabricks DeepVariant VCF from ${member.name} (${member.role})`,
      vcfHash,
      { gasLimit: 500000n }
    );
    const linkReceipt = await linkTx.wait();
    console.log(`Link TX: ${linkReceipt.hash}`);
    console.log(`✓ ${member.name} complete!`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('All family members processed!');
  console.log('='.repeat(60));
}

main().catch(console.error);
