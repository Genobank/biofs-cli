// Read-only: simulate mintBiosample to extract the on-chain revert reason. No tx sent.
const { ethers } = require('ethers');
const RPC = 'https://seqrpc.genobank.app';
const CONTRACT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const CUST = '0x88110B7e4F56A53951461342298b468Ae68F15f1';
const F = '0xfa9dba8218061d750cde21aa0fdd20b8ead0da888e1022754ee8706bdda0e243';
const ABI = [
  'function mintBiosample(address to, string biosampleSerial, string ownerName, string sampleType, string captureKit, string metadataUri) returns (uint256)',
  'function owner() view returns (address)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function paused() view returns (bool)'
];
(async () => {
  const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const iface = new ethers.Interface(ABI);
  const data = iface.encodeFunctionData('mintBiosample', [
    CUST, F, 'Custodial T2T long-read genome (claimable by patient)',
    'genome', 'pacbio_hifi+ont_r10.4.1_dorado', 'biocid://' + CUST.toLowerCase() + '/genome/' + F]);
  try {
    const ret = await p.call({ to: CONTRACT, from: CUST, data });
    console.log('call OK (no revert), returned:', ret);
  } catch (e) {
    console.log('REVERT shortMessage:', e.shortMessage || e.message);
    console.log('reason:', e.reason, '| code:', e.code);
    let d = e.data || (e.info && e.info.error && e.info.error.data);
    console.log('revert data:', d);
    if (d && typeof d === 'string' && d.length > 138) {
      try { console.log('decoded string:', ethers.toUtf8String('0x' + d.slice(138).replace(/0+$/, ''))); } catch (_) {}
    }
  }
  // probe access-control surface
  const c = new ethers.Contract(CONTRACT, ABI, p);
  for (const fn of ['owner', 'paused']) {
    try { console.log(fn + '():', String(await c[fn]())); } catch (e) { console.log(fn + '(): n/a (' + (e.shortMessage || 'no fn') + ')'); }
  }
  try {
    const role = await c.MINTER_ROLE();
    console.log('MINTER_ROLE:', role, '| custodian hasRole:', await c.hasRole(role, CUST));
  } catch (e) { console.log('MINTER_ROLE/hasRole: n/a (likely not AccessControl)'); }
})();
