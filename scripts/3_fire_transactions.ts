import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION — Change MAX_TX_PER_WALLET for each window:
//    Window A: 80,000 (2,000 EGLD budget ÷ 0.00005 fee/tx)
//    Window B: 20,000 (  500 EGLD budget ÷ 0.00005 fee/tx)
// ═══════════════════════════════════════════════════════════════════
const GATEWAY_URL       = "https://gateway.battleofnodes.com";
const TX_VALUE          = BigInt(0);                // minimum value (fee budget only)
const GAS_LIMIT         = BigInt(50_000);            // standard MoveBalance
const GAS_PRICE         = BigInt(1_000_000_000);     // standard gas price
const BATCH_SIZE        = 100;                       // txs signed + sent per round per wallet
const MAX_CONCURRENT    = 50;                        // max simultaneous HTTP requests
const MAX_TX_PER_WALLET = 80_000;                    // ← CHANGE TO 20,000 for Window B
const DURATION_MINUTES  = 30;                        // auto-stop after 30 minutes
const STATS_INTERVAL_MS = 5_000;                     // live stats every 5 seconds
// ═══════════════════════════════════════════════════════════════════

interface WalletEntry {
  address: string;
  privateKey: string;
}

// ─── Semaphore for concurrency control ───────────────────────────
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.permits++;
    }
  }
}

// ─── Shared state ────────────────────────────────────────────────
let totalSent = 0;
let totalErrors = 0;
let endTime = 0;

// ─── Per-wallet fire loop ────────────────────────────────────────
async function fireWallet(
  walletIdx: number,
  wallet: WalletEntry,
  provider: ProxyNetworkProvider,
  txComputer: TransactionComputer,
  chainID: string,
  startNonce: number,
  semaphore: Semaphore,
): Promise<number> {
  const secretKey = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(wallet.address);

  let nonce = startNonce;
  let sent = 0;

  while (sent < MAX_TX_PER_WALLET && Date.now() < endTime) {
    const currentBatch = Math.min(BATCH_SIZE, MAX_TX_PER_WALLET - sent);
    const txs: Transaction[] = [];

    // Sign batch
    for (let i = 0; i < currentBatch; i++) {
      const tx = new Transaction({
        nonce: BigInt(nonce + i),
        value: TX_VALUE,
        sender: senderAddress,
        receiver: senderAddress, // send to self — receiver shard irrelevant
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        chainID: chainID,
        data: new Uint8Array(),
      });

      const bytes = txComputer.computeBytesForSigning(tx);
      tx.signature = await signer.sign(bytes);
      txs.push(tx);
    }

    // Send batch (gated by semaphore)
    await semaphore.acquire();
    try {
      await provider.sendTransactions(txs);
      sent += currentBatch;
      nonce += currentBatch;
      totalSent += currentBatch;
    } catch (err: any) {
      totalErrors++;
      // Still advance nonce to avoid getting stuck on same nonce
      nonce += currentBatch;
    } finally {
      semaphore.release();
    }
  }

  return sent;
}

