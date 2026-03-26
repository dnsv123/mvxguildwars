/**
 * ═══════════════════════════════════════════════════════════════
 *  🚀 SUPERNOVA SURGE — DEFINITIVE ORCHESTRATOR
 *  Challenge 2: 600ms blocks, ~4x capacity
 * 
 *  Strategy (based on RosettaStake analysis + our lessons):
 * 
 *  1. PRE-SIGN txs in memory before window opens (~250MB)
 *  2. 3 SHARD WORKERS — each shard has independent mempool
 *  3. BLOCK HEARTBEAT — send batch_size per wallet, sleep 1 block
 *  4. BATCH = 80 tx/wallet/block (< 100 nonce limit!)
 *  5. RETRY unaccepted txs within same block window
 *  6. Pipeline: sign next round during sleep period
 * 
 *  Usage: npx ts-node scripts/7_supernova_orchestrator.ts
 *    → Leave terminal open. Everything runs automatically.
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════
//  SCHEDULE — March 16, 2026 UTC
// ═══════════════════════════════════════════════════════════════
const SCHEDULE = {
  DISTRIBUTE:     "2026-03-16T14:00:00Z",
  PREP_A:         "2026-03-16T14:00:00Z",
  WINDOW_A_START: "2026-03-16T14:00:00Z",
  WINDOW_A_END:   "2026-03-16T16:30:00Z",
  PREP_B:         "2026-03-16T16:55:00Z",
  WINDOW_B_START: "2026-03-16T17:00:00Z",
  WINDOW_B_END:   "2026-03-16T17:30:00Z",
};

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const GATEWAY_URL     = "https://gateway.battleofnodes.com";
const DISTRIBUTE_AMT  = BigInt("5000000000000000000"); // 5 EGLD
const MIN_GL_BALANCE  = 2400;
const TX_VALUE        = BigInt(0);
const GAS_LIMIT       = BigInt(50_000);
const GAS_PRICE_STD   = BigInt(1_000_000_000);

// Window A: 3x gasPrice = MAX PRIORITY!
const WINDOW_A_GAS_X  = BigInt(3);
const WINDOW_A_MAX_TX = 26_666; // per wallet
// Window B: 3x gasPrice
const WINDOW_B_GAS_X  = BigInt(3);
const WINDOW_B_MAX_TX = 6_666; // per wallet

// Block heartbeat
const BATCH_PER_WALLET = 90;     // 90 < 100 limit (10 nonces margin de siguranță)
const BLOCK_TIME_MS    = 600;    // Supernova block time
const HEARTBEAT_MS     = 650;    // 600ms + 50ms safety buffer (mai agresiv = mai mult throughput)

// Pre-sign
const PRE_SIGN_PER_WALLET = 90; // MINIMAL — fire instantly, sign inline after!

// Distribution
const DIST_BATCH  = 25;
const DIST_DELAY  = 1500;

// HTTP
const MAX_SOCKETS = 400;
const STATS_INTERVAL_MS = 5_000;
// ═══════════════════════════════════════════════════════════════

interface WalletEntry { address: string; privateKey: string; }
interface ShardGroup {
  shard: number;
  wallets: WalletEntry[];
  signers: UserSigner[];
  addresses: Address[];
}

// ─── Utility ─────────────────────────────────────────────────
function utcNow(): string { return new Date().toISOString().slice(11, 19) + " UTC"; }
function log(e: string, m: string) { console.log(`${e} [${utcNow()}] ${m}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitUntil(targetISO: string, label: string) {
  const target = new Date(targetISO).getTime();
  if (Date.now() >= target) { log("⏩", `${label} — already passed`); return; }
  log("⏳", `Waiting for ${label}...`);
  const iv = setInterval(() => {
    const rem = Math.max(0, new Date(targetISO).getTime() - Date.now());
    const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
    process.stdout.write(`\r   ⏳ ${label} in ${m}m ${s.toString().padStart(2, "0")}s...  `);
  }, 1000);
  await new Promise(r => setTimeout(r, Math.max(0, target - Date.now())));
  clearInterval(iv);
  console.log("");
  log("✅", `${label} — GO!`);
}

function getWalletShard(address: string): number {
  const addr = new Address(address);
  const pubkey = addr.getPublicKey();
  return pubkey[31] % 3;
}

// ─── Shared state ────────────────────────────────────────────
let totalSent = 0;
let totalErrors = 0;

// ═══════════════════════════════════════════════════════════════
//  DISTRIBUTE
// ═══════════════════════════════════════════════════════════════
async function distribute(
  provider: ProxyNetworkProvider,
  glKey: UserSecretKey,
  wallets: WalletEntry[],
  chainID: string,
) {
  const signer = new UserSigner(glKey);
  const glAddr = new Address(signer.getAddress().bech32());
  const iAddr = { bech32: () => glAddr.toBech32() };
  const txComputer = new TransactionComputer();

  // Poll until funds
  log("📡", `Polling GL balance (need ≥${MIN_GL_BALANCE} EGLD)...`);
  while (true) {
    try {
      const acc = await provider.getAccount(iAddr);
      const bal = Number(acc.balance.dividedBy("1000000000000000000"));
      log("💰", `GL: ${bal.toFixed(2)} EGLD`);
      if (bal >= MIN_GL_BALANCE) break;
    } catch (e: any) { log("⚠️", e.message); }
    await sleep(3000);
  }

  const acc = await provider.getAccount(iAddr);
  let nonce = acc.nonce;

  // Sign all
  log("⚙️", `Signing ${wallets.length} distribution txs...`);
  const txs: Transaction[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const tx = new Transaction({
      nonce: BigInt(nonce + i), value: DISTRIBUTE_AMT,
      sender: glAddr, receiver: new Address(wallets[i].address),
      gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE_STD,
      chainID, data: new Uint8Array(),
    });
    tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
    txs.push(tx);
  }

  // Send in rate-limited batches
  let ok = 0;
  const batches = Math.ceil(txs.length / DIST_BATCH);
  for (let b = 0; b < batches; b++) {
    const batch = txs.slice(b * DIST_BATCH, (b + 1) * DIST_BATCH);
    for (const tx of batch) {
      try { await provider.sendTransaction(tx); ok++; } catch { totalErrors++; }
    }
    log("📡", `Dist batch ${b + 1}/${batches}: ${ok}/${txs.length} sent`);
    if (b < batches - 1) await sleep(DIST_DELAY);
  }
  log("✅", `Distribution done: ${ok}/${txs.length}`);
}

// ═══════════════════════════════════════════════════════════════
//  PRE-SIGN TRANSACTIONS
// ═══════════════════════════════════════════════════════════════
async function preSignForShard(
  group: ShardGroup,
  provider: ProxyNetworkProvider,
  chainID: string,
  gasPrice: bigint,
  maxPerWallet: number,
): Promise<{ txsByWallet: Transaction[][]; nextNonces: number[] }> {
  const txComputer = new TransactionComputer();
  const count = Math.min(PRE_SIGN_PER_WALLET, maxPerWallet);

  log("⚡", `[Shard ${group.shard}] Pre-signing ${count} tx × ${group.wallets.length} wallets = ${(count * group.wallets.length).toLocaleString()} txs...`);

  // Fetch nonces
  const nonces: number[] = [];
  for (const w of group.wallets) {
    try {
      const acc = await provider.getAccount({ bech32: () => w.address });
      nonces.push(acc.nonce);
    } catch { nonces.push(0); }
  }

  const txsByWallet: Transaction[][] = [];

  for (let wi = 0; wi < group.wallets.length; wi++) {
    const signer = group.signers[wi];
    const addr = group.addresses[wi];
    const startNonce = nonces[wi];
    const walletTxs: Transaction[] = [];

    for (let i = 0; i < count; i++) {
      const tx = new Transaction({
        nonce: BigInt(startNonce + i), value: TX_VALUE,
        sender: addr, receiver: addr,
        gasLimit: GAS_LIMIT, gasPrice: gasPrice,
        chainID, data: new Uint8Array(),
      });
      tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
      walletTxs.push(tx);
    }
    txsByWallet.push(walletTxs);
  }

  const nextNonces = nonces.map(n => n + count);
  log("✅", `[Shard ${group.shard}] Pre-signed ${(count * group.wallets.length).toLocaleString()} txs`);

  return { txsByWallet, nextNonces };
}

// ═══════════════════════════════════════════════════════════════
//  FIRE — Per-Shard Worker with Block Heartbeat
// ═══════════════════════════════════════════════════════════════
async function fireShardWorker(
  group: ShardGroup,
  provider: ProxyNetworkProvider,
  chainID: string,
  gasPrice: bigint,
  maxPerWallet: number,
  windowEnd: number,
  preSigned: { txsByWallet: Transaction[][]; nextNonces: number[] },
): Promise<number> {
  const txComputer = new TransactionComputer();
  const shard = group.shard;
  const numWallets = group.wallets.length;

  // Track per-wallet state
  const sent: number[] = new Array(numWallets).fill(0);
  const queues: Transaction[][] = preSigned.txsByWallet.map(q => [...q]);
  const nextNonces = [...preSigned.nextNonces];

  let shardSent = 0;

  while (Date.now() < windowEnd) {
    // Collect current burst: batch_size txs per wallet
    const burst: Transaction[] = [];
    for (let wi = 0; wi < numWallets; wi++) {
      if (sent[wi] >= maxPerWallet) continue;

      const remaining = Math.min(BATCH_PER_WALLET, maxPerWallet - sent[wi]);

      // Pull from pre-signed queue
      const pulled = queues[wi].splice(0, remaining);
      burst.push(...pulled);

      // If queue ran out, we need to sign more inline
      const deficit = remaining - pulled.length;
      if (deficit > 0) {
        const signer = group.signers[wi];
        const addr = group.addresses[wi];
        for (let d = 0; d < deficit; d++) {
          const tx = new Transaction({
            nonce: BigInt(nextNonces[wi]), value: TX_VALUE,
            sender: addr, receiver: addr,
            gasLimit: GAS_LIMIT, gasPrice: gasPrice,
            chainID, data: new Uint8Array(),
          });
          tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
          burst.push(tx);
          nextNonces[wi]++;
        }
      }
    }

    if (burst.length === 0) break;

    // Send burst in chunks of 1000 (gateway limit per call)
    const burstStart = Date.now();
    let remaining = [...burst];
    let burstOk = 0;

    while (remaining.length > 0) {
      const chunk = remaining.splice(0, 1000);
      try {
        await provider.sendTransactions(chunk);
        burstOk += chunk.length;
      } catch {
        totalErrors++;
      }
    }

    // Update counters
    for (let wi = 0; wi < numWallets; wi++) {
      const add = Math.min(BATCH_PER_WALLET, maxPerWallet - sent[wi]);
      sent[wi] += add;
    }
    shardSent += burstOk;
    totalSent += burstOk;

    // Pipeline: sign next batch for wallets that ran out of pre-signed
    for (let wi = 0; wi < numWallets; wi++) {
      if (queues[wi].length === 0 && sent[wi] < maxPerWallet) {
        const toSign = Math.min(BATCH_PER_WALLET * 5, maxPerWallet - sent[wi]);
        const signer = group.signers[wi];
        const addr = group.addresses[wi];
        for (let s = 0; s < toSign; s++) {
          const tx = new Transaction({
            nonce: BigInt(nextNonces[wi]), value: TX_VALUE,
            sender: addr, receiver: addr,
            gasLimit: GAS_LIMIT, gasPrice: gasPrice,
            chainID, data: new Uint8Array(),
          });
          tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
          queues[wi].push(tx);
          nextNonces[wi]++;
        }
      }
    }

    // Block heartbeat: sleep remaining time to fill 1 block
    const elapsed = Date.now() - burstStart;
    const toSleep = Math.max(50, HEARTBEAT_MS - elapsed);
    await sleep(toSleep);
  }

  return shardSent;
}

function fmt(s: number): string {
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

// ═══════════════════════════════════════════════════════════════
//  FIRE WINDOW — Coordinate all 3 shard workers
// ═══════════════════════════════════════════════════════════════
async function fireWindow(
  label: string,
  provider: ProxyNetworkProvider,
  shardGroups: ShardGroup[],
  chainID: string,
  gasMultiplier: bigint,
  maxPerWallet: number,
  windowEndISO: string,
) {
  const windowEnd = new Date(windowEndISO).getTime();
  const gasPrice = GAS_PRICE_STD * gasMultiplier;
  const feePerTx = Number(GAS_LIMIT * gasPrice) / 1e18;

  totalSent = 0;
  totalErrors = 0;

  // Pre-sign for each shard
  log("⚡", `Pre-signing ${PRE_SIGN_PER_WALLET} tx/wallet for all shards...`);
  const preSignedByGroup: { txsByWallet: Transaction[][]; nextNonces: number[] }[] = [];
  for (const g of shardGroups) {
    preSignedByGroup.push(await preSignForShard(g, provider, chainID, gasPrice, maxPerWallet));
  }

  // Wait for exact start if prep finished early
  log("✅", `All pre-signed! Waiting for window start...`);

  const startTime = Date.now();

  // Stats timer
  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txps = elapsed > 0 ? Math.round(totalSent / elapsed) : 0;
    const rem = Math.max(0, Math.round((windowEnd - Date.now()) / 1000));
    log("📊", `${label} | ${totalSent.toLocaleString()} tx | ${txps.toLocaleString()} tx/s | Fees: ${(totalSent * feePerTx).toFixed(2)} EGLD | Err: ${totalErrors} | ${rem}s left`);
  }, STATS_INTERVAL_MS);

  // 🔥 FIRE 3 SHARD WORKERS IN PARALLEL
  log("🔥", `${label} — 3 SHARD WORKERS FIRING! (${gasMultiplier}x gasPrice, ${maxPerWallet.toLocaleString()} max/wallet, ${BATCH_PER_WALLET} per block)`);

  const results = await Promise.all(
    shardGroups.map((g, i) =>
      fireShardWorker(g, provider, chainID, gasPrice, maxPerWallet, windowEnd, preSignedByGroup[i])
    )
  );

  clearInterval(statsTimer);

  const total = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "═".repeat(60));
  log("📊", `${label} SUMMARY`);
  console.log("═".repeat(60));
  results.forEach((r, i) => console.log(`   Shard ${i}: ${r.toLocaleString()} tx (${shardGroups[i].wallets.length} wallets)`));
  console.log(`   TOTAL:    ${total.toLocaleString()} tx in ${elapsed}s`);
  console.log(`   Avg:      ${Math.round(total / parseFloat(elapsed)).toLocaleString()} tx/s`);
  console.log(`   Fees:     ${(total * feePerTx).toFixed(4)} EGLD`);
  console.log(`   Errors:   ${totalErrors}`);
  console.log("═".repeat(60) + "\n");

  return total;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🚀 SUPERNOVA SURGE — DEFINITIVE ORCHESTRATOR");
  console.log("█  3 Shard Workers | Block Heartbeat | Pre-signed");
  console.log("█  Distribute → Window A → Break → Window B");
  console.log("█".repeat(60));
  console.log("");
  console.log("  ╔═══════════════════════════════════════════════════╗");
  console.log("  ║  💚 OpenHeart Guild — Powered by SuperVictor 💚  ║");
  console.log("  ║                                                   ║");
  console.log("  ║  Every block counts. Every transaction matters.   ║");
  console.log("  ║  We compete with code, not shortcuts.             ║");
  console.log("  ║  No custom gateways. Pure skill. Fair play.       ║");
  console.log("  ║                                                   ║");
  console.log("  ║       🔥 NEVER GIVE UP — KEEP PUSHING 🔥         ║");
  console.log("  ╚═══════════════════════════════════════════════════╝");
  console.log("");

  // GL key
  const glHex = process.env.GL_PRIVATE_KEY;
  if (!glHex) { console.error("❌ GL_PRIVATE_KEY missing in .env!"); process.exit(1); }
  const glKey = UserSecretKey.fromString(glHex);
  const glAddr = new UserSigner(glKey).getAddress().bech32();
  log("🔑", `GL: ${glAddr}`);

  // Wallets
  const wallets: WalletEntry[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );
  log("📋", `${wallets.length} wallets loaded`);

  // Group by shard
  const shardGroups: ShardGroup[] = [
    { shard: 0, wallets: [], signers: [], addresses: [] },
    { shard: 1, wallets: [], signers: [], addresses: [] },
    { shard: 2, wallets: [], signers: [], addresses: [] },
  ];

  for (const w of wallets) {
    const shard = getWalletShard(w.address);
    const g = shardGroups[shard];
    g.wallets.push(w);
    g.signers.push(new UserSigner(UserSecretKey.fromString(w.privateKey)));
    g.addresses.push(new Address(w.address));
  }

  for (const g of shardGroups) {
    log("📊", `Shard ${g.shard}: ${g.wallets.length} wallets`);
  }

  // Connect — skip network/config (gateway overloaded), we know chainID = "B"
  const httpsAgent = new https.Agent({ maxSockets: MAX_SOCKETS, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, { clientName: "OpenHeart", httpsAgent, timeout: 30_000 } as any);
  const chainID = "B";
  log("🌐", `Chain: ${chainID} (hardcoded — skip gateway config)`);

  console.log("\n📋 CONFIG:");
  console.log(`   Window A: ${WINDOW_A_GAS_X}x gas, ${WINDOW_A_MAX_TX.toLocaleString()} max/wallet`);
  console.log(`   Window B: ${WINDOW_B_GAS_X}x gas, ${WINDOW_B_MAX_TX.toLocaleString()} max/wallet`);
  console.log(`   Batch: ${BATCH_PER_WALLET}/wallet/block | Heartbeat: ${HEARTBEAT_MS}ms`);
  console.log(`   Pre-sign: ${PRE_SIGN_PER_WALLET}/wallet | Sockets: ${MAX_SOCKETS}`);

  console.log("\n📅 TIMELINE:");
  for (const [k, v] of Object.entries(SCHEDULE)) {
    console.log(`   ${k.padEnd(16)} → ${new Date(v).toISOString().slice(11, 19)} UTC`);
  }
  console.log("");

  // ── SKIP DISTRIBUTE (already done!) ──
  log("⏩", "Distribution already done — skipping!");

  // ── WINDOW A — FIRE IMMEDIATELY ──
  log("🔥", "Starting Window A IMMEDIATELY!");
  const waTx = await fireWindow("WINDOW A", provider, shardGroups, chainID, WINDOW_A_GAS_X, WINDOW_A_MAX_TX, SCHEDULE.WINDOW_A_END);

  log("⏸️", "Window A done. Break...");

  // ── WINDOW B ──
  await waitUntil(SCHEDULE.PREP_B, "WINDOW B PREP (16:55)");
  await waitUntil(SCHEDULE.WINDOW_B_START, "WINDOW B START (17:00)");
  const wbTx = await fireWindow("WINDOW B", provider, shardGroups, chainID, WINDOW_B_GAS_X, WINDOW_B_MAX_TX, SCHEDULE.WINDOW_B_END);

  // ── FINAL ──
  const feeA = Number(GAS_LIMIT * GAS_PRICE_STD * WINDOW_A_GAS_X) / 1e18;
  const feeB = Number(GAS_LIMIT * GAS_PRICE_STD * WINDOW_B_GAS_X) / 1e18;

  console.log("\n" + "█".repeat(60));
  console.log("█  SUPERNOVA SURGE — FINAL");
  console.log("█".repeat(60));
  console.log(`   Window A: ${waTx.toLocaleString()} tx (${(waTx * feeA).toFixed(2)} EGLD fees)`);
  console.log(`   Window B: ${wbTx.toLocaleString()} tx (${(wbTx * feeB).toFixed(2)} EGLD fees)`);
  console.log(`   TOTAL:    ${(waTx + wbTx).toLocaleString()} transactions`);
  console.log("█".repeat(60) + "\n");

  httpsAgent.destroy();
  process.exit(0);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
