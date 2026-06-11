// Read-only preflight for John's sovereign BioNFT self-mint.
// Confirms: a working Sequentia RPC, the BioNFT contract has code, the custodian
// wallet's gas balance, and that identity F is not already tokenized. No tx sent.
const { ethers } = require('ethers');
const RPCS = ['https://seqrpc.genobank.app', 'http://34.61.144.219:8545', 'http://54.226.180.9:8545'];
const CONTRACT = '0xA2cD489d7c2eB3FF5e51F13f0641351a33cA32cd';
const CUST = '0x88110B7e4F56A53951461342298b468Ae68F15f1';
const F = '0xfa9dba8218061d750cde21aa0fdd20b8ead0da888e1022754ee8706bdda0e243';
const ABI = [
  'function serialToTokenId(string) view returns (uint256)',
  'function totalSupply() view returns (uint256)'
];
(async () => {
  for (const url of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      const net = await p.getNetwork();
      const bal = await p.getBalance(CUST);
      const code = await p.getCode(CONTRACT);
      const c = new ethers.Contract(CONTRACT, ABI, p);
      let tid = 'n/a', supply = 'n/a';
      try { tid = String(await c.serialToTokenId(F)); } catch (e) { tid = 'err:' + e.message.slice(0, 50); }
      try { supply = String(await c.totalSupply()); } catch (e) { supply = 'err:' + e.message.slice(0, 50); }
      console.log(JSON.stringify({
        rpc: url,
        ok: true,
        chainId: Number(net.chainId),
        custodian: CUST,
        custodianBalanceEth: ethers.formatEther(bal),
        contractHasCode: !!(code && code !== '0x'),
        existingTokenIdForF: tid,
        totalSupply: supply
      }, null, 2));
      return;
    } catch (e) {
      console.log(JSON.stringify({ rpc: url, ok: false, error: e.message.slice(0, 90) }));
    }
  }
  console.log('NO_WORKING_RPC');
})();
