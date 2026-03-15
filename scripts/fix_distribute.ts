/**
 * EMERGENCY: Retry distribution for wallets that didn't receive funds.
 * - Fetches current GL nonce from network
 * - Sends to ALL 500 wallets (skips those already funded)
 * - Adds 1-second delay between batches to avoid rate limiting
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GATEWAY_URL = "https://gateway.battleofnodes.com";
const AMOUNT = BigInt("5000000000000000000"); // 5 EGLD
const GAS_LIMIT = BigInt(50_000);
const GAS_PRICE = BigInt(1_000_000_000);
const BATCH_SIZE = 25;          // smaller batches
const DELAY_BETWEEN_BATCHES = 1500; // 1.5s delay between batches

interface WalletEntry { address: string; privateKey: string; }

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const glKey = process.env.GL_PRIVATE_KEY;
  if (!glKey) { console.error("❌ GL_PRIVATE_KEY missing"); process.exit(1); }

  const secretKey = UserSecretKey.fromString(glKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(signer.getAddress().bech32());
  const senderIAddress = { bech32: () => senderAddress.toBech32() };

  const wallets: WalletEntry[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );

  const provider = new ProxyNetworkProvider(GATEWAY_URL, { timeout: 30000 } as any);
  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  const txComputer = new TransactionComputer();

  // 1. Check which wallets need funding
  console.log("🔍 Checking which wallets need funding...");
  const unfunded: number[] = [];

  // Check in parallel batches of 50
  for (let i = 0; i < wallets.length; i += 50) {
    const batch = wallets.slice(i, Math.min(i + 50, wallets.length));
    const results = await Promise.all(
      batch.map(async (w, idx) => {
        try {
          const acc = await provider.getAccount({ bech32: () => w.address });
          return { index: i + idx, balance: acc.balance.toFixed() };
        } catch {
          return { index: i + idx, balance: "0" };
        }
      })
    );
    for (const r of results) {
      if (r.balance === "0") unfunded.push(r.index);
    }
    await sleep(500);
  }

  console.log(`\n📊 ${wallets.length - unfunded.length} funded, ${unfunded.length} need funding\n`);

  if (unfunded.length === 0) {
    console.log("✅ All wallets already funded!");
    return;
  }

  // 2. Get current GL nonce
  const glAccount = await provider.getAccount(senderIAddress);
  let nonce = glAccount.nonce;
  console.log(`🔑 GL: ${senderAddress.toBech32()}`);
  console.log(`📊 GL nonce: ${nonce} | Balance: ${glAccount.balance.dividedBy("1e18").toFixed(4)} EGLD`);
  console.log(`\n⚙️  Distributing to ${unfunded.length} wallets in batches of ${BATCH_SIZE}...\n`);

  // 3. Send in small batches with delays
  let success = 0;
  let errors = 0;
  const totalBatches = Math.ceil(unfunded.length / BATCH_SIZE);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, unfunded.length);
    const batchIndices = unfunded.slice(start, end);

    // Sign batch
    const txs: Transaction[] = [];
    for (const walletIdx of batchIndices) {
      const tx = new Transaction({
        nonce: BigInt(nonce),
        value: AMOUNT,
        sender: senderAddress,
        receiver: new Address(wallets[walletIdx].address),
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        chainID: chainID,
        data: new Uint8Array(),
      });
      const bytes = txComputer.computeBytesForSigning(tx);
      tx.signature = await signer.sign(bytes);
      txs.push(tx);
      nonce++;
    }

    // Send one by one with small stagger
    let batchOk = 0;
    for (const tx of txs) {
      try {
        await provider.sendTransaction(tx);
        batchOk++;
        success++;
      } catch (err: any) {
        errors++;
      }
    }

    console.log(`📡 Batch ${b + 1}/${totalBatches}: ${batchOk}/${batchIndices.length} OK (total: ${success}/${unfunded.length})`);

    // Delay between batches
    if (b < totalBatches - 1) {
      await sleep(DELAY_BETWEEN_BATCHES);
    }
  }

  console.log("\n" + "═".repeat(50));
  console.log(`✅ Retry complete: ${success} sent, ${errors} failed`);
  console.log("═".repeat(50));
}

main().catch(err => { console.error("❌", err); process.exit(1); });
