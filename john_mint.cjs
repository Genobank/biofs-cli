// Sovereign self-mint of John's consent BioNFT, signed by the custodian wallet itself
// (no central deployer key). Free-gas chain -> gasPrice 0, explicit gasLimit (0-balance sender).
// MINT_DRY=1 verifies keystore decryption, signer address, and the built tx WITHOUT sending.
// Privacy: ownerName/metadataUri carry NO proper name; identity is the 50-SNP fingerprint F.
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = 'https://seqrpc.genobank.app';
const CONTRACT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const CUST = '0x88110B7e4F56A53951461342298b468Ae68F15f1';
const F = '0xfa9dba8218061d750cde21aa0fdd20b8ead0da888e1022754ee8706bdda0e243';
const KS = process.env.HOME + '/.biofs/biowallets/' + CUST + '.keystore.json';

const ABI = [
  'function mintBiosample(address to, string biosampleSerial, string ownerName, string sampleType, string captureKit, string metadataUri) returns (uint256)',
  'function serialToTokenId(string) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'event BiosampleMinted(uint256 indexed tokenId, string biosampleSerial, address indexed owner, string ownerName)'
];

const OWNER_NAME = 'Custodial T2T long-read genome (claimable by patient)';
const SAMPLE_TYPE = 'genome';
const CAPTURE_KIT = 'pacbio_hifi+ont_r10.4.1_dorado';
const METADATA_URI = 'biocid://' + CUST.toLowerCase() + '/genome/' + F;

(async () => {
  const dry = process.env.MINT_DRY === '1';

  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  // Load the custodian signer from its on-disk mnemonic file (chmod 600) — no secret on the command line.
  const MN = process.env.HOME + '/.biofs/biowallets/' + CUST + '.mnemonic.txt';
  const raw = fs.readFileSync(MN, 'utf8');
  const phrase = (raw.split('\n').map(s => s.trim()).find(s => /^([a-z]+\s+){11,23}[a-z]+$/.test(s))) || raw.trim();
  let wallet = ethers.Wallet.fromPhrase(phrase);
  if (wallet.address.toLowerCase() !== CUST.toLowerCase()) {
    let found = null;
    for (let i = 0; i < 6 && !found; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/0/" + i);
      if (w.address.toLowerCase() === CUST.toLowerCase()) found = w;
    }
    if (!found) throw new Error('mnemonic-derived address mismatch: default ' + wallet.address);
    wallet = found;
  }
  wallet = wallet.connect(provider);

  const cRead = new ethers.Contract(CONTRACT, ABI, provider);
  const existing = await cRead.serialToTokenId(F);
  if (existing > 0n) { console.log(JSON.stringify({ already_minted: true, tokenId: String(existing) })); return; }

  const iface = new ethers.Interface(ABI);
  const data = iface.encodeFunctionData('mintBiosample', [CUST, F, OWNER_NAME, SAMPLE_TYPE, CAPTURE_KIT, METADATA_URI]);
  const txReq = { to: CONTRACT, data, gasLimit: 3_000_000n, gasPrice: 0n };

  if (dry) {
    console.log(JSON.stringify({
      dry_run: true, signer: wallet.address, mintTo: CUST, serial_F: F,
      ownerName: OWNER_NAME, sampleType: SAMPLE_TYPE, metadataUri: METADATA_URI,
      txTo: txReq.to, gasPrice: '0', gasLimit: String(txReq.gasLimit), dataLen: data.length
    }, null, 2));
    return;
  }

  const tx = await wallet.sendTransaction(txReq);
  console.log('SENT ' + tx.hash + ' — waiting for confirmation...');
  const rcpt = await tx.wait(1);
  let tokenId = null;
  for (const lg of rcpt.logs) {
    try { const pl = cRead.interface.parseLog({ topics: lg.topics, data: lg.data });
      if (pl && pl.name === 'BiosampleMinted') tokenId = pl.args.tokenId.toString(); } catch (e) {}
  }
  if (tokenId === null) { try { tokenId = (await cRead.serialToTokenId(F)).toString(); } catch (e) {} }
  const owner = (tokenId !== null) ? await cRead.ownerOf(tokenId) : 'n/a';
  console.log(JSON.stringify({
    status: rcpt.status, txHash: rcpt.hash, block: rcpt.blockNumber,
    tokenId, owner, ownerIsCustodian: owner.toLowerCase() === CUST.toLowerCase(), serial_F: F
  }, null, 2));
})().catch(e => { console.error('MINT_ERROR: ' + e.message); process.exit(1); });
