#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const credentialsPath = path.join(os.homedir(), '.biofs', 'credentials.json');

console.log('Checking BioFS credentials...\n');
console.log('Credentials file:', credentialsPath);

try {
  const data = fs.readFileSync(credentialsPath, 'utf8');
  const creds = JSON.parse(data);

  console.log('\n✅ Credentials found:');
  console.log('  Wallet:', creds.wallet);
  console.log('  Authenticated:', creds.authenticated);
  console.log('  Expires:', creds.expires);
  console.log('  Has signature:', creds.signature ? 'Yes' : 'No');

  if (creds.signature) {
    console.log('  Signature preview:', creds.signature.substring(0, 30) + '...');

    // Try to recover wallet from signature
    try {
      const { ethers } = require('ethers');
      const message = 'I want to proceed';
      const recoveredWallet = ethers.verifyMessage(message, creds.signature);

      console.log('\n🔐 Signature verification:');
      console.log('  Recovered wallet:', recoveredWallet);
      console.log('  Stored wallet:   ', creds.wallet);

      if (recoveredWallet.toLowerCase() === creds.wallet.toLowerCase()) {
        console.log('  ✅ Signature matches wallet - Authentication is valid');
      } else {
        console.log('  ❌ Signature does NOT match wallet - Re-authenticate needed!');
        console.log('\n  Run: biofs login');
      }
    } catch (e) {
      console.log('\n❌ Could not verify signature:', e.message);
      console.log('  Run: biofs login');
    }
  }

  // Check if specific test wallet (optional, for development only)
  const testWallet = process.env.TEST_WALLET_ADDRESS;
  if (testWallet && creds.wallet.toLowerCase() === testWallet.toLowerCase()) {
    console.log('\n✅ This is the configured test wallet');
    console.log('  Expected to see test/granted files from server');
  }

} catch (error) {
  console.log('\n❌ Error reading credentials:', error.message);
  console.log('\n  Credentials not found. Run: biofs login');
}
