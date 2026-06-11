// seq_keymap.cjs — RUN ON sequentia-node. Re-map every key in ~/.env to its ADDRESS only
// (never prints any secret value). Cross-checks each against the BIONFT contract:
// owner() and authorizedMinters(addr). Flags the known executor/owner/operator wallets.
const ethers = require('/home/danieluribe/seqtx/node_modules/ethers');
const fs = require('fs');

const RPC      = 'https://seqrpc.genobank.app';
const BIONFT   = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const KNOWN = {
  '0x088ebe307b4200a62dc6190d0ac52d55bcabac11': 'OWNER/deployer-of-BIONFT',
  '0x07638069a1efdd5aba73695e95d4bdb2f71cc32d': 'BIOSAMPLE_EXECUTOR (Fuji map)',
  '0x5f5a60eaef242c0d51a21c703f520347b96ed19a': 'OPERATOR (Daniel)',
  '0x88110b7e4f56a53951461342298b468ae68f15f1': 'CUSTODIAN (session)',
  '0x53616ef0f0c2585c4468ee9aa6425b5841e71b25': 'JOHN wallet',
  '0x0947ca077c8a3ce19e84cd4e518f0986dc9f4089': 'PROTOCOL deployer (0x0947ca)'
};

function deriveAddr(v) {
  v = v.trim().replace(/^["']|["']$/g, '');
  try {
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) return new ethers.Wallet(v).address;
    if (/^[0-9a-fA-F]{64}$/.test(v))   return new ethers.Wallet('0x' + v).address;
    if (v.split(/\s+/).length >= 12)   return ethers.Wallet.fromMnemonic(v).address;
  } catch (_) {}
  return null;
}

(async () => {
  const files = process.argv.slice(2);
  if (files.length === 0) files.push('/home/danieluribe/.env');
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(BIONFT, [
    'function authorizedMinters(address) view returns (bool)',
    'function owner() view returns (address)'
  ], provider);
  const owner = await c.owner();
  console.log('BIONFT', BIONFT, 'owner():', owner, '\n');

  for (const f of files) {
    if (!fs.existsSync(f)) { console.log('(missing)', f); continue; }
    console.log('=== ' + f + ' ===');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (const l of lines) {
      const i = l.indexOf('=');
      if (i < 1) continue;
      const name = l.slice(0, i).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
      const addr = deriveAddr(l.slice(i + 1));
      if (!addr) continue;
      let auth = '?';
      try { auth = String(await c.authorizedMinters(addr)); } catch (_) {}
      const tag = KNOWN[addr.toLowerCase()] ? '  [' + KNOWN[addr.toLowerCase()] + ']' : '';
      console.log('  ' + name.padEnd(34) + ' -> ' + addr + '  authorizedMinter=' + auth + tag);
    }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
