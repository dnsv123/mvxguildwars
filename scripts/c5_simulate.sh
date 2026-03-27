#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  🧪 C5 FULL SIMULATION — End-to-End Challenge Test
#
#  Simulates the ENTIRE challenge flow:
#  1. Generate fresh wallets
#  2. Fund agents (0.5 EGLD each = 5 EGLD total)
#  3. GL sends "Go!" TX to simulate admin→target  
#  4. GL sends "Stop!" TX to simulate red light
#  5. Verify agent monitoring + NLP + TX pipeline
#  6. Test MX-8004 registration (1 agent)
#  7. Sweep everything back to GL
#
#  Usage: bash scripts/c5_simulate.sh
# ═══════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")/.."

echo ""
echo "█████████████████████████████████████████████████████████"
echo "█  🧪 C5 FULL SIMULATION — End-to-End Test              "
echo "█  Cost: ~5 EGLD (returned after test)                   "
echo "█████████████████████████████████████████████████████████"
echo ""

# Step 1: Generate FRESH wallets
echo "[$(date +%H:%M:%S)] 🔑 Step 1: Generating fresh test wallets..."
rm -f c5_agents.json
npx ts-node --transpileOnly scripts/c5_setup.ts wallets

# Step 2: Fund tiny amounts
echo ""
echo "[$(date +%H:%M:%S)] 💰 Step 2: Running live pipeline test (fund + TX + verify + sweep)..."
npx ts-node --transpileOnly scripts/c5_test_live.ts

# Step 3: Test MX-8004 registration with 1 agent
echo ""
echo "[$(date +%H:%M:%S)] 📋 Step 3: Testing MX-8004 registration..."
echo "⚠️  Registration needs funded agents. Funding agent 0 with 0.5 EGLD..."
npx ts-node --transpileOnly -e "
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Transaction, Address, TransactionComputer } = require('@multiversx/sdk-core');
const { UserSecretKey, UserSigner } = require('@multiversx/sdk-wallet');

const CHAIN_ID = 'B';
const API = process.env.API_URL || 'https://api.battleofnodes.com';
const GW = process.env.GATEWAY_URL || 'https://gateway.battleofnodes.com';
const txComputer = new TransactionComputer();

async function main() {
  const glHex = process.env.GL_PRIVATE_KEY;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  const wallets = JSON.parse(fs.readFileSync('c5_agents.json', 'utf-8'));
  const agent0 = wallets[0].address;

  // Fund agent 0 with 0.5 EGLD
  const glInfo = await (await fetch(API + '/accounts/' + glAddr)).json();
  const tx = new Transaction({
    nonce: BigInt(glInfo.nonce), value: BigInt('500000000000000000'),
    sender: new Address(glAddr), receiver: new Address(agent0),
    gasLimit: BigInt(50000), gasPrice: BigInt(1000000000), chainID: CHAIN_ID,
    data: new Uint8Array(),
  });
  const bytes = txComputer.computeBytesForSigning(tx);
  tx.signature = await glSigner.sign(bytes);
  const r = await fetch(GW + '/transaction/send', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(tx.toPlainObject())
  });
  const d = await r.json();
  console.log('Funded agent 0:', d?.data?.txHash?.substring(0,20) || JSON.stringify(d));

  await new Promise(r => setTimeout(r, 12000));

  // Now try registration
  const agentSigner = new UserSigner(UserSecretKey.fromString(wallets[0].privateKey));
  const agentInfo = await (await fetch(API + '/accounts/' + agent0)).json();
  console.log('Agent 0 balance:', (Number(BigInt(agentInfo.balance)) / 1e18).toFixed(4), 'EGLD');

  const nameHex = Buffer.from('OpenHeart-Agent-0').toString('hex');
  const uriHex = Buffer.from('https://agent.openheart.guild/agent0').toString('hex');
  const pubKeyHex = Buffer.from(new Address(agent0).getPublicKey()).toString('hex');
  const dataStr = 'register_agent@' + nameHex + '@' + uriHex + '@' + pubKeyHex + '@00000000@00000000';

  const regTx = new Transaction({
    nonce: BigInt(agentInfo.nonce), value: BigInt(0),
    sender: new Address(agent0),
    receiver: new Address('erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p'),
    gasLimit: BigInt(30000000), gasPrice: BigInt(1000000000), chainID: CHAIN_ID,
    data: new TextEncoder().encode(dataStr),
  });
  const regBytes = txComputer.computeBytesForSigning(regTx);
  regTx.signature = await agentSigner.sign(regBytes);
  const regR = await fetch(GW + '/transaction/send', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(regTx.toPlainObject())
  });
  const regD = await regR.json();
  const txHash = regD?.data?.txHash || '';
  if (txHash) {
    console.log('✅ Registration TX sent:', txHash);
    console.log('🔗 https://bon-explorer.multiversx.com/transactions/' + txHash);
    await new Promise(r => setTimeout(r, 15000));
    // Check TX status
    try {
      const txInfo = await (await fetch(API + '/transactions/' + txHash)).json();
      console.log('TX Status:', txInfo.status);
      if (txInfo.status === 'success') {
        console.log('✅✅ MX-8004 REGISTRATION WORKS!');
      } else {
        console.log('⚠️  TX status:', txInfo.status, '- check explorer');
        if (txInfo.results) console.log('Results:', JSON.stringify(txInfo.results).substring(0,200));
      }
    } catch(e) { console.log('Could not verify TX status'); }
  } else {
    console.log('❌ Registration failed:', JSON.stringify(regD).substring(0,200));
  }

  // Sweep agent 0 back
  console.log('Sweeping agent 0 back to GL...');
  const sweepInfo = await (await fetch(API + '/accounts/' + agent0)).json();
  const bal = BigInt(sweepInfo.balance || '0');
  const fee = BigInt(50000) * BigInt(1000000000);
  if (bal > fee) {
    const sweepTx = new Transaction({
      nonce: BigInt(sweepInfo.nonce), value: bal - fee,
      sender: new Address(agent0), receiver: new Address(glAddr),
      gasLimit: BigInt(50000), gasPrice: BigInt(1000000000), chainID: CHAIN_ID,
      data: new Uint8Array(),
    });
    const sBytes = txComputer.computeBytesForSigning(sweepTx);
    sweepTx.signature = await agentSigner.sign(sBytes);
    await fetch(GW + '/transaction/send', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(sweepTx.toPlainObject())
    });
    console.log('🧹 Swept back to GL');
  }
}
main().catch(e => console.error('Error:', e.message));
"

echo ""
echo "█████████████████████████████████████████████████████████"
echo "█  🧪 SIMULATION COMPLETE — Check output above          "
echo "█████████████████████████████████████████████████████████"
