const { ethers } = require('ethers');

const CLARA_JOB_NFT = '0xdCd99012D796A4b250386cD6AcF5386316A8c3f8';
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

  const owner = await bionft.ownerOf(tokenId);
  console.log('Memo BioWallet (raw):', owner);

  // Checksum address properly
  const checksumOwner = ethers.getAddress(owner);
  console.log('Memo BioWallet (checksum):', checksumOwner);

  // ClaraJobNFT contract
  const claraAbi = [
    'function safeMint(address to, string uri)',
    'function totalSupply() view returns (uint256)'
  ];
  const clara = new ethers.Contract(CLARA_JOB_NFT, claraAbi, wallet);

  // Try to mint
  const metadata = {
    name: 'Clara Genomics Job: 56102007614180',
    description: 'DeepVariant VCF for Memo biosample'
  };
  const metadataUri = 'data:application/json;base64,' +
    Buffer.from(JSON.stringify(metadata)).toString('base64');

  console.log('\nMinting ClaraJobNFT to:', checksumOwner);

  try {
    const tx = await clara.safeMint(checksumOwner, metadataUri, {
      gasLimit: 500000n
    });
    console.log('TX sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('TX status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');
    console.log('Gas used:', receipt.gasUsed.toString());

    const supply = await clara.totalSupply();
    console.log('New total supply:', supply.toString());
  } catch (e) {
    console.log('Mint error:', e.message);
    if (e.transaction) {
      console.log('TX data:', e.transaction.data?.slice(0, 100));
    }
  }
}

main().catch(console.error);
