/**
 * 🧪 TEST SCRIPT — Verify cross-shard transactions work
 * Uses OLD wallets from previous challenges (they have ~9 EGLD each)
 * Sends 5 cross-shard tx per test wallet → verifies on explorer
 *
 * Usage: npx ts-node scripts/9_test_crossover.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GATEWAY_URL = process.env.KEPLER_GATEWAY || "https://gateway.battleofnodes.com";
const CHAIN_ID = "B";
const GAS_LIMIT = BigInt(50_000);
const GAS_PRICE = BigInt(1_000_000_000);
const TX_VALUE  = BigInt(1); // 1×10⁻¹⁸ EGLD (Part 1 minimum)
const TEST_TX_COUNT = 5; // Per wallet

function getWalletShard(address: string): number {
  const pubkey = new Address(address).getPublicKey();
  const lastByte = pubkey[pubkey.length - 1];
  let shard = lastByte & 3;
  if (shard > 2) shard = lastByte & 1;
  return shard;
}

async function main() {
  console.log("🧪 CROSS-SHARD TEST — using old wallets\n");
  console.log(`   Gateway: ${GATEWAY_URL}`);

  // Load old wallets
  const wallets = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );

  // Group by shard
  const shards: { address: string; privateKey: string }[][] = [[], [], []];
  for (const w of wallets) {
    shards[getWalletShard(w.address)].push(w);
  }

  console.log(`   Shard 0: ${shards[0].length} wallets`);
  console.log(`   Shard 1: ${shards[1].length} wallets`);
  console.log(`   Shard 2: ${shards[2].length} wallets`);

  // Pick 2 test wallets per shard (6 total)
  const testWallets = [
    { sender: shards[0][0], receiver: shards[1][0], label: "S0→S1" },
    { sender: shards[1][0], receiver: shards[2][0], label: "S1→S2" },
    { sender: shards[2][0], receiver: shards[0][0], label: "S2→S0" },
  ];

  const httpsAgent = new https.Agent({ maxSockets: 10, keepAlive: true });
  const keplerKey = process.env.KEPLER_API_KEY;
  const providerConfig: any = { clientName: "OpenHeart-Test", httpsAgent, timeout: 30_000 };
  if (keplerKey) providerConfig.headers = { "api-key": keplerKey };
  const provider = new ProxyNetworkProvider(GATEWAY_URL, providerConfig);

  const txComputer = new TransactionComputer();

  console.log("\n🔥 Sending test cross-shard transactions...\n");

  let totalOk = 0;
  let totalFail = 0;

  for (const test of testWallets) {
    console.log(`   ${test.label}:`);
    console.log(`     Sender:   ${test.sender.address.slice(0, 20)}... (Shard ${getWalletShard(test.sender.address)})`);
    console.log(`     Receiver: ${test.receiver.address.slice(0, 20)}... (Shard ${getWalletShard(test.receiver.address)})`);

    const sk = UserSecretKey.fromString(test.sender.privateKey);
    const signer = new UserSigner(sk);
    const senderAddr = new Address(test.sender.address);
    const receiverAddr = new Address(test.receiver.address);

    // Get nonce
    let nonce = 0;
    try {
      const acc = await provider.getAccount({ bech32: () => test.sender.address });
      nonce = acc.nonce;
      const bal = Number(acc.balance.dividedBy("1000000000000000000"));
      console.log(`     Balance: ${bal.toFixed(4)} EGLD | Nonce: ${nonce}`);
    } catch (e: any) {
      console.log(`     ❌ Error getting account: ${e.message}`);
      totalFail += TEST_TX_COUNT;
      continue;
    }

    let ok = 0;
    for (let i = 0; i < TEST_TX_COUNT; i++) {
      const tx = new Transaction({
        nonce: BigInt(nonce + i),
        value: TX_VALUE,
        sender: senderAddr,
        receiver: receiverAddr,
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        chainID: CHAIN_ID,
        data: new Uint8Array(),
      });
      tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));

      try {
        const hash = await provider.sendTransaction(tx);
        console.log(`     ✅ TX ${i + 1}/${TEST_TX_COUNT}: ${hash}`);
        ok++;
      } catch (e: any) {
        console.log(`     ❌ TX ${i + 1}/${TEST_TX_COUNT}: ${e.message?.slice(0, 80)}`);
        totalFail++;
      }
    }
    totalOk += ok;
    console.log(`     Result: ${ok}/${TEST_TX_COUNT} sent\n`);
  }

  console.log("═".repeat(50));
  console.log(`📊 TEST RESULTS:`);
  console.log(`   Total sent: ${totalOk}/${totalOk + totalFail}`);
  console.log(`   Routes tested: S0→S1, S1→S2, S2→S0`);
  console.log(`   Gateway: ${GATEWAY_URL}`);
  console.log("═".repeat(50));

  if (totalOk > 0) {
    console.log("\n✅ Cross-shard transactions WORK!");
    console.log("   Check on explorer: https://bon-explorer.multiversx.com");
    console.log(`   Search: ${testWallets[0].sender.address}`);
  } else {
    console.log("\n❌ All transactions failed — check gateway!");
  }

  httpsAgent.destroy();
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
