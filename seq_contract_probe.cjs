// Read-only on-chain interrogation of the BioNFT/biosample contract: discover its real
// interface and authorization roles. No tx sent. Probes common role/auth view functions.
const { ethers } = require('ethers');
const RPC = 'https://seqrpc.genobank.app';
const C = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const ADDRS = {
  custodian: '0x88110B7e4F56A53951461342298b468Ae68F15f1',
  deployer:  '0x088ebE307b4200A62dC6190d0Ac52D55bcABac11',
  operator:  '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a'
};
const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });

async function callView(sig, args = []) {
  try {
    const iface = new ethers.Interface(['function ' + sig]);
    const fn = sig.split('(')[0];
    const data = iface.encodeFunctionData(fn, args);
    const ret = await p.call({ to: C, data });
    if (ret === '0x' || ret === '') return undefined;
    const dec = iface.decodeFunctionResult(fn, ret);
    return dec.length === 1 ? dec[0] : dec.map(String);
  } catch (e) { return undefined; }
}

(async () => {
  console.log('contract', C, 'codeSize', ((await p.getCode(C)).length - 2) / 2, 'bytes');
  const noArg = [
    'name() view returns (string)', 'symbol() view returns (string)',
    'owner() view returns (address)', 'executor() view returns (address)',
    'biosampleExecutor() view returns (address)', 'minter() view returns (address)',
    'totalSupply() view returns (uint256)'
  ];
  console.log('\n-- no-arg views (existence + value) --');
  for (const sig of noArg) {
    const v = await callView(sig);
    if (v !== undefined) console.log('  ' + sig.split('(')[0] + ' = ' + String(v));
  }
  const roleHashes = {};
  for (const sig of ['MINTER_ROLE() view returns (bytes32)', 'EXECUTOR_ROLE() view returns (bytes32)', 'DEFAULT_ADMIN_ROLE() view returns (bytes32)']) {
    const v = await callView(sig); if (v !== undefined) { roleHashes[sig.split('(')[0]] = v; console.log('  ' + sig.split('(')[0] + ' = ' + v); }
  }
  const addrViews = [
    'authorizedMinters(address) view returns (bool)', 'isMinter(address) view returns (bool)',
    'isAuthorized(address) view returns (bool)', 'authorizedIssuers(address) view returns (bool)',
    'isAuthorizedIssuer(address) view returns (bool)', 'executors(address) view returns (bool)',
    'isExecutor(address) view returns (bool)', 'authorized(address) view returns (bool)',
    'minters(address) view returns (bool)'
  ];
  console.log('\n-- per-address authorization checks (only existing functions shown) --');
  for (const sig of addrViews) {
    const fn = sig.split('(')[0];
    let any = false; const row = {};
    for (const [label, a] of Object.entries(ADDRS)) {
      const v = await callView(sig, [a]);
      if (v !== undefined) { any = true; row[label] = String(v); }
    }
    if (any) console.log('  ' + fn + ' -> ' + JSON.stringify(row));
  }
  console.log('\n-- hasRole(role, addr) if AccessControl --');
  for (const [rname, rhash] of Object.entries(roleHashes)) {
    for (const [label, a] of Object.entries(ADDRS)) {
      const v = await callView('hasRole(bytes32,address) view returns (bool)', [rhash, a]);
      if (v !== undefined) console.log('  hasRole(' + rname + ', ' + label + ') = ' + String(v));
    }
  }
})();
