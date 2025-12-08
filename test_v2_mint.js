const { ethers } = require('ethers');

const CLARA_JOB_NFT_V2 = '0x9B70040299efd49C0BBC607395F92a9492DCcc20';
const BIONFT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const RPC = 'http://54.226.180.9:8545';
const MINTER_KEY = '0xfaa9148191dfcb99dc713f2652315b09df590a59e07c78a8d59c288d7f4a5013';

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(MINTER_KEY, provider);
  console.log('Wallet:', wallet.address);

  // Get BioNFT owner for Memo (token #2)
  const bionft = new ethers.Contract(BIONFT, [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function serialToTokenId(string serial) view returns (uint256)'
  ], provider);

  const tokenId = await bionft.serialToTokenId('56102007614180');
  console.log('Memo BioNFT Token ID:', tokenId.toString());

  const bionftOwner = await bionft.ownerOf(tokenId);
  const checksumOwner = ethers.getAddress(bionftOwner);
  console.log('Memo BioWallet:', checksumOwner);

  // ClaraJobNFT V2 contract
  const claraAbi = [
    'function mintJob(address to, string biosampleSerial, string vcfPath, string pipeline, string referenceGenome, bytes32 vcfHash, string metadataUri) returns (uint256)',
    'function safeMint(address to, string uri) returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function owner() view returns (address)'
  ];
  const clara = new ethers.Contract(CLARA_JOB_NFT_V2, claraAbi, wallet);

  const owner = await clara.owner();
  console.log('Contract owner:', owner);
  console.log('Wallet is owner:', owner.toLowerCase() === wallet.address.toLowerCase());

  // Prepare mint data
  const biosampleSerial = '56102007614180';
  const vcfPath = 's3://deepvariant-fastq-to-vcf-genobank.app/output/56102007614180/56102007614180.deepvariant.g.vcf';
  const pipeline = 'deepvariant';
  const referenceGenome = 'hg38';
  const vcfHash = ethers.keccak256(ethers.toUtf8Bytes(vcfPath));

  const metadata = {
    name: 'Clara DeepVariant VCF: 56102007614180',
    description: 'DeepVariant variant calling results for Memo'
  };
  const metadataUri = 'data:application/json;base64,' +
    Buffer.from(JSON.stringify(metadata)).toString('base64');

  console.log('\nMinting with:');
  console.log('  to:', checksumOwner);
  console.log('  biosampleSerial:', biosampleSerial);
  console.log('  vcfPath:', vcfPath.slice(0, 50) + '...');
  console.log('  vcfHash:', vcfHash);

  // Try mintJob
  try {
    console.log('\n--- Trying mintJob ---');
    const tx = await clara.mintJob(
      checksumOwner,
      biosampleSerial,
      vcfPath,
      pipeline,
      referenceGenome,
      vcfHash,
      metadataUri,
      { gasLimit: 1000000n }
    );
    console.log('TX sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('TX status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');

    const supply = await clara.totalSupply();
    console.log('New total supply:', supply.toString());
  } catch (e) {
    console.log('mintJob error:', e.message);
  }

  // Try safeMint as fallback
  try {
    console.log('\n--- Trying safeMint ---');
    const tx = await clara.safeMint(
      checksumOwner,
      metadataUri,
      { gasLimit: 500000n }
    );
    console.log('TX sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('TX status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');

    const supply = await clara.totalSupply();
    console.log('New total supply:', supply.toString());
  } catch (e) {
    console.log('safeMint error:', e.message);
  }
}

main().catch(console.error);
