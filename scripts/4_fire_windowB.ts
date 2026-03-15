/**
 * 🔥 OPTIMIZED Window B Fire Script
 * 
 * Key improvements over orchestrator:
 *   - 3x concurrency (150 vs 50 parallel sends)
 *   - 2x batch size (200 vs 100 txs per round)
 *   - Parallel signing (Promise.all instead of sequential await)
 *   - Multiple provider instances for connection pooling
 *   - Budget: 20,000 tx/wallet (500 EGLD ÷ 0.00005)
 * 
 * Usage: npx ts-node scripts/4_fire_windowB.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

// ═══════════════════════════════════════════════════════════════
const GATEWAY_URL        = "https://gateway.battleofnodes.com";
const TX_VALUE           = BigInt(0);
const GAS_LIMIT          = BigInt(50_000);
const GAS_PRICE          = BigInt(1_000_000_000);
const BATCH_SIZE         = 200;       // ⬆️ doubled
const MAX_CONCURRENT     = 150;       // ⬆️ tripled
const MAX_TX_PER_WALLET  = 20_000;    // Window B budget
const DURATION_MINUTES   = 31;        // 30 min + 1 min buffer
const STATS_INTERVAL_MS  = 5_000;
// ═══════════════════════════════════════════════════════════════

interface WalletEntry { address: string; privateKey: string; }

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    if (this.queue.length > 0) this.queue.shift()!();
    else this.permits++;
  }
}

let totalSent = 0;
let totalErrors = 0;
let endTime = 0;

// ─── Optimized fire: parallel signing ─────────────────────────
async function fireWallet(
  wallet: WalletEntry,
  provider: ProxyNetworkProvider,
  chainID: string,
  startNonce: number,
  semaphore: Semaphore,
): Promise<number> {
  const secretKey = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(wallet.address);
  const txComputer = new TransactionComputer();

  let nonce = startNonce;
  let sent = 0;

  while (sent < MAX_TX_PER_WALLET && Date.now() < endTime) {
    const currentBatch = Math.min(BATCH_SIZE, MAX_TX_PER_WALLET - sent);

    // Build all transactions first
    const txs: Transaction[] = [];
    for (let i = 0; i < currentBatch; i++) {
      txs.push(new Transaction({
        nonce: BigInt(nonce + i),
        value: TX_VALUE,
        sender: senderAddress,
        receiver: senderAddress,
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        chainID: chainID,
        data: new Uint8Array(),
      }));
    }

    // ⚡ PARALLEL SIGNING — all at once instead of one-by-one
    await Promise.all(txs.map(async (tx) => {
      const bytes = txComputer.computeBytesForSigning(tx);
      tx.signature = await signer.sign(bytes);
    }));

    // Send batch (gated by semaphore)
    await semaphore.acquire();
    try {
      await provider.sendTransactions(txs);
      sent += currentBatch;
      nonce += currentBatch;
      totalSent += currentBatch;
    } catch {
      totalErrors++;
      nonce += currentBatch;
    } finally {
      semaphore.release();
    }
  }

  return sent;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🔥 OPTIMIZED WINDOW B — MAX THROUGHPUT");
  console.log("█  Concurrency: 150 | Batch: 200 | Parallel Signing");
  console.log("█".repeat(60) + "\n");

  // Load wallets
  const wallets: WalletEntry[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );
  console.log(`📋 Loaded ${wallets.length} wallets`);

  // Provider with maxed-out sockets
  const httpsAgent = new https.Agent({ maxSockets: 300, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, {
    httpsAgent,
    timeout: 30_000,
  } as any);

  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  console.log(`🌐 Chain ID: ${chainID}`);

  // Fetch all nonces
  console.log(`⏳ Fetching nonces...`);
  const nonceSem = new Semaphore(100);
  const nonces: number[] = new Array(wallets.length).fill(0);

  await Promise.all(
    wallets.map(async (w, idx) => {
      await nonceSem.acquire();
      try {
        const acc = await provider.getAccount({ bech32: () => w.address });
        nonces[idx] = acc.nonce;
      } catch { nonces[idx] = 0; }
      finally { nonceSem.release(); }
    })
  );
  console.log(`✅ Nonces ready. [0]=${nonces[0]}, [499]=${nonces[499]}`);

  // Countdown
  console.log(`\n🚀 FIRING IN 3 SECONDS...`);
  await new Promise(r => setTimeout(r, 3000));

  const startTime = Date.now();
  endTime = startTime + DURATION_MINUTES * 60 * 1000;

  // Live stats
  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txps = Math.round(totalSent / elapsed);
    const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    const fees = (totalSent * 0.00005).toFixed(4);
    console.log(
      `📊 [${formatTime(elapsed)}] ` +
      `${totalSent.toLocaleString()} tx | ` +
      `${txps.toLocaleString()} tx/s | ` +
      `Fees: ${fees} EGLD | ` +
      `Err: ${totalErrors} | ` +
      `${remaining}s left`
    );
  }, STATS_INTERVAL_MS);

  // FIRE
  console.log("\n🔥 ALL 500 WALLETS FIRING — MAX POWER!\n");
  const semaphore = new Semaphore(MAX_CONCURRENT);

  const results = await Promise.all(
    wallets.map((w, idx) =>
      fireWallet(w, provider, chainID, nonces[idx], semaphore)
    )
  );

  clearInterval(statsTimer);

  const total = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "█".repeat(60));
  console.log("█  WINDOW B — FINAL RESULTS");
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
