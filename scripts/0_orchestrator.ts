import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════════
//  CHALLENGE SCHEDULE (UTC) — March 15, 2026
// ═══════════════════════════════════════════════════════════════════
const SCHEDULE = {
  DISTRIBUTE:      "2026-03-15T15:45:00Z",
  WINDOW_A_START:  "2026-03-15T16:00:00Z",
  WINDOW_A_END:    "2026-03-15T16:30:00Z",
  WINDOW_B_START:  "2026-03-15T17:00:00Z",
  WINDOW_B_END:    "2026-03-15T17:30:00Z",
};

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const GATEWAY_URL          = "https://gateway.battleofnodes.com";
const DISTRIBUTE_AMOUNT    = BigInt("5000000000000000000"); // 5 EGLD per wallet
const TX_VALUE             = BigInt(0);                     // MoveBalance value = 0
const GAS_LIMIT            = BigInt(50_000);
const GAS_PRICE            = BigInt(1_000_000_000);
const BATCH_SIZE           = 100;    // txs per wallet per round
const DISTRIBUTE_BATCH     = 50;     // wallets per distribution batch
const MAX_CONCURRENT_SENDS = 50;     // max parallel HTTP sends
const MAX_TX_WINDOW_A      = 80_000; // Window A: 2,000 EGLD ÷ 0.00005
const MAX_TX_WINDOW_B      = 20_000; // Window B:   500 EGLD ÷ 0.00005
const STATS_INTERVAL_MS    = 5_000;
const POLL_INTERVAL_MS     = 3_000;  // balance poll interval
const MIN_BALANCE_EGLD     = 2400;   // trigger distribution when balance >= this
// ═══════════════════════════════════════════════════════════════════

interface WalletEntry { address: string; privateKey: string; }

// ─── Semaphore ───────────────────────────────────────────────────
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    if (this.queue.length > 0) { this.queue.shift()!(); }
    else { this.permits++; }
  }
}

// ─── Utility ─────────────────────────────────────────────────────
function utcNow(): string {
  return new Date().toISOString().slice(11, 19) + " UTC";
}

function log(emoji: string, msg: string) {
  console.log(`${emoji} [${utcNow()}] ${msg}`);
}

async function waitUntil(targetISO: string, label: string) {
  const target = new Date(targetISO).getTime();
  const now = Date.now();
  const diff = target - now;

  if (diff <= 0) {
    log("⏩", `${label} — time already passed, proceeding immediately`);
    return;
  }

  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  log("⏳", `Waiting for ${label} — ${minutes}m ${seconds}s remaining...`);

  // Countdown every 30 seconds
  const interval = setInterval(() => {
    const remaining = new Date(targetISO).getTime() - Date.now();
    if (remaining > 0) {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      log("⏳", `${label} in ${m}m ${s}s...`);
    }
  }, 30_000);

  await new Promise((r) => setTimeout(r, Math.max(0, target - Date.now())));
  clearInterval(interval);
  log("✅", `${label} — GO!`);
}

// ─── Shared state for fire phase ─────────────────────────────────
let totalSent = 0;
let totalErrors = 0;

