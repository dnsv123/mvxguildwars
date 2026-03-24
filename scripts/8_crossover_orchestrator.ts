/**
 * ═══════════════════════════════════════════════════════════════
 *  🚀 CHALLENGE 3: CROSSOVER — ORCHESTRATOR
 *  Cross-shard only! Intra-shard = 0 points.
 *
 *  Strategy:
 *  1. Generate 500 NEW wallets balanced across 3 shards
 *  2. Distribute funds directly from GL
 *  3. Build cross-shard routing map (S0→S1, S1→S2, S2→S0)
 *  4. Fire with block heartbeat + retry on ALL errors
 *  5. During break: generate 500 NEW Part 2 wallets, distribute
 *  6. Fire Part 2 with 0.01 EGLD value per tx
 *
 *  Lessons learned from Challenge 2:
 *  - NO restarts — retry internally
 *  - Hardcoded chainID — skip getNetworkConfig
 *  - Minimal pre-sign (90 = instant fire)
 *  - Track on-chain nonces for real count
 *
 *  Usage: npx ts-node scripts/8_crossover_orchestrator.ts
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner, Mnemonic } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════
//  SCHEDULE — March 24, 2026 UTC
// ═══════════════════════════════════════════════════════════════
const SCHEDULE = {
  DISTRIBUTE_1:     "2026-03-24T15:45:00Z",
  PART_1_START:     "2026-03-24T16:00:00Z",
  PART_1_END:       "2026-03-24T16:30:00Z",
  DISTRIBUTE_2:     "2026-03-24T16:31:00Z",  // Start Part 2 wallet gen during break
  PART_2_START:     "2026-03-24T17:00:00Z",
  PART_2_END:       "2026-03-24T17:30:00Z",
};

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
// Gateway — change to Kepler URL if available
const GATEWAY_URL     = process.env.KEPLER_GATEWAY || "https://gateway.battleofnodes.com";

const NUM_WALLETS     = 500;
const TX_VALUE_PART1  = BigInt(1);           // 1×10⁻¹⁸ EGLD (minimum for Part 1)
const TX_VALUE_PART2  = BigInt("10000000000000000"); // 0.01 EGLD (minimum for Part 2)
const GAS_LIMIT       = BigInt(50_000);
const GAS_PRICE_STD   = BigInt(1_000_000_000);
const CHAIN_ID        = "B";                 // Hardcoded — no getNetworkConfig!

// Gas strategy: 1x for max tx count (budget-safe, cross-shard blocks less contested)
const PART_1_GAS_X    = BigInt(1);
const PART_2_GAS_X    = BigInt(1);

// BUDGET CAPS (must NOT exceed!)
const PART_1_BUDGET   = 2000; // EGLD
const PART_2_BUDGET   = 500;  // EGLD

// Part 1: fee = 0.00005/tx → 2000/0.00005 = 40M max → 80,000/wallet
const PART_1_MAX_TX   = 80_000;
// Part 2: cost = 0.01 + 0.00005 = 0.01005/tx → 500/0.01005 = 49,751 → 99/wallet
const PART_2_MAX_TX   = 99;

// Part 1: distribute ~4 EGLD each (2000/500), keep 500 for Part 2
const DIST_AMT_PART1  = BigInt("4000000000000000000"); // 4 EGLD
// Part 2: distribute ~1 EGLD each (500/500)
const DIST_AMT_PART2  = BigInt("1000000000000000000"); // 1 EGLD

// Block heartbeat (batch=500 from Lukas guide benchmark — proven optimal)
const BATCH_PER_WALLET = 500;
const HEARTBEAT_MS     = 650;

// Pre-sign (minimal for instant fire)
const PRE_SIGN_PER_WALLET = 500; // Match batch size for instant first burst

// Distribution
const DIST_BATCH  = 25;
const DIST_DELAY  = 1500;

// HTTP
const MAX_SOCKETS = 400;
const STATS_INTERVAL_MS = 5_000;

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════
interface WalletEntry { address: string; privateKey: string; }
interface ShardGroup {
  shard: number;
  wallets: WalletEntry[];
  signers: UserSigner[];
  addresses: Address[];
  receivers: Address[]; // Cross-shard receivers!
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
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
  const lastByte = pubkey[pubkey.length - 1];
  let shard = lastByte & 3;
  if (shard > 2) shard = lastByte & 1;
  return shard;
}

// ═══════════════════════════════════════════════════════════════
//  GENERATE WALLETS — balanced across 3 shards
// ═══════════════════════════════════════════════════════════════
function generateWallets(count: number, label: string): WalletEntry[] {
  log("⚙️", `Generating ${count} ${label} wallets (balanced across shards)...`);
  const wallets: WalletEntry[] = [];
  const shardCounts = [0, 0, 0];
  const targetPerShard = Math.ceil(count / 3);

  let attempts = 0;
  while (wallets.length < count && attempts < count * 20) {
    attempts++;
    const mnemonic = Mnemonic.generate();
    const sk = mnemonic.deriveKey(0);
    const signer = new UserSigner(sk);
    const addr = signer.getAddress().bech32();
    const shard = getWalletShard(addr);

    if (shardCounts[shard] < targetPerShard || wallets.length >= count - 3) {
      wallets.push({
        address: addr,
        privateKey: Buffer.from(sk.valueOf()).toString("hex"),
      });
      shardCounts[shard]++;
    }
  }

  log("✅", `Generated ${wallets.length} wallets: S0=${shardCounts[0]} S1=${shardCounts[1]} S2=${shardCounts[2]}`);
  return wallets;
}

// ═══════════════════════════════════════════════════════════════
//  BUILD CROSS-SHARD ROUTING MAP
// ═══════════════════════════════════════════════════════════════
function buildShardGroups(wallets: WalletEntry[]): ShardGroup[] {
  const groups: ShardGroup[] = [
    { shard: 0, wallets: [], signers: [], addresses: [], receivers: [] },
    { shard: 1, wallets: [], signers: [], addresses: [], receivers: [] },
    { shard: 2, wallets: [], signers: [], addresses: [], receivers: [] },
  ];

  for (const w of wallets) {
    const shard = getWalletShard(w.address);
    const g = groups[shard];
    g.wallets.push(w);
    g.signers.push(new UserSigner(UserSecretKey.fromString(w.privateKey)));
    g.addresses.push(new Address(w.address));
  }

  // Cross-shard routing: S0→S1, S1→S2, S2→S0
  for (let s = 0; s < 3; s++) {
    const targetShard = (s + 1) % 3;
    const targetAddrs = groups[targetShard].addresses;
    // Assign receivers round-robin
    for (let i = 0; i < groups[s].wallets.length; i++) {
      groups[s].receivers.push(targetAddrs[i % targetAddrs.length]);
    }
  }

  for (const g of groups) {
    log("📊", `Shard ${g.shard}: ${g.wallets.length} wallets → sends to Shard ${(g.shard + 1) % 3}`);
  }

  return groups;
}

// ═══════════════════════════════════════════════════════════════
//  SHARED STATE
// ═══════════════════════════════════════════════════════════════
let totalSent = 0;
let totalErrors = 0;

// ═══════════════════════════════════════════════════════════════
//  DISTRIBUTE FUNDS
// ═══════════════════════════════════════════════════════════════
async function distribute(
  provider: ProxyNetworkProvider,
  glKey: UserSecretKey,
  wallets: WalletEntry[],
  amount: bigint,
  label: string,
) {
  const signer = new UserSigner(glKey);
  const glAddr = new Address(signer.getAddress().bech32());
  const iAddr = { bech32: () => glAddr.toBech32() };
  const txComputer = new TransactionComputer();

  // Poll until funds
  log("📡", `[${label}] Polling GL balance...`);
  let nonce = 0;
  while (true) {
    try {
      const acc = await provider.getAccount(iAddr);
      const bal = Number(acc.balance.dividedBy("1000000000000000000"));
      nonce = acc.nonce;
      log("💰", `GL: ${bal.toFixed(2)} EGLD | nonce: ${nonce}`);
      if (bal >= 100) break; // At least 100 EGLD to proceed
    } catch (e: any) { log("⚠️", `GL poll error: ${e.message}`); }
    await sleep(3000);
  }

  // Sign all distribution txs
  log("⚙️", `[${label}] Signing ${wallets.length} distribution txs (${Number(amount) / 1e18} EGLD each)...`);
  const txs: Transaction[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const tx = new Transaction({
      nonce: BigInt(nonce + i), value: amount,
      sender: glAddr, receiver: new Address(wallets[i].address),
      gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE_STD,
      chainID: CHAIN_ID, data: new Uint8Array(),
    });
    tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
    txs.push(tx);
  }

  // Send in rate-limited batches with retry
  let ok = 0;
  const batches = Math.ceil(txs.length / DIST_BATCH);
  for (let b = 0; b < batches; b++) {
    const batch = txs.slice(b * DIST_BATCH, (b + 1) * DIST_BATCH);
    for (const tx of batch) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await provider.sendTransaction(tx); ok++; break; }
        catch { if (attempt < 2) await sleep(500); else totalErrors++; }
      }
    }
    log("📡", `[${label}] Dist batch ${b + 1}/${batches}: ${ok}/${txs.length} sent`);
    if (b < batches - 1) await sleep(DIST_DELAY);
  }
  log("✅", `[${label}] Distribution done: ${ok}/${txs.length}`);
}

// ═══════════════════════════════════════════════════════════════
//  PRE-SIGN CROSS-SHARD TRANSACTIONS
// ═══════════════════════════════════════════════════════════════
async function preSignForShard(
  group: ShardGroup,
  provider: ProxyNetworkProvider,
  gasPrice: bigint,
  txValue: bigint,
  maxPerWallet: number,
): Promise<{ txsByWallet: Transaction[][]; nextNonces: number[] }> {
  const txComputer = new TransactionComputer();
  const count = Math.min(PRE_SIGN_PER_WALLET, maxPerWallet);

  log("⚡", `[Shard ${group.shard}] Pre-signing ${count} tx × ${group.wallets.length} wallets...`);

  // Fetch nonces with retry
  const nonces: number[] = [];
  for (const w of group.wallets) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const acc = await provider.getAccount({ bech32: () => w.address });
        nonces.push(acc.nonce);
        break;
      } catch {
        if (attempt === 2) nonces.push(0);
        else await sleep(300);
      }
    }
  }

  const txsByWallet: Transaction[][] = [];

  for (let wi = 0; wi < group.wallets.length; wi++) {
    const signer = group.signers[wi];
    const addr = group.addresses[wi];
    const receiver = group.receivers[wi]; // CROSS-SHARD receiver!
    const startNonce = nonces[wi];
    const walletTxs: Transaction[] = [];

    for (let i = 0; i < count; i++) {
      const tx = new Transaction({
        nonce: BigInt(startNonce + i),
        value: txValue,
        sender: addr,
        receiver: receiver,  // ← CROSS-SHARD!
        gasLimit: GAS_LIMIT,
        gasPrice: gasPrice,
        chainID: CHAIN_ID,
        data: new Uint8Array(),
      });
      tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
      walletTxs.push(tx);
    }
    txsByWallet.push(walletTxs);
  }

  const nextNonces = nonces.map(n => n + count);
  log("✅", `[Shard ${group.shard}] Pre-signed ${(count * group.wallets.length).toLocaleString()} cross-shard txs`);

  return { txsByWallet, nextNonces };
}

// ═══════════════════════════════════════════════════════════════
//  FIRE — Per-Shard Worker with Block Heartbeat
// ═══════════════════════════════════════════════════════════════
async function fireShardWorker(
  group: ShardGroup,
  provider: ProxyNetworkProvider,
  gasPrice: bigint,
  txValue: bigint,
  maxPerWallet: number,
  windowEnd: number,
  preSigned: { txsByWallet: Transaction[][]; nextNonces: number[] },
): Promise<number> {
  const txComputer = new TransactionComputer();
  const shard = group.shard;
  const numWallets = group.wallets.length;

  const sent: number[] = new Array(numWallets).fill(0);
  const queues: Transaction[][] = preSigned.txsByWallet.map(q => [...q]);
  const nextNonces = [...preSigned.nextNonces];

  let shardSent = 0;

  while (Date.now() < windowEnd) {
    const burst: Transaction[] = [];
    for (let wi = 0; wi < numWallets; wi++) {
      if (sent[wi] >= maxPerWallet) continue;

      const remaining = Math.min(BATCH_PER_WALLET, maxPerWallet - sent[wi]);

      // Pull from pre-signed queue
      const pulled = queues[wi].splice(0, remaining);
      burst.push(...pulled);

      // Sign more inline if needed
      const deficit = remaining - pulled.length;
      if (deficit > 0) {
        const signer = group.signers[wi];
        const addr = group.addresses[wi];
        const receiver = group.receivers[wi]; // CROSS-SHARD!
        for (let d = 0; d < deficit; d++) {
          const tx = new Transaction({
            nonce: BigInt(nextNonces[wi]),
            value: txValue,
            sender: addr,
            receiver: receiver,  // ← CROSS-SHARD!
            gasLimit: GAS_LIMIT,
            gasPrice: gasPrice,
            chainID: CHAIN_ID,
            data: new Uint8Array(),
          });
          tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
          burst.push(tx);
          nextNonces[wi]++;
        }
      }
    }

    if (burst.length === 0) break;

    // Send burst in chunks of 1000 with retry
    const burstStart = Date.now();
    let remaining = [...burst];
    let burstOk = 0;

    while (remaining.length > 0) {
      const chunk = remaining.splice(0, 1000);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await provider.sendTransactions(chunk);
          burstOk += chunk.length;
          break;
        } catch {
          totalErrors++;
          if (attempt < 2) await sleep(200);
        }
      }
    }

    // Update counters
    for (let wi = 0; wi < numWallets; wi++) {
      const add = Math.min(BATCH_PER_WALLET, maxPerWallet - sent[wi]);
      sent[wi] += add;
    }
    shardSent += burstOk;
    totalSent += burstOk;

    // Pipeline: sign next batch for wallets that ran out
    for (let wi = 0; wi < numWallets; wi++) {
      if (queues[wi].length === 0 && sent[wi] < maxPerWallet) {
        const toSign = Math.min(BATCH_PER_WALLET * 5, maxPerWallet - sent[wi]);
        const signer = group.signers[wi];
        const addr = group.addresses[wi];
        const receiver = group.receivers[wi];
        for (let s = 0; s < toSign; s++) {
          const tx = new Transaction({
            nonce: BigInt(nextNonces[wi]),
            value: txValue,
            sender: addr,
            receiver: receiver,
            gasLimit: GAS_LIMIT,
            gasPrice: gasPrice,
            chainID: CHAIN_ID,
            data: new Uint8Array(),
          });
          tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
          queues[wi].push(tx);
          nextNonces[wi]++;
        }
      }
    }

    // Block heartbeat
    const elapsed = Date.now() - burstStart;
    const toSleep = Math.max(50, HEARTBEAT_MS - elapsed);
    await sleep(toSleep);
  }

  return shardSent;
}

// ═══════════════════════════════════════════════════════════════
//  FIRE WINDOW — Coordinate all 3 shard workers
// ═══════════════════════════════════════════════════════════════
async function fireWindow(
  label: string,
  provider: ProxyNetworkProvider,
  shardGroups: ShardGroup[],
  gasMultiplier: bigint,
  txValue: bigint,
  maxPerWallet: number,
  windowEndISO: string,
) {
  const windowEnd = new Date(windowEndISO).getTime();
  const gasPrice = GAS_PRICE_STD * gasMultiplier;
  const feePerTx = Number(GAS_LIMIT * gasPrice) / 1e18;
  const valuePerTx = Number(txValue) / 1e18;

  totalSent = 0;
  totalErrors = 0;

  // Pre-sign for each shard
  log("⚡", `Pre-signing ${PRE_SIGN_PER_WALLET} tx/wallet for all shards...`);
  const preSignedByGroup: { txsByWallet: Transaction[][]; nextNonces: number[] }[] = [];
  for (const g of shardGroups) {
    preSignedByGroup.push(await preSignForShard(g, provider, gasPrice, txValue, maxPerWallet));
  }

  log("✅", `All pre-signed! Firing...`);

  const startTime = Date.now();

  // Stats + Checkpoint timer (save progress every cycle!)
  const logFile = path.join(__dirname, "..", "run.log");
  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txps = elapsed > 0 ? Math.round(totalSent / elapsed) : 0;
    const rem = Math.max(0, Math.round((windowEnd - Date.now()) / 1000));
    const totalCost = totalSent * (feePerTx + valuePerTx);
    const msg = `${label} | ${totalSent.toLocaleString()} cross-shard tx | ${txps.toLocaleString()} tx/s | Cost: ${totalCost.toFixed(2)} EGLD | Err: ${totalErrors} | ${rem}s left`;
    log("📊", msg);
    // Checkpoint: save progress to file (crash-safe proof)
    try {
      const checkpoint = { label, totalSent, totalErrors, txps, elapsed: elapsed.toFixed(1), costEGLD: totalCost.toFixed(4), timestamp: new Date().toISOString() };
      fs.writeFileSync(path.join(__dirname, "..", "checkpoint.json"), JSON.stringify(checkpoint, null, 2));
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  }, STATS_INTERVAL_MS);

  // 🔥 FIRE ALL 3 SHARD WORKERS
  log("🔥", `${label} — 3 SHARD WORKERS FIRING CROSS-SHARD! (${gasMultiplier}x gas, ${maxPerWallet.toLocaleString()} max/wallet, value=${Number(txValue)/1e18} EGLD)`);

  const results = await Promise.all(
    shardGroups.map((g, i) =>
      fireShardWorker(g, provider, gasPrice, txValue, maxPerWallet, windowEnd, preSignedByGroup[i])
    )
  );

  clearInterval(statsTimer);

  const total = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "═".repeat(60));
  log("📊", `${label} SUMMARY`);
  console.log("═".repeat(60));
  results.forEach((r, i) => {
    const g = shardGroups[i];
    console.log(`   Shard ${i} → Shard ${(i+1)%3}: ${r.toLocaleString()} tx (${g.wallets.length} wallets)`);
  });
  console.log(`   TOTAL:    ${total.toLocaleString()} cross-shard tx in ${elapsed}s`);
  console.log(`   Avg:      ${Math.round(total / parseFloat(elapsed)).toLocaleString()} tx/s`);
  console.log(`   Fees:     ${(total * feePerTx).toFixed(4)} EGLD`);
  console.log(`   Value:    ${(total * valuePerTx).toFixed(4)} EGLD`);
  console.log(`   Errors:   ${totalErrors}`);
  console.log("═".repeat(60) + "\n");

  return total;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🚀 CHALLENGE 3: CROSSOVER — ORCHESTRATOR");
  console.log("█  Cross-Shard Only | 3 Shard Workers | Block Heartbeat");
  console.log("█  Part 1 → Break (gen Part 2 wallets) → Part 2");
  console.log("█".repeat(60));
  console.log("");
  console.log("  ╔═══════════════════════════════════════════════════╗");
  console.log("  ║  💚 OpenHeart Guild — Powered by SuperVictor 💚  ║");
  console.log("  ║                                                   ║");
  console.log("  ║  Cross-shard mastery. Route smarter. Score more.  ║");
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

  // Connect — with Kepler API key if available
  const httpsAgent = new https.Agent({ maxSockets: MAX_SOCKETS, keepAlive: true });
  const keplerKey = process.env.KEPLER_API_KEY;
  const providerConfig: any = { clientName: "OpenHeart", httpsAgent, timeout: 30_000 };
  if (keplerKey) {
    providerConfig.headers = { "api-key": keplerKey };
    log("🔑", `Kepler API key: ${keplerKey.slice(0, 8)}...`);
  }
  const provider = new ProxyNetworkProvider(GATEWAY_URL, providerConfig);
  log("🌐", `Gateway: ${GATEWAY_URL}`);
  log("🌐", `Chain: ${CHAIN_ID} (hardcoded)`);

  console.log("\n📋 CONFIG:");
  console.log(`   Part 1: ${PART_1_GAS_X}x gas, ${PART_1_MAX_TX.toLocaleString()} max/wallet, value=${Number(TX_VALUE_PART1)/1e18}`);
  console.log(`   Part 2: ${PART_2_GAS_X}x gas, ${PART_2_MAX_TX.toLocaleString()} max/wallet, value=${Number(TX_VALUE_PART2)/1e18}`);
  console.log(`   Batch: ${BATCH_PER_WALLET}/wallet/block | Heartbeat: ${HEARTBEAT_MS}ms`);

  console.log("\n📅 TIMELINE:");
  for (const [k, v] of Object.entries(SCHEDULE)) {
    console.log(`   ${k.padEnd(16)} → ${new Date(v).toISOString().slice(11, 19)} UTC`);
  }
  console.log("");

  // ═══════════════════════════════════════════════════════════
  //  PART 1
  // ═══════════════════════════════════════════════════════════
  await waitUntil(SCHEDULE.DISTRIBUTE_1, "PART 1 DISTRIBUTION (15:45)");

  // Generate Part 1 wallets
  const wallets1 = generateWallets(NUM_WALLETS, "Part 1");
  fs.writeFileSync(path.join(__dirname, "..", "wallets_part1.json"), JSON.stringify(wallets1, null, 2));
  log("💾", "Part 1 wallets saved to wallets_part1.json");

  // Build cross-shard routing
  const groups1 = buildShardGroups(wallets1);

  // Distribute
  await distribute(provider, glKey, wallets1, DIST_AMT_PART1, "Part 1");

  // Wait and fire
  await waitUntil(SCHEDULE.PART_1_START, "PART 1 START (16:00)");
  const p1Tx = await fireWindow("PART 1", provider, groups1, PART_1_GAS_X, TX_VALUE_PART1, PART_1_MAX_TX, SCHEDULE.PART_1_END);

  log("⏸️", "Part 1 done. Starting Part 2 wallet generation...");

  // ═══════════════════════════════════════════════════════════
  //  BREAK — Generate Part 2 wallets
  // ═══════════════════════════════════════════════════════════
  const wallets2 = generateWallets(NUM_WALLETS, "Part 2");
  fs.writeFileSync(path.join(__dirname, "..", "wallets_part2.json"), JSON.stringify(wallets2, null, 2));
  log("💾", "Part 2 wallets saved to wallets_part2.json");

  const groups2 = buildShardGroups(wallets2);

  // Distribute Part 2 funds
  await distribute(provider, glKey, wallets2, DIST_AMT_PART2, "Part 2");

  // Wait and fire
  await waitUntil(SCHEDULE.PART_2_START, "PART 2 START (17:00)");
  const p2Tx = await fireWindow("PART 2", provider, groups2, PART_2_GAS_X, TX_VALUE_PART2, PART_2_MAX_TX, SCHEDULE.PART_2_END);

  // ═══════════════════════════════════════════════════════════
  //  FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════
  const fee1 = Number(GAS_LIMIT * GAS_PRICE_STD * PART_1_GAS_X) / 1e18;
  const fee2 = Number(GAS_LIMIT * GAS_PRICE_STD * PART_2_GAS_X) / 1e18;
  const val2 = Number(TX_VALUE_PART2) / 1e18;

  console.log("\n" + "█".repeat(60));
  console.log("█  CHALLENGE 3: CROSSOVER — FINAL");
  console.log("█".repeat(60));
  console.log(`   Part 1: ${p1Tx.toLocaleString()} cross-shard tx (${(p1Tx * fee1).toFixed(2)} EGLD fees)`);
  console.log(`   Part 2: ${p2Tx.toLocaleString()} cross-shard tx (${(p2Tx * (fee2 + val2)).toFixed(2)} EGLD total)`);
  console.log(`   TOTAL:  ${(p1Tx + p2Tx).toLocaleString()} cross-shard transactions`);
  console.log("█".repeat(60) + "\n");

  httpsAgent.destroy();
  process.exit(0);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
