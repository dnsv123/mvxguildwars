/**
 * 🚀 ULTRA-OPTIMIZED Window B — MAX THROUGHPUT
 * 
 * Optimizations vs previous scripts:
 *   1. PIPELINE: signs next batch WHILE current batch is in-flight
 *   2. PRE-WARM: pre-signs first 2 rounds per wallet before firing
 *   3. Concurrency: 200 parallel HTTP sends
 *   4. Max sockets: 400, keepAlive
 *   5. Parallel signing: Promise.all for entire batch
 *   6. Batch size: 100 (proven to work with gateway)
 * 
 * Usage at 17:00 UTC:  npx ts-node --max-old-space-size=4096 scripts/4_fire_windowB.ts
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
const BATCH_SIZE         = 100;        // proven to work with gateway
const MAX_CONCURRENT     = 200;        // ⬆️ aggressive concurrency
const MAX_TX_PER_WALLET  = 20_000;     // Window B budget
const DURATION_MINUTES   = 31;
const STATS_INTERVAL_MS  = 5_000;
const PRE_WARM_ROUNDS    = 3;          // pre-sign 3 rounds per wallet before firing
const WINDOW_B_START     = "2026-03-15T17:00:00Z"; // auto-wait until this time
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

// ─── Sign a full batch in parallel ────────────────────────────
function createAndSignBatch(
  signer: UserSigner,
  senderAddress: Address,
  txComputer: TransactionComputer,
  chainID: string,
  startNonce: number,
  count: number,
): Promise<Transaction[]> {
  const txs: Transaction[] = [];

  // Create all transactions first (no async needed)
  for (let i = 0; i < count; i++) {
    txs.push(new Transaction({
      nonce: BigInt(startNonce + i),
      value: TX_VALUE,
      sender: senderAddress,
      receiver: senderAddress,
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      chainID: chainID,
      data: new Uint8Array(),
    }));
  }

  // Sign all in parallel
  return Promise.all(
    txs.map(async (tx) => {
      tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
      return tx;
    })
  );
}

// ─── Pipelined wallet fire: sign next while sending current ───
async function fireWallet(
  wallet: WalletEntry,
  provider: ProxyNetworkProvider,
  txComputer: TransactionComputer,
  chainID: string,
  startNonce: number,
  preWarmed: Transaction[][],
  semaphore: Semaphore,
): Promise<number> {
  const secretKey = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(wallet.address);

  let nonce = startNonce;
  let sent = 0;

  // Use pre-warmed batches first
  let nextBatchPromise: Promise<Transaction[]> | null = null;

  // Load pre-warmed batches into a queue
  const batchQueue: Transaction[][] = [...preWarmed];
  nonce += preWarmed.length * BATCH_SIZE;

  // Pre-sign one more ahead
  if (sent + batchQueue.length * BATCH_SIZE < MAX_TX_PER_WALLET && Date.now() < endTime) {
    const count = Math.min(BATCH_SIZE, MAX_TX_PER_WALLET - sent - batchQueue.length * BATCH_SIZE);
    if (count > 0) {
      nextBatchPromise = createAndSignBatch(signer, senderAddress, txComputer, chainID, nonce, count);
      nonce += count;
    }
  }

  while (sent < MAX_TX_PER_WALLET && Date.now() < endTime) {
    // Get current batch to send
    let currentBatch: Transaction[];

    if (batchQueue.length > 0) {
      currentBatch = batchQueue.shift()!;
    } else if (nextBatchPromise) {
      currentBatch = await nextBatchPromise;
      nextBatchPromise = null;
    } else {
      // Sign new batch
      const count = Math.min(BATCH_SIZE, MAX_TX_PER_WALLET - sent);
      if (count <= 0) break;
      currentBatch = await createAndSignBatch(signer, senderAddress, txComputer, chainID, nonce, count);
      nonce += count;
    }

    // 🔥 PIPELINE: start signing NEXT batch while we send current
    const remaining = MAX_TX_PER_WALLET - sent - currentBatch.length;
    if (remaining > 0 && Date.now() < endTime && !nextBatchPromise && batchQueue.length === 0) {
      const nextCount = Math.min(BATCH_SIZE, remaining);
      nextBatchPromise = createAndSignBatch(signer, senderAddress, txComputer, chainID, nonce, nextCount);
      nonce += nextCount;
    }

    // Send current batch (gated by semaphore)
    await semaphore.acquire();
    try {
      await provider.sendTransactions(currentBatch);
      sent += currentBatch.length;
      totalSent += currentBatch.length;
    } catch {
      totalErrors++;
    } finally {
      semaphore.release();
    }
  }

  return sent;
}

function fmt(s: number): string {
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🚀 ULTRA-OPTIMIZED WINDOW B — MAXIMUM POWER");
  console.log("█  Pipeline signing | 200 concurrent | Pre-warm 3 rounds");
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

  // ─── AUTO-WAIT: countdown until 2 min before Window B ──────
  const windowBTime = new Date(WINDOW_B_START).getTime();
  const prepTime = windowBTime - 2 * 60 * 1000; // start prep 2 min before
  const nowMs = Date.now();

  if (nowMs < prepTime) {
    const waitSec = Math.round((prepTime - nowMs) / 1000);
    console.log(`\n⏳ Waiting until 16:58 UTC to start prep (${Math.floor(waitSec/60)}m ${waitSec%60}s)...`);

    const countdownTimer = setInterval(() => {
      const rem = Math.round((prepTime - Date.now()) / 1000);
      if (rem > 0) {
        const m = Math.floor(rem / 60);
        const s = rem % 60;
        process.stdout.write(`\r   ⏳ Prep starts in ${m}m ${s.toString().padStart(2, "0")}s...  `);
      }
    }, 1000);

    await new Promise(r => setTimeout(r, Math.max(0, prepTime - Date.now())));
    clearInterval(countdownTimer);
    console.log(`\n✅ Prep time! Fetching nonces + pre-warming...\n`);
  }

  // Fetch nonces
  console.log(`⏳ Fetching nonces...`);
  const sem = new Semaphore(100);
  const nonces: number[] = new Array(wallets.length).fill(0);
  await Promise.all(wallets.map(async (w, i) => {
    await sem.acquire();
    try {
      const a = await provider.getAccount({ bech32: () => w.address });
      nonces[i] = a.nonce;
    } catch { nonces[i] = 0; }
    finally { sem.release(); }
  }));
  console.log(`✅ Nonces: [0]=${nonces[0]} [249]=${nonces[249]} [499]=${nonces[499]}`);

  // ─── PRE-WARM: sign first 3 rounds for all wallets ───
  console.log(`\n⚡ Pre-warming: signing ${PRE_WARM_ROUNDS} rounds × ${wallets.length} wallets = ${(PRE_WARM_ROUNDS * BATCH_SIZE * wallets.length).toLocaleString()} txs...`);
  const txComputer = new TransactionComputer();
  const preWarmStart = Date.now();

  const allPreWarmed: Transaction[][][] = [];

  const CHUNK = 50;
  for (let c = 0; c < wallets.length; c += CHUNK) {
    const chunkEnd = Math.min(c + CHUNK, wallets.length);
    const chunkPromises = [];

    for (let w = c; w < chunkEnd; w++) {
      const wallet = wallets[w];
      const secretKey = UserSecretKey.fromString(wallet.privateKey);
      const signer = new UserSigner(secretKey);
      const addr = new Address(wallet.address);
      let n = nonces[w];

      const rounds: Promise<Transaction[]>[] = [];
      for (let r = 0; r < PRE_WARM_ROUNDS; r++) {
        const count = Math.min(BATCH_SIZE, MAX_TX_PER_WALLET - r * BATCH_SIZE);
        if (count <= 0) break;
        rounds.push(createAndSignBatch(signer, addr, txComputer, chainID, n, count));
        n += count;
      }

      chunkPromises.push(
        Promise.all(rounds).then(batches => { allPreWarmed[w] = batches; })
      );
    }

    await Promise.all(chunkPromises);
    process.stdout.write(`\r   Pre-warmed ${Math.min(c + CHUNK, wallets.length)}/${wallets.length} wallets`);
  }

  const preWarmSec = ((Date.now() - preWarmStart) / 1000).toFixed(1);
  console.log(`\n✅ Pre-warm complete in ${preWarmSec}s — ${(PRE_WARM_ROUNDS * BATCH_SIZE * wallets.length).toLocaleString()} txs ready!\n`);

  // ─── WAIT for exact Window B start time ───
  const nowMs2 = Date.now();
  if (nowMs2 < windowBTime) {
    const waitSec = Math.round((windowBTime - nowMs2) / 1000);
    console.log(`⏳ Pre-warmed & ready! Waiting ${waitSec}s for 17:00 UTC...`);
    await new Promise(r => setTimeout(r, Math.max(0, windowBTime - Date.now())));
  }

  console.log(`\n🚀 WINDOW B — GO GO GO!`);

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

  // FIRE ALL
  console.log("🔥 ALL WALLETS FIRING — ULTRA MODE!\n");
  const fireSem = new Semaphore(MAX_CONCURRENT);

  const results = await Promise.all(
    wallets.map((w, i) => {
      const preWarmedNonce = nonces[i] + (allPreWarmed[i]?.length || 0) * BATCH_SIZE;
      return fireWallet(w, provider, txComputer, chainID, preWarmedNonce, allPreWarmed[i] || [], fireSem);
    })
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