// ─── PHASE 1: Distribute funds from GL to 500 wallets ────────────
async function distributeFunds(
  provider: ProxyNetworkProvider,
  glSecretKey: UserSecretKey,
  wallets: WalletEntry[],
  chainID: string,
) {
  const signer = new UserSigner(glSecretKey);
  const senderAddress = new Address(signer.getAddress().bech32());
  const senderIAddress = { bech32: () => senderAddress.toBech32() };
  const txComputer = new TransactionComputer();

  // Poll until funds arrive
  log("📡", `Polling GL wallet balance... (trigger: ≥ ${MIN_BALANCE_EGLD} EGLD)`);
  while (true) {
    try {
      const account = await provider.getAccount(senderIAddress);
      const balanceEGLD = parseFloat(account.balance.dividedBy("1000000000000000000").toFixed(2));
      log("💰", `GL balance: ${balanceEGLD} EGLD`);

      if (balanceEGLD >= MIN_BALANCE_EGLD) {
        log("🎉", `Funds detected! Starting distribution...`);
        break;
      }
    } catch (err: any) {
      log("⚠️", `Balance check error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Get nonce
  const account = await provider.getAccount(senderIAddress);
  let nonce = account.nonce;

  // Build, sign, send in batches
  log("⚙️", `Building ${wallets.length} distribution transactions (5 EGLD each)...`);

  const allTxs: Transaction[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const tx = new Transaction({
      nonce: BigInt(nonce + i),
      value: DISTRIBUTE_AMOUNT,
      sender: senderAddress,
      receiver: new Address(wallets[i].address),
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      chainID: chainID,
      data: new Uint8Array(),
    });
    const bytes = txComputer.computeBytesForSigning(tx);
    tx.signature = await signer.sign(bytes);
    allTxs.push(tx);
  }
  log("✅", `Signed all ${allTxs.length} distribution txs`);

  // Broadcast in batches
  let success = 0;
  let errors = 0;
  const totalBatches = Math.ceil(allTxs.length / DISTRIBUTE_BATCH);

  for (let b = 0; b < totalBatches; b++) {
    const start = b * DISTRIBUTE_BATCH;
    const end = Math.min(start + DISTRIBUTE_BATCH, allTxs.length);
    const batch = allTxs.slice(start, end);

    const results = await Promise.all(
      batch.map(async (tx) => {
        try {
          await provider.sendTransaction(tx);
          return true;
        } catch {
          return false;
        }
      })
    );

    success += results.filter(Boolean).length;
    errors += results.filter((r) => !r).length;
    log("📡", `Distribution batch ${b + 1}/${totalBatches}: ${results.filter(Boolean).length}/${batch.length} OK`);
  }

  log("✅", `Distribution complete: ${success} sent, ${errors} failed`);
  return success;
}

// ─── PHASE 2: Fire transactions from all wallets ─────────────────
async function fireWallet(
  wallet: WalletEntry,
  provider: ProxyNetworkProvider,
  txComputer: TransactionComputer,
  chainID: string,
  startNonce: number,
  maxTx: number,
  windowEnd: number,
  semaphore: Semaphore,
): Promise<number> {
  const secretKey = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(wallet.address);

  let nonce = startNonce;
  let sent = 0;

  while (sent < maxTx && Date.now() < windowEnd) {
    const currentBatch = Math.min(BATCH_SIZE, maxTx - sent);
    const txs: Transaction[] = [];

    for (let i = 0; i < currentBatch; i++) {
      const tx = new Transaction({
        nonce: BigInt(nonce + i),
        value: TX_VALUE,
        sender: senderAddress,
        receiver: senderAddress,
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,
        chainID: chainID,
        data: new Uint8Array(),
      });
      const bytes = txComputer.computeBytesForSigning(tx);
      tx.signature = await signer.sign(bytes);
      txs.push(tx);
    }

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

async function fireWindow(
  label: string,
  provider: ProxyNetworkProvider,
  wallets: WalletEntry[],
  chainID: string,
  maxTxPerWallet: number,
  windowEndISO: string,
  httpsAgent: https.Agent,
) {
  const windowEnd = new Date(windowEndISO).getTime();
  const txComputer = new TransactionComputer();
  const semaphore = new Semaphore(MAX_CONCURRENT_SENDS);

  // Reset counters
  totalSent = 0;
  totalErrors = 0;

  // Fetch nonces
  log("⏳", `Fetching nonces for ${wallets.length} wallets...`);
  const nonceSem = new Semaphore(50);
  const nonces: number[] = new Array(wallets.length).fill(0);

  await Promise.all(
    wallets.map(async (w, idx) => {
      await nonceSem.acquire();
      try {
        const acc = await provider.getAccount({ bech32: () => w.address });
        nonces[idx] = acc.nonce;
      } catch {
        nonces[idx] = 0;
      } finally {
        nonceSem.release();
      }
    })
  );
  log("✅", `Nonces ready. Sample: wallet[0]=${nonces[0]}, wallet[499]=${nonces[499]}`);

  // Live stats
  const startTime = Date.now();
  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txPerSec = Math.round(totalSent / elapsed);
    const remaining = Math.max(0, Math.round((windowEnd - Date.now()) / 1000));
    const fees = (totalSent * 0.00005).toFixed(4);
    log("📊", `${label} | ${totalSent.toLocaleString()} tx | ${txPerSec.toLocaleString()} tx/s | Fees: ${fees} EGLD | Errors: ${totalErrors} | ${remaining}s left`);
  }, STATS_INTERVAL_MS);

  // Fire all wallets
  log("🔥", `${label} — ALL WALLETS FIRING! (max ${maxTxPerWallet.toLocaleString()} tx/wallet)`);

  const results = await Promise.all(
    wallets.map((w, idx) =>
      fireWallet(w, provider, txComputer, chainID, nonces[idx], maxTxPerWallet, windowEnd, semaphore)
    )
  );

  clearInterval(statsTimer);

  const totalTx = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const fees = (totalTx * 0.00005).toFixed(4);

  console.log("\n" + "═".repeat(60));
  log("📊", `${label} SUMMARY`);
  console.log("═".repeat(60));
  console.log(`   Total transactions:  ${totalTx.toLocaleString()}`);
  console.log(`   Duration:            ${elapsed}s`);
  console.log(`   Avg tx/sec:          ${Math.round(totalTx / parseFloat(elapsed)).toLocaleString()}`);
  console.log(`   Fees spent:          ${fees} EGLD`);
  console.log(`   Errors:              ${totalErrors}`);
  console.log("═".repeat(60) + "\n");

  return totalTx;
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  BATTLE OF NODES — TRANSACTION SPRINT ORCHESTRATOR");
  console.log("█  Full automation: Distribute → Window A → Window B");
  console.log("█".repeat(60) + "\n");

  // Load GL key
  const glPrivateKeyHex = process.env.GL_PRIVATE_KEY;
  if (!glPrivateKeyHex) {
    console.error("❌ GL_PRIVATE_KEY not found in .env!");
    process.exit(1);
  }
  const glSecretKey = UserSecretKey.fromString(glPrivateKeyHex);
  const glAddress = new UserSigner(glSecretKey).getAddress().bech32();
  log("🔑", `GL Wallet: ${glAddress}`);

  // Load wallets
  const wallets: WalletEntry[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );
  log("📋", `Loaded ${wallets.length} sending wallets`);

  // Connect to network
  const httpsAgent = new https.Agent({ maxSockets: 200, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, {
    httpsAgent,
    timeout: 30_000,
  } as any);

  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  log("🌐", `Connected | Chain ID: ${chainID}`);

  // Print schedule
  console.log("\n📅 SCHEDULE:");
  for (const [key, time] of Object.entries(SCHEDULE)) {
    const t = new Date(time);
    console.log(`   ${key.padEnd(16)} → ${t.toISOString().slice(11, 19)} UTC`);
  }
  console.log("");

  // ── PHASE 1: Wait for 15:45 UTC → Distribute ──
  await waitUntil(SCHEDULE.DISTRIBUTE, "DISTRIBUTION TIME (15:45 UTC)");
  await distributeFunds(provider, glSecretKey, wallets, chainID);

  // ── PHASE 2: Wait for 16:00 UTC → Window A ──
  await waitUntil(SCHEDULE.WINDOW_A_START, "WINDOW A START (16:00 UTC)");
  const windowATx = await fireWindow(
    "WINDOW A", provider, wallets, chainID,
    MAX_TX_WINDOW_A, SCHEDULE.WINDOW_A_END, httpsAgent
  );

  log("⏸️", "Window A complete. Break until 17:00 UTC...");

  // ── PHASE 3: Wait for 17:00 UTC → Window B ──
  await waitUntil(SCHEDULE.WINDOW_B_START, "WINDOW B START (17:00 UTC)");
  const windowBTx = await fireWindow(
    "WINDOW B", provider, wallets, chainID,
    MAX_TX_WINDOW_B, SCHEDULE.WINDOW_B_END, httpsAgent
  );

  // ── FINAL SUMMARY ──
  console.log("\n" + "█".repeat(60));
  console.log("█  CHALLENGE COMPLETE — FINAL RESULTS");
  console.log("█".repeat(60));
  console.log(`   Window A:  ${windowATx.toLocaleString()} transactions`);
  console.log(`   Window B:  ${windowBTx.toLocaleString()} transactions`);
  console.log(`   TOTAL:     ${(windowATx + windowBTx).toLocaleString()} transactions`);
  console.log(`   Fees:      ${((windowATx + windowBTx) * 0.00005).toFixed(4)} EGLD`);
  console.log("█".repeat(60) + "\n");

  httpsAgent.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
