const { ethers } = require('ethers');

const CLARA_JOB_NFT = '0xdCd99012D796A4b250386cD6AcF5386316A8c3f8';
const RPC = 'http://54.226.180.9:8545';
const MINTER_KEY = '***REMOVED***';

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(MINTER_KEY, provider);
  console.log('Wallet:', wallet.address);

  // Full ERC721URIStorage mint signature - safeMint(address to, string uri)
  const abi = [
    'function safeMint(address to, string uri)',
    'function totalSupply() view returns (uint256)',
    'function owner() view returns (address)'
  ];

  const contract = new ethers.Contract(CLARA_JOB_NFT, abi, wallet);

  const owner = await contract.owner();
  console.log('Contract owner:', owner);
  console.log('Wallet matches owner:', owner.toLowerCase() === wallet.address.toLowerCase());

  // Try to mint
  const testRecipient = '0xD5C04Ea5c93C9E7b789c21b2f0649c6c0C06cD24'; // Memo's BioWallet
  const metadata = {
    name: 'Clara Genomics Job: 56102007614180',
    description: 'Test mint'
  };
  const metadataUri = 'data:application/json;base64,' +
    Buffer.from(JSON.stringify(metadata)).toString('base64');

  console.log('Minting to:', testRecipient);
  console.log('URI:', metadataUri.slice(0, 80) + '...');

  try {
    const tx = await contract.safeMint(testRecipient, metadataUri, {
      gasLimit: 500000n
    });
    console.log('TX sent:', tx.hash);
    const receipt = await tx.wait();
    console.log('TX status:', receipt.status);
    console.log('Gas used:', receipt.gasUsed.toString());

    const supply = await contract.totalSupply();
    console.log('New total supply:', supply.toString());
  } catch (e) {
    console.log('Mint error:', e.message);

    // Try with different gas
    try {
      console.log('\nRetrying with explicit gas settings...');
      const gasPrice = await provider.getFeeData();
      console.log('Gas price:', gasPrice.gasPrice.toString());

      const tx = await contract.safeMint(testRecipient, metadataUri, {
        gasLimit: 1000000n,
        gasPrice: gasPrice.gasPrice || 0n
      });
      console.log('TX sent:', tx.hash);
      const receipt = await tx.wait();
      console.log('TX status:', receipt.status);
    } catch (e2) {
      console.log('Retry error:', e2.message);
    }
  }
}

main().catch(console.error);
