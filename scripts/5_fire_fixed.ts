/**
 * 🔧 FIXED Window B — Respects 100-nonce-ahead mempool limit
 * 
 * MultiversX mempool drops transactions with nonce > onChainNonce + 100.
 * This script uses a sliding window: send 95 txs, wait for on-chain 
 * nonces to catch up, then send more.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

// ═══════════════════════════════════════════════════════════════
const GATEWAY_URL         = "https://gateway.battleofnodes.com";
const TX_VALUE            = BigInt(0);
const GAS_LIMIT           = BigInt(50_000);
const GAS_PRICE           = BigInt(1_000_000_000);
const MAX_NONCE_AHEAD     = 95;         // limit: 100, we use 95 for safety
const MAX_TX_PER_WALLET   = 20_000;     // Window B budget
const DURATION_MINUTES    = 30;
const STATS_INTERVAL_MS   = 5_000;
const NONCE_POLL_MS       = 2_000;      // check on-chain nonce every 2s
const WALLET_CONCURRENCY  = 500;        // all wallets at once
const SEND_CONCURRENCY    = 100;        // max parallel HTTP sends
// ═══════════════════════════════════════════════════════════════

interface WalletEntry { address: string; privateKey: string; }

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];
  constructor(p: number) { this.permits = p; }
  async acquire() {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise<void>(r => this.queue.push(r));
  }
  release() {
    if (this.queue.length > 0) this.queue.shift()!();
    else this.permits++;
  }
}

let totalSent = 0;
let totalErrors = 0;
let endTime = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Sliding-window wallet: respect 100-nonce-ahead ───────────
async function fireWallet(
  wallet: WalletEntry,
  provider: ProxyNetworkProvider,
  chainID: string,
  sendSem: Semaphore,
): Promise<number> {
  const secretKey = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(wallet.address);
  const iAddr = { bech32: () => wallet.address };
  const txComputer = new TransactionComputer();

  let sent = 0;
  let nextNonceToSend: number;
  let onChainNonce: number;

  // Get initial on-chain nonce
  try {
    const acc = await provider.getAccount(iAddr);
    onChainNonce = acc.nonce;
    nextNonceToSend = onChainNonce;
  } catch {
    return 0;
  }

  while (sent < MAX_TX_PER_WALLET && Date.now() < endTime) {
    // How many can we send? (stay within 95 nonces ahead of on-chain)
    const canSend = Math.max(0, (onChainNonce + MAX_NONCE_AHEAD) - nextNonceToSend);
    
    if (canSend === 0) {
      // Wait and re-check on-chain nonce
      await sleep(NONCE_POLL_MS);
      try {
        const acc = await provider.getAccount(iAddr);
        onChainNonce = acc.nonce;
      } catch { /* retry next loop */ }
      continue;
    }

    const batchSize = Math.min(canSend, MAX_TX_PER_WALLET - sent);
    
    // Build and sign batch
    const txs: Transaction[] = [];
    for (let i = 0; i < batchSize; i++) {
      const tx = new Transaction({
        nonce: BigInt(nextNonceToSend + i),
        value: TX_VALUE,
        sender: senderAddress,
        receiver: senderAddress,
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        chainID: chainID,
        data: new Uint8Array(),
      });
      tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
      txs.push(tx);
    }

    // Send (with concurrency gate)
    await sendSem.acquire();
    try {
      await provider.sendTransactions(txs);
      sent += batchSize;
      nextNonceToSend += batchSize;
      totalSent += batchSize;
    } catch {
      totalErrors++;
      nextNonceToSend += batchSize; // still advance to avoid retrying same nonces
    } finally {
      sendSem.release();
    }

    // After sending, poll nonce to see how much was processed
    try {
      const acc = await provider.getAccount(iAddr);
      onChainNonce = acc.nonce;
    } catch { /* use stale nonce, retry next loop */ }
  }

  return sent;
}

function fmt(s: number): string {
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🔧 FIXED WINDOW B — 100-NONCE SLIDING WINDOW");
  console.log("█  Respects mempool limit. No wasted transactions.");
  console.log("█".repeat(60) + "\n");

  const wallets: WalletEntry[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );
  console.log(`📋 ${wallets.length} wallets loaded`);

  const httpsAgent = new https.Agent({ maxSockets: 400, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, { httpsAgent, timeout: 30_000 } as any);

  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  console.log(`🌐 Chain: ${chainID}`);
  console.log(`⚙️  Max nonce ahead: ${MAX_NONCE_AHEAD} | Send concurrency: ${SEND_CONCURRENCY}`);

  console.log(`\n🚀 FIRING NOW — sliding window mode!\n`);

  const startTime = Date.now();
  endTime = startTime + DURATION_MINUTES * 60 * 1000;

  // Live stats
  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txps = Math.round(totalSent / elapsed);
    const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    const fees = (totalSent * 0.00005).toFixed(4);
    console.log(
      `📊 [${fmt(elapsed)}] ${totalSent.toLocaleString()} tx | ${txps.toLocaleString()} tx/s | Fees: ${fees} EGLD | Err: ${totalErrors} | ${remaining}s left`
    );
  }, STATS_INTERVAL_MS);

  const sendSem = new Semaphore(SEND_CONCURRENCY);

  const results = await Promise.all(
    wallets.map(w => fireWallet(w, provider, chainID, sendSem))
  );

  clearInterval(statsTimer);

  const total = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "█".repeat(60));
  console.log("█  WINDOW B — FINAL");
  console.log("█".repeat(60));
  console.log(`   Transactions: ${total.toLocaleString()}`);
  console.log(`   Duration:     ${elapsed}s`);
  console.log(`   Avg tx/sec:   ${Math.round(total / parseFloat(elapsed)).toLocaleString()}`);
  console.log(`   Fees:         ${(total * 0.00005).toFixed(4)} EGLD`);
  console.log(`   Errors:       ${totalErrors}`);
  console.log("█".repeat(60) + "\n");

  httpsAgent.destroy();
  process.exit(0);
}

main().catch(err => { console.error("❌", err); process.exit(1); });
