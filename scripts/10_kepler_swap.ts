/**
 * 🔄 KEPLER SETUP — Wrap EGLD → WEGLD → USDC
 * Uses one of the old Challenge wallets (they have ~9 EGLD each)
 *
 * Step 1: Send EGLD to shard-local wrapper with data "wrapEgld"
 * Step 2: Swap WEGLD → USDC via xExchange pair contract
 *
 * Usage: npx ts-node scripts/10_kepler_swap.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const GATEWAY_URL = "https://gateway.battleofnodes.com";
const CHAIN_ID = "B";

// Wrapper contracts by shard (from Lukas)
const WRAPPER_CONTRACTS: Record<number, string> = {
  0: "erd1qqqqqqqqqqqqqpgqvc7gdl0p4s97guh498wgz75k8sav6sjfjlwqh679jy",
  1: "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44jurgn29psua5l2jps3ntjj3",
  2: "erd1qqqqqqqqqqqqqpgqmuk0q2saj0mgutxm4teywre6dl8wqf58xamqdrukln",
};

// xExchange WEGLD/USDC pair (from BoN API)
const PAIR_CONTRACT = "erd1qqqqqqqqqqqqqpgqeel2kumf0r8ffyhth7pqdujjat9nx0862jpsg2pqaq";

// Amount to wrap (5 EGLD — should give ~22 USDC at current price ~4.5)
const WRAP_AMOUNT = BigInt("5000000000000000000"); // 5 EGLD

function getWalletShard(address: string): number {
  const pubkey = new Address(address).getPublicKey();
  const lastByte = pubkey[pubkey.length - 1];
  let shard = lastByte & 3;
  if (shard > 2) shard = lastByte & 1;
  return shard;
}

function toHex(str: string): string {
  return Buffer.from(str).toString("hex");
}

async function main() {
  console.log("🔄 KEPLER SETUP — EGLD → WEGLD → USDC\n");

  const httpsAgent = new https.Agent({ maxSockets: 10, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, {
    clientName: "OpenHeart-Swap", httpsAgent, timeout: 30_000
  } as any);
  const txComputer = new TransactionComputer();

  // Use first old wallet (has ~9 EGLD)
  const wallets = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );
  const wallet = wallets[0];
  const shard = getWalletShard(wallet.address);
  console.log(`📍 Using wallet: ${wallet.address.slice(0, 20)}...`);
  console.log(`📍 Shard: ${shard}`);

  const sk = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(sk);
  const addr = new Address(wallet.address);

  // Get nonce & balance
  const acc = await provider.getAccount({ bech32: () => wallet.address });
  const balance = Number(acc.balance.dividedBy("1000000000000000000"));
  console.log(`💰 Balance: ${balance.toFixed(4)} EGLD`);
  console.log(`🔢 Nonce: ${acc.nonce}`);

  if (balance < 6) {
    console.log("❌ Not enough EGLD (need ~6 for wrap + gas)");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════
  // STEP 1: Wrap EGLD → WEGLD
  // ═══════════════════════════════════════════════════
  console.log("\n📦 STEP 1: Wrapping 5 EGLD → WEGLD...");
  const wrapperAddr = WRAPPER_CONTRACTS[shard];
  console.log(`   Wrapper (Shard ${shard}): ${wrapperAddr.slice(0, 25)}...`);

  const wrapTx = new Transaction({
    nonce: BigInt(acc.nonce),
    value: WRAP_AMOUNT,
    sender: addr,
    receiver: new Address(wrapperAddr),
    gasLimit: BigInt(10_000_000), // SC call needs more gas
    gasPrice: BigInt(1_000_000_000),
    chainID: CHAIN_ID,
    data: new Uint8Array(Buffer.from("wrapEgld")),
  });
  wrapTx.signature = await signer.sign(txComputer.computeBytesForSigning(wrapTx));

  try {
    const wrapHash = await provider.sendTransaction(wrapTx);
    console.log(`   ✅ Wrap TX sent: ${wrapHash}`);
    console.log(`   🔍 Check: https://bon-explorer.multiversx.com/transactions/${wrapHash}`);
  } catch (e: any) {
    console.log(`   ❌ Wrap failed: ${e.message}`);
    process.exit(1);
  }

  // Wait for wrap to process
  console.log("   ⏳ Waiting 15s for wrap to process...");
  await new Promise(r => setTimeout(r, 15_000));

  // ═══════════════════════════════════════════════════
  // STEP 2: Swap WEGLD → USDC via xExchange
  // ═══════════════════════════════════════════════════
  console.log("\n💱 STEP 2: Swapping WEGLD → USDC...");

  // ESDTTransfer format:
  // ESDTTransfer@<token_id_hex>@<amount_hex>@<function_hex>@<arg1_hex>@<arg2_hex>
  // token: WEGLD-bd4d79
  // function: swapTokensFixedInput
  // arg1: USDC-c76f1f (desired token)
  // arg2: 1 (minimum out = 1 = accept any price, we just need USDC)

  const tokenHex = toHex("WEGLD-bd4d79");
  const amountHex = WRAP_AMOUNT.toString(16); // 5 EGLD in hex
  const functionHex = toHex("swapTokensFixedInput");
  const desiredTokenHex = toHex("USDC-c76f1f");
  const minOutHex = "01"; // minimum 1 unit (we accept any price)

  const swapData = `ESDTTransfer@${tokenHex}@${amountHex}@${functionHex}@${desiredTokenHex}@${minOutHex}`;
  console.log(`   Data: ${swapData.slice(0, 80)}...`);

  const swapTx = new Transaction({
    nonce: BigInt(acc.nonce + 1),
    value: BigInt(0),
    sender: addr,
    receiver: new Address(PAIR_CONTRACT),
    gasLimit: BigInt(50_000_000), // DEX swap needs ~30-50M gas
    gasPrice: BigInt(1_000_000_000),
    chainID: CHAIN_ID,
    data: new Uint8Array(Buffer.from(swapData)),
  });
  swapTx.signature = await signer.sign(txComputer.computeBytesForSigning(swapTx));

  try {
    const swapHash = await provider.sendTransaction(swapTx);
    console.log(`   ✅ Swap TX sent: ${swapHash}`);
    console.log(`   🔍 Check: https://bon-explorer.multiversx.com/transactions/${swapHash}`);
  } catch (e: any) {
    console.log(`   ❌ Swap failed: ${e.message}`);
    process.exit(1);
  }

  console.log("\n⏳ Waiting 15s for swap to finalize...");
  await new Promise(r => setTimeout(r, 15_000));

  // ═══════════════════════════════════════════════════
  // STEP 3: Transfer USDC to GL wallet for Kepler
  // ═══════════════════════════════════════════════════
  const glHex = process.env.GL_PRIVATE_KEY;
  if (glHex) {
    const glSk = UserSecretKey.fromString(glHex);
    const glAddr = new UserSigner(glSk).getAddress().bech32();
    console.log(`\n📤 STEP 3: Transfer USDC to GL wallet (${glAddr.slice(0,20)}...)...`);

    // Check USDC balance first
    try {
      const tokens: any[] = (await (await fetch(
        `https://api.battleofnodes.com/accounts/${wallet.address}/tokens?identifier=USDC-c76f1f`
      )).json()) as any[];
      if (tokens.length > 0) {
        const usdcBalance = tokens[0].balance;
        console.log(`   USDC balance: ${Number(usdcBalance) / 1e6} USDC`);

        // Transfer all USDC to GL
        const transferData = `ESDTTransfer@${toHex("USDC-c76f1f")}@${BigInt(usdcBalance).toString(16)}`;
        const transferTx = new Transaction({
          nonce: BigInt(acc.nonce + 2),
          value: BigInt(0),
          sender: addr,
          receiver: new Address(glAddr),
          gasLimit: BigInt(500_000),
          gasPrice: BigInt(1_000_000_000),
          chainID: CHAIN_ID,
          data: new Uint8Array(Buffer.from(transferData)),
        });
        transferTx.signature = await signer.sign(txComputer.computeBytesForSigning(transferTx));
        const transferHash = await provider.sendTransaction(transferTx);
        console.log(`   ✅ Transfer TX: ${transferHash}`);
      } else {
        console.log("   ⚠️ No USDC found yet — check explorer for swap status");
      }
    } catch (e: any) {
      console.log(`   ⚠️ Couldn't check USDC balance: ${e.message}`);
    }
  }

  console.log("\n" + "═".repeat(50));
  console.log("📊 DONE!");
  console.log("   Next: Login to bon-kepler.projectx.mx with GL wallet");
  console.log("   The USDC should be in the GL wallet for the plan purchase");
  console.log("═".repeat(50));

  httpsAgent.destroy();
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