// ─── Live stats printer ──────────────────────────────────────────
function startStatsReporter(startTime: number): NodeJS.Timer {
  return setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txPerSec = Math.round(totalSent / elapsed);
    const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    const feesSpent = (totalSent * 0.00005).toFixed(4);

    console.log(
      `📊 [${formatTime(elapsed)}] ` +
      `Total: ${totalSent.toLocaleString()} tx | ` +
      `${txPerSec.toLocaleString()} tx/s | ` +
      `Fees: ${feesSpent} EGLD | ` +
      `Errors: ${totalErrors} | ` +
      `Remaining: ${remaining}s`
    );
  }, STATS_INTERVAL_MS);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60));
  console.log("🔥 TRANSACTION SPRINT — FIRE SCRIPT");
  console.log("═".repeat(60));
  console.log(`   Gateway:            ${GATEWAY_URL}`);
  console.log(`   Batch size:         ${BATCH_SIZE} tx/round`);
  console.log(`   Max concurrent:     ${MAX_CONCURRENT} HTTP requests`);
  console.log(`   Max tx/wallet:      ${MAX_TX_PER_WALLET.toLocaleString()}`);
  console.log(`   Duration:           ${DURATION_MINUTES} minutes`);
  console.log(`   Fee per tx:         0.00005 EGLD`);
  console.log(`   Budget cap:         ${(MAX_TX_PER_WALLET * 500 * 0.00005).toLocaleString()} EGLD`);
  console.log("═".repeat(60));

  // 1. Load wallets
  const walletsPath = path.join(__dirname, "..", "wallets.json");
  const wallets: WalletEntry[] = JSON.parse(fs.readFileSync(walletsPath, "utf-8"));
  console.log(`\n📋 Loaded ${wallets.length} wallets`);

  // 2. Connect to network with high-concurrency HTTPS agent
  const httpsAgent = new https.Agent({ maxSockets: 200, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, {
    httpsAgent: httpsAgent,
    timeout: 30_000,
  } as any);

  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  console.log(`🌐 Chain ID: ${chainID}`);

  // 3. Fetch nonces for all wallets (parallel, batched)
  console.log(`\n⏳ Fetching nonces for ${wallets.length} wallets...`);
  const nonceSemaphore = new Semaphore(50);
  const nonces: number[] = [];

  const noncePromises = wallets.map(async (w, idx) => {
    await nonceSemaphore.acquire();
    try {
      const account = await provider.getAccount({ bech32: () => w.address });
      nonces[idx] = account.nonce;
    } catch {
      nonces[idx] = 0; // fallback for new wallets
    } finally {
      nonceSemaphore.release();
    }
  });

  await Promise.all(noncePromises);
  console.log(`✅ Nonces fetched. Sample — wallet[0] nonce: ${nonces[0]}, wallet[499] nonce: ${nonces[499]}`);

  // 4. Prepare for launch
  const txComputer = new TransactionComputer();
  const semaphore = new Semaphore(MAX_CONCURRENT);

  console.log(`\n${"═".repeat(60)}`);
  console.log("🚀 FIRING IN 3 SECONDS...");
  console.log("═".repeat(60));
  await new Promise((r) => setTimeout(r, 3000));

  const startTime = Date.now();
  endTime = startTime + DURATION_MINUTES * 60 * 1000;

  // 5. Start live stats reporter
  const statsTimer = startStatsReporter(startTime);

  // 6. Fire all wallets in parallel
  console.log("\n🔥 ALL WALLETS FIRING!\n");
  const walletPromises = wallets.map((w, idx) =>
    fireWallet(idx, w, provider, txComputer, chainID, nonces[idx], semaphore)
  );

  const results = await Promise.all(walletPromises);

  // 7. Cleanup & Summary
  clearInterval(statsTimer as any);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalTxSent = results.reduce((sum, r) => sum + r, 0);
  const feesSpent = (totalTxSent * 0.00005).toFixed(4);
  const avgPerWallet = Math.round(totalTxSent / wallets.length);

  console.log("\n" + "═".repeat(60));
  console.log("📊 FINAL SUMMARY");
  console.log("═".repeat(60));
  console.log(`   Duration:            ${elapsed}s`);
  console.log(`   Total transactions:  ${totalTxSent.toLocaleString()}`);
  console.log(`   Avg tx/wallet:       ${avgPerWallet.toLocaleString()}`);
  console.log(`   Avg tx/sec:          ${Math.round(totalTxSent / parseFloat(elapsed)).toLocaleString()}`);
  console.log(`   Total fees spent:    ${feesSpent} EGLD`);
  console.log(`   Batch errors:        ${totalErrors}`);
  console.log("═".repeat(60));

  // Cleanup
  httpsAgent.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
