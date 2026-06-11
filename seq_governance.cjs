// seq_governance.cjs — RUN ON sequentia-node ONLY. Deployer key read from /home/danieluribe/.env
// (never printed, never leaves the host). Two deployer-signed txs on the Sequentia BIONFT
// "Biosample Ownership" contract:
//   1. setAuthorizedMinter(operator, true)  -> operator becomes the standing biosample-executor
//   2. mintBiosample(custodian, F, ...)     -> John's custodial consent BioNFT (deployer is authorized)
// ethers v5 (node 12 compatible). Idempotent: skips a step already done.
const ethers = require('/home/danieluribe/seqtx/node_modules/ethers');
const fs = require('fs');

const RPC       = 'https://seqrpc.genobank.app';
const CONTRACT  = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const OPERATOR  = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const CUSTODIAN = '0x88110B7e4F56A53951461342298b468Ae68F15f1';
const F         = '0xfa9dba8218061d750cde21aa0fdd20b8ead0da888e1022754ee8706bdda0e243';

const ABI = [
  'function setAuthorizedMinter(address,bool)',
  'function authorizedMinters(address) view returns (bool)',
  'function mintBiosample(address,string,string,string,string,string) returns (uint256)',
  'function serialToTokenId(string) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function owner() view returns (address)'
];

(async () => {
  const env = fs.readFileSync('/home/danieluribe/.env', 'utf8');
  const m = env.match(/^\s*SEQUENTIA_DEPLOYER_PRIVATE_KEY\s*=\s*(.+)$/m);
  if (!m) throw new Error('SEQUENTIA_DEPLOYER_PRIVATE_KEY not found in ~/.env');
  let pk = m[1].trim().replace(/^["']|["']$/g, '');
  if (!pk.startsWith('0x')) pk = '0x' + pk;

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const w = new ethers.Wallet(pk, provider);
  const c = new ethers.Contract(CONTRACT, ABI, w);

  const net = await provider.getNetwork();
  console.log('deployer signer :', w.address);
  console.log('chainId         :', net.chainId);
  console.log('contract owner():', await c.owner());

  // gas: honor the chain's fee data, default 0 for the free-gas app-chain
  let gp;
  try { const fee = await provider.getFeeData(); gp = fee.gasPrice || ethers.BigNumber.from(0); }
  catch (_) { gp = ethers.BigNumber.from(0); }
  console.log('gasPrice        :', gp.toString());

  // 1. authorize the operator as biosample-executor
  let opAuth = await c.authorizedMinters(OPERATOR);
  console.log('\noperator authorized (before):', opAuth);
  if (!opAuth) {
    const tx1 = await c.setAuthorizedMinter(OPERATOR, true, { gasPrice: gp, gasLimit: 200000 });
    console.log('  setAuthorizedMinter tx:', tx1.hash);
    const r1 = await tx1.wait(1);
    console.log('  mined: status', r1.status, 'block', r1.blockNumber);
  }
  opAuth = await c.authorizedMinters(OPERATOR);
  console.log('operator authorized (after) :', opAuth);

  // 2. mint John's custodial BioNFT to the custodian wallet (deployer is authorized)
  let tid = await c.serialToTokenId(F);
  console.log('\nJohn serialToTokenId(F) (before):', tid.toString());
  if (tid.gt(0)) {
    console.log('  already minted, skipping mint');
  } else {
    const meta = 'biocid://' + CUSTODIAN.toLowerCase() + '/genome/' + F;
    const tx2 = await c.mintBiosample(
      CUSTODIAN,
      F,
      'Custodial T2T long-read genome (claimable by patient)',
      'genome',
      'pacbio_hifi+ont_r10.4.1_dorado',
      meta,
      { gasPrice: gp, gasLimit: 3000000 }
    );
    console.log('  mintBiosample tx:', tx2.hash);
    const r2 = await tx2.wait(1);
    console.log('  mined: status', r2.status, 'block', r2.blockNumber);
    tid = await c.serialToTokenId(F);
  }

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    operatorAuthorized: await c.authorizedMinters(OPERATOR),
    johnTokenId: tid.toString(),
    johnOwner: tid.gt(0) ? await c.ownerOf(tid) : 'n/a',
    custodianMatches: tid.gt(0) ? ((await c.ownerOf(tid)).toLowerCase() === CUSTODIAN.toLowerCase()) : false
  }, null, 2));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
