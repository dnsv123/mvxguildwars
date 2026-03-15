import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ─── Configuration ──────────────────────────────────────────────
const GATEWAY_URL = "https://gateway.battleofnodes.com";
const AMOUNT_TO_SEND = BigInt("5000000000000000000"); // 5 EGLD (18 decimals) — covers Window A (4) + Window B (1)
const GAS_LIMIT = BigInt(50_000);                     // standard MoveBalance gas
const GAS_PRICE = BigInt(1_000_000_000);              // standard gas price
const BATCH_SIZE = 50;                                 // broadcast batch size
// ─────────────────────────────────────────────────────────────────

interface WalletEntry {
  address: string;
  privateKey: string;
}

async function main() {
  // 1. Load GL private key from .env
  const glPrivateKeyHex = process.env.GL_PRIVATE_KEY;
  if (!glPrivateKeyHex) {
    console.error("❌ ERROR: GL_PRIVATE_KEY not found in .env file!");
    process.exit(1);
  }

  // 2. Derive signer & sender address
  const secretKey = UserSecretKey.fromString(glPrivateKeyHex);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(signer.getAddress().bech32());
  console.log(`🔑 GL Wallet: ${senderAddress.toBech32()}`);

  // 3. Load destination wallets
  const walletsPath = path.join(__dirname, "..", "wallets.json");
  const wallets: WalletEntry[] = JSON.parse(fs.readFileSync(walletsPath, "utf-8"));
  console.log(`📋 Loaded ${wallets.length} destination wallets`);

  // 4. Connect to network & fetch chain ID + nonce
  const provider = new ProxyNetworkProvider(GATEWAY_URL);
  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  console.log(`🌐 Connected to gateway | Chain ID: ${chainID}`);

  // Adapter: sdk-core Address uses toBech32(), but sdk-network-providers expects bech32()
  const senderIAddress = { bech32: () => senderAddress.toBech32() };
  const accountOnNetwork = await provider.getAccount(senderIAddress);
  let currentNonce = accountOnNetwork.nonce;
  console.log(`📊 Current nonce: ${currentNonce} | Balance: ${accountOnNetwork.balance.toFixed()} wei`);

  // 5. Build & sign all 500 transactions
  console.log(`\n⚙️  Building ${wallets.length} transactions (${4} EGLD each)...`);
  const txComputer = new TransactionComputer();
  const signedTransactions: Transaction[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const tx = new Transaction({
      nonce: BigInt(currentNonce),
      value: AMOUNT_TO_SEND,
      sender: senderAddress,
      receiver: new Address(wallets[i].address),
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      chainID: chainID,
      data: new Uint8Array(),
    });

    const serialized = txComputer.computeBytesForSigning(tx);
    tx.signature = await signer.sign(serialized);

    signedTransactions.push(tx);
    currentNonce++;

    if ((i + 1) % 100 === 0) {
      console.log(`   ✅ Signed ${i + 1}/${wallets.length}`);
    }
  }
  console.log(`   ✅ Signed ${wallets.length}/${wallets.length} — all transactions ready!\n`);

  // 6. Broadcast in batches of BATCH_SIZE
  let successCount = 0;
  let errorCount = 0;
  const txHashes: string[] = [];

  const totalBatches = Math.ceil(signedTransactions.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, signedTransactions.length);
    const batch = signedTransactions.slice(start, end);

    console.log(`📡 Broadcasting batch ${batchIdx + 1}/${totalBatches} (tx ${start + 1}–${end})...`);

    const results = await Promise.all(
      batch.map(async (tx, idx) => {
        const globalIdx = start + idx;
        try {
          const hash = await provider.sendTransaction(tx);
          return { success: true, hash, index: globalIdx };
        } catch (err: any) {
          return { success: false, hash: "", index: globalIdx, error: err.message || err };
        }
      })
    );

    for (const result of results) {
      if (result.success) {
        successCount++;
        txHashes.push(result.hash);
      } else {
        errorCount++;
        console.error(`   ❌ Tx #${result.index + 1} failed: ${(result as any).error}`);
      }
    }

    console.log(`   ✅ Batch ${batchIdx + 1} done — ${results.filter(r => r.success).length}/${batch.length} succeeded`);
  }

  // 7. Summary
  console.log("\n" + "═".repeat(60));
  console.log("📊 DISTRIBUTION SUMMARY");
  console.log("═".repeat(60));
  console.log(`   Total transactions: ${signedTransactions.length}`);
  console.log(`   ✅ Successful:      ${successCount}`);
  console.log(`   ❌ Failed:          ${errorCount}`);
  console.log(`   💰 Total EGLD sent: ${successCount * 4} EGLD`);
  console.log("═".repeat(60));

  if (txHashes.length > 0) {
    console.log(`\n🔗 First tx hash:  ${txHashes[0]}`);
    console.log(`🔗 Last tx hash:   ${txHashes[txHashes.length - 1]}`);
  }
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
