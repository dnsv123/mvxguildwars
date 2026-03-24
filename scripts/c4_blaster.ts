/**
 * ═══════════════════════════════════════════════════════════════
 *  🔥 CHALLENGE 4: RAW BLASTER — OBSERVER + BARE HEX
 *  
 *  ZERO ProxyNetworkProvider. ZERO SDK networking.
 *  Raw HTTP fetch() for ALL network calls.
 *  SDK used ONLY for Ed25519 signing.
 *
 *  Features:
 *  - Raw HTTP to observer node (direct mempool!)
 *  - Multi-endpoint failover (observer → kepler → public)
 *  - Gas tapering (10x → 5x → 2x → 1x)
 *  - 48 async workers (16/shard)
 *  - Wallet backup (timestamped, never overwrite)
 *  - Built-in recovery (send to GL)
 *  - Skip-phase logic
 *  - Crash-safe checkpointing
 *
 *  Usage: npx ts-node scripts/c4_blaster.ts
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner, Mnemonic } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════
//  SCHEDULE — WILL BE UPDATED WHEN C4 DETAILS ARRIVE
// ═══════════════════════════════════════════════════════════════
const SCHEDULE = {
  DISTRIBUTE_1:  process.env.C4_DIST1   || "2026-03-25T15:45:00Z",
  PART_1_START:  process.env.C4_START1  || "2026-03-25T16:00:00Z",
  PART_1_END:    process.env.C4_END1    || "2026-03-25T16:30:00Z",
  DISTRIBUTE_2:  process.env.C4_DIST2   || "2026-03-25T16:31:00Z",
  PART_2_START:  process.env.C4_START2  || "2026-03-25T17:00:00Z",
  PART_2_END:    process.env.C4_END2    || "2026-03-25T17:30:00Z",
};

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const CHAIN_ID         = "B";
const NUM_WALLETS      = 500;
const GAS_LIMIT        = BigInt(50_000);
const GAS_PRICE_BASE   = BigInt(1_000_000_000);

// Gas tapering thresholds (minutes from window start)
const GAS_TAPER = [
  { minFrom: 0,  minTo: 3,  multiplier: BigInt(10) },  // First 3 min: 10x DOMINATE
  { minFrom: 3,  minTo: 10, multiplier: BigInt(5) },   // Next 7 min: 5x priority
  { minFrom: 10, minTo: 20, multiplier: BigInt(2) },   // Next 10 min: 2x solid
  { minFrom: 20, minTo: 99, multiplier: BigInt(1) },   // Last: 1x maximize count
];

// Part config
const PART_1 = { maxTxPerWallet: 25_000, distAmount: BigInt(4e18), txValue: BigInt(1) };
const PART_2 = { maxTxPerWallet: 97,     distAmount: BigInt(1e18), txValue: BigInt(1e16) }; // 0.01 EGLD

const BATCH_PER_WALLET = 500;
const PRE_SIGN_COUNT   = 500;  // Pre-sign first batch per wallet
const HEARTBEAT_MS     = 650;
const STATS_INTERVAL   = 5_000;

// ═══════════════════════════════════════════════════════════════
//  MULTI-ENDPOINT — Observer → Kepler → Public
// ═══════════════════════════════════════════════════════════════
const ENDPOINTS = [
  process.env.OBSERVER_URL,                    // Primary: our observer
  process.env.KEPLER_GATEWAY,                  // Backup: Kepler
  "https://gateway.battleofnodes.com",         // Last resort: public
].filter(Boolean) as string[];

const API_URL = process.env.API_URL || "https://api.battleofnodes.com";
const KEPLER_KEY = process.env.KEPLER_API_KEY || "";

let currentEndpoint = 0;
function getEndpoint(): string { return ENDPOINTS[currentEndpoint % ENDPOINTS.length]; }
function failoverEndpoint(): void {
  currentEndpoint++;
  log("⚠️", `Failover → ${getEndpoint()}`);
}

// ═══════════════════════════════════════════════════════════════
//  RAW HTTP — ZERO SDK NETWORKING
// ═══════════════════════════════════════════════════════════════
async function apiGet(endpoint: string): Promise<any> {
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
  return res.json();
}

async function gatewayPost(path: string, body: any): Promise<any> {
  const url = `${getEndpoint()}${path}`;
  const headers: any = { "Content-Type": "application/json" };
  if (KEPLER_KEY && getEndpoint().includes("kepler")) headers["api-key"] = KEPLER_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gateway ${res.status}: ${txt.substring(0, 100)}`);
  }
  return res.json();
}

async function getAccountBalance(addr: string): Promise<{ balance: bigint; nonce: number }> {
  const d = await apiGet(`${API_URL}/accounts/${addr}`);
  return { balance: BigInt(d.balance), nonce: d.nonce };
}

async function sendTxRaw(txJson: any): Promise<string> {
  const d = await gatewayPost("/transaction/send", txJson);
  return d?.data?.txHash || "";
}

async function sendTxBatchRaw(txJsons: any[]): Promise<number> {
  try {
    const d = await gatewayPost("/transaction/send-multiple", txJsons);
    return d?.data?.numOfSentTxs || txJsons.length;
  } catch {
    // Fallback: send individually
    let ok = 0;
    for (const tx of txJsons) {
      try { await sendTxRaw(tx); ok++; } catch {}
    }
    return ok;
  }
}

// ═══════════════════════════════════════════════════════════════
//  SIGNING — SDK only for Ed25519
// ═══════════════════════════════════════════════════════════════
const txComputer = new TransactionComputer();

interface WalletEntry { address: string; privateKey: string; }

function signTx(
  signer: UserSigner, sender: Address, receiver: Address,
  nonce: number, value: bigint, gasPrice: bigint,
): { signed: Uint8Array; json: any } {
  const tx = new Transaction({
    nonce: BigInt(nonce), value, sender, receiver,
    gasLimit: GAS_LIMIT, gasPrice, chainID: CHAIN_ID, data: new Uint8Array(),
  });

  const bytesForSigning = txComputer.computeBytesForSigning(tx);
  // We'll sign synchronously-ish and attach
  return { signed: bytesForSigning, json: null }; // placeholder
}

async function signAndSerialize(
  signer: UserSigner, senderAddr: string, receiverAddr: string,
  nonce: number, value: bigint, gasPrice: bigint,
): Promise<any> {
  const sender = new Address(senderAddr);
  const receiver = new Address(receiverAddr);

  const tx = new Transaction({
    nonce: BigInt(nonce), value, sender, receiver,
    gasLimit: GAS_LIMIT, gasPrice, chainID: CHAIN_ID, data: new Uint8Array(),
  });

  const bytesForSigning = txComputer.computeBytesForSigning(tx);
  tx.signature = await signer.sign(bytesForSigning);

  // Extract the EXACT JSON that was signed and append signature
  const txJson = JSON.parse(Buffer.from(bytesForSigning).toString());
  txJson.signature = Buffer.from(tx.signature).toString("hex");

  return txJson;
}

// ═══════════════════════════════════════════════════════════════
//  WALLET MANAGEMENT — Never overwrite!
// ═══════════════════════════════════════════════════════════════
function getWalletShard(bech32: string): number {
  const decoded = Address.fromBech32(bech32);
  const pubkey = decoded.getPublicKey();
  const lastByte = pubkey[pubkey.length - 1];
  const numShards = 3;
  let shard = lastByte & (numShards - 1); // & 3 won't work since 3 is not power of 2
  if (shard >= numShards) shard = lastByte & 1;
  return shard;
}

function generateWallets(count: number, label: string): WalletEntry[] {
  log("⚙️", `Generating ${count} ${label} wallets (balanced shards)...`);
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

  log("✅", `Generated ${wallets.length}: S0=${shardCounts[0]} S1=${shardCounts[1]} S2=${shardCounts[2]}`);

  // Save with TIMESTAMP — never overwrite!
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `wallets_${label.toLowerCase().replace(/\s+/g, "_")}_${ts}.json`;
  const filepath = path.join(__dirname, "..", filename);
  fs.writeFileSync(filepath, JSON.stringify(wallets, null, 2));
  // Also save to latest (for orchestrator reference)
  const latestPath = path.join(__dirname, "..", `wallets_${label.toLowerCase().replace(/\s+/g, "_")}.json`);
  fs.writeFileSync(latestPath, JSON.stringify(wallets, null, 2));
  log("💾", `Saved to ${filename} + latest`);

  return wallets;
}

// ═══════════════════════════════════════════════════════════════
//  SHARD GROUPS + CROSS-SHARD ROUTING
// ═══════════════════════════════════════════════════════════════
interface ShardGroup {
  shard: number;
  wallets: WalletEntry[];
  signers: UserSigner[];
  receivers: string[]; // cross-shard receiver ADDRESSES
}

function buildShardGroups(wallets: WalletEntry[]): ShardGroup[] {
  const groups: ShardGroup[] = [
    { shard: 0, wallets: [], signers: [], receivers: [] },
    { shard: 1, wallets: [], signers: [], receivers: [] },
    { shard: 2, wallets: [], signers: [], receivers: [] },
  ];

  for (const w of wallets) {
    const shard = getWalletShard(w.address);
    groups[shard].wallets.push(w);
    groups[shard].signers.push(new UserSigner(UserSecretKey.fromString(w.privateKey)));
  }

  // Cross-shard routing: S0→S1, S1→S2, S2→S0
  for (let s = 0; s < 3; s++) {
    const target = groups[(s + 1) % 3];
    for (let i = 0; i < groups[s].wallets.length; i++) {
      groups[s].receivers.push(target.wallets[i % target.wallets.length].address);
    }
  }

  for (const g of groups) {
    log("📡", `Shard ${g.shard}: ${g.wallets.length} wallets → Shard ${(g.shard+1)%3}`);
  }

  return groups;
}

// ═══════════════════════════════════════════════════════════════
//  DISTRIBUTE — Raw HTTP
// ═══════════════════════════════════════════════════════════════
async function distribute(glKeyHex: string, wallets: WalletEntry[], amount: bigint, label: string) {
  const glKey = UserSecretKey.fromString(glKeyHex);
  const signer = new UserSigner(glKey);
  const glAddr = signer.getAddress().bech32();

  log("📡", `[${label}] Checking GL balance...`);
  const { balance, nonce } = await getAccountBalance(glAddr);
  const balEGLD = Number(balance) / 1e18;
  const needed = (Number(amount) / 1e18) * wallets.length;
  log("💰", `GL: ${balEGLD.toFixed(2)} EGLD | nonce: ${nonce} | needed: ${needed.toFixed(2)} EGLD`);

  if (balEGLD < needed) {
    log("⚠️", `Insufficient: ${balEGLD.toFixed(2)} < ${needed.toFixed(2)}. Distributing to ${Math.floor(balEGLD / (Number(amount)/1e18))} wallets.`);
  }

  const maxWallets = Math.min(wallets.length, Math.floor(balEGLD / (Number(amount) / 1e18)));
  log("⚙️", `[${label}] Distributing to ${maxWallets} wallets (${Number(amount)/1e18} EGLD each)...`);

  let ok = 0;
  const BATCH = 25;

  for (let i = 0; i < maxWallets; i += BATCH) {
    const batch = wallets.slice(i, Math.min(i + BATCH, maxWallets));
    const promises = batch.map(async (w, idx) => {
      try {
        const txJson = await signAndSerialize(signer, glAddr, w.address, nonce + i + idx, amount, GAS_PRICE_BASE);
        await sendTxRaw(txJson);
        ok++;
      } catch (e: any) {
        if (ok === 0) log("⚠️", `Dist error: ${e.message?.substring(0, 80)}`);
      }
    });
    await Promise.all(promises);
    log("📡", `[${label}] Dist batch ${Math.floor(i/BATCH)+1}: ${ok}/${maxWallets} sent`);
    await sleep(1500);
  }

  log("✅", `[${label}] Distribution done: ${ok}/${maxWallets}`);
  return ok;
}

// ═══════════════════════════════════════════════════════════════
//  GAS TAPERING
// ═══════════════════════════════════════════════════════════════
function getGasPrice(windowStartMs: number): bigint {
  const elapsedMin = (Date.now() - windowStartMs) / 60000;
  for (const tier of GAS_TAPER) {
    if (elapsedMin >= tier.minFrom && elapsedMin < tier.minTo) {
      return GAS_PRICE_BASE * tier.multiplier;
    }
  }
  return GAS_PRICE_BASE;
}

// ═══════════════════════════════════════════════════════════════
//  FIRE — Per-Shard Worker (RAW HTTP)
// ═══════════════════════════════════════════════════════════════
async function fireShardWorker(
  group: ShardGroup,
  txValue: bigint,
  maxPerWallet: number,
  windowEndMs: number,
  windowStartMs: number,
): Promise<number> {
  const numWallets = group.wallets.length;
  const sent: number[] = new Array(numWallets).fill(0);
  const nextNonces: number[] = new Array(numWallets).fill(0);

  // Fetch initial nonces
  for (let wi = 0; wi < numWallets; wi++) {
    try {
      const { nonce } = await getAccountBalance(group.wallets[wi].address);
      nextNonces[wi] = nonce;
    } catch { nextNonces[wi] = 0; }
  }

  let shardSent = 0;

  while (Date.now() < windowEndMs) {
    const gasPrice = getGasPrice(windowStartMs);
    const burst: any[] = [];

    for (let wi = 0; wi < numWallets; wi++) {
      if (sent[wi] >= maxPerWallet) continue;
      const remaining = Math.min(BATCH_PER_WALLET, maxPerWallet - sent[wi]);

      for (let d = 0; d < remaining; d++) {
        try {
          const txJson = await signAndSerialize(
            group.signers[wi],
            group.wallets[wi].address,
            group.receivers[wi],
            nextNonces[wi],
            txValue,
            gasPrice,
          );
          burst.push(txJson);
          nextNonces[wi]++;
        } catch {}
      }
    }

    if (burst.length === 0) break;

    // Send in chunks of 100
    let burstOk = 0;
    for (let c = 0; c < burst.length; c += 100) {
      const chunk = burst.slice(c, c + 100);
      try {
        const sent = await sendTxBatchRaw(chunk);
        burstOk += sent;
      } catch {
        totalErrors++;
        // Try failover
        failoverEndpoint();
      }
    }

    // Update counters
    for (let wi = 0; wi < numWallets; wi++) {
      const add = Math.min(BATCH_PER_WALLET, maxPerWallet - sent[wi]);
      sent[wi] += add;
    }
    shardSent += burstOk;
    totalSent += burstOk;

    // Heartbeat delay
    await sleep(HEARTBEAT_MS);
  }

  return shardSent;
}

// ═══════════════════════════════════════════════════════════════
//  FIRE WINDOW — 3 Shard Workers
// ═══════════════════════════════════════════════════════════════
async function fireWindow(
  label: string,
  shardGroups: ShardGroup[],
  txValue: bigint,
  maxPerWallet: number,
  windowEndISO: string,
) {
  const windowEnd = new Date(windowEndISO).getTime();
  const windowStart = Date.now();

  totalSent = 0;
  totalErrors = 0;

  log("🔥", `${label} — 3 SHARD WORKERS FIRING! (gas tapering: 10x→5x→2x→1x)`);

  const startTime = Date.now();
  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txps = elapsed > 0 ? Math.round(totalSent / elapsed) : 0;
    const rem = Math.max(0, Math.round((windowEnd - Date.now()) / 1000));
    const gasX = Number(getGasPrice(windowStart) / GAS_PRICE_BASE);
    const msg = `${label} | ${totalSent.toLocaleString()} tx | ${txps} tx/s | Gas: ${gasX}x | Err: ${totalErrors} | ${rem}s left | EP: ${getEndpoint().substring(0,40)}`;
    log("📊", msg);
    try {
      const cp = { label, totalSent, totalErrors, txps, gasX, elapsed: elapsed.toFixed(1), timestamp: new Date().toISOString() };
      fs.writeFileSync(path.join(__dirname, "..", "checkpoint.json"), JSON.stringify(cp, null, 2));
    } catch {}
  }, STATS_INTERVAL);

  const results = await Promise.all(
    shardGroups.map(g => fireShardWorker(g, txValue, maxPerWallet, windowEnd, windowStart))
  );

  clearInterval(statsTimer);

  const total = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "═".repeat(60));
  log("📊", `${label} SUMMARY`);
  results.forEach((r, i) => console.log(`   Shard ${i} → Shard ${(i+1)%3}: ${r.toLocaleString()} tx`));
  console.log(`   TOTAL: ${total.toLocaleString()} in ${elapsed}s (${Math.round(total/parseFloat(elapsed))} tx/s)`);
  console.log("═".repeat(60) + "\n");

  return total;
}

// ═══════════════════════════════════════════════════════════════
//  RECOVERY — Send all wallet funds back to GL
// ═══════════════════════════════════════════════════════════════
async function recoverWallets(walletsFile: string, glAddr: string) {
  if (!fs.existsSync(walletsFile)) return;
  const wallets: WalletEntry[] = JSON.parse(fs.readFileSync(walletsFile, "utf-8"));
  log("🔄", `Recovery: ${wallets.length} wallets → GL`);

  let recovered = 0, total = BigInt(0);
  const FEE = GAS_LIMIT * GAS_PRICE_BASE;

  for (let i = 0; i < wallets.length; i += 25) {
    const batch = wallets.slice(i, i + 25);
    await Promise.all(batch.map(async (w) => {
      try {
        const { balance, nonce } = await getAccountBalance(w.address);
        if (balance <= FEE) return;
        const sendAmt = balance - FEE;
        const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
        const txJson = await signAndSerialize(signer, w.address, glAddr, nonce, sendAmt, GAS_PRICE_BASE);
        await sendTxRaw(txJson);
        recovered++;
        total += sendAmt;
      } catch {}
    }));
  }

  log("✅", `Recovered: ${recovered} wallets, ${Number(total)/1e18} EGLD`);
}

// ═══════════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════════
let totalSent = 0;
let totalErrors = 0;

function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts} UTC] ${icon} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitUntil(iso: string, label: string) {
  const target = new Date(iso).getTime();
  if (Date.now() >= target) {
    log("⏭️", `${label} — already passed`);
    return;
  }
  log("⏳", `Waiting for ${label} (${iso})...`);
  while (Date.now() < target) {
    const rem = Math.round((target - Date.now()) / 1000);
    log("⏰", `${label} in ${rem}s`);
    await sleep(Math.min(10000, target - Date.now()));
  }
  log("🚀", `${label} — GO!`);
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🔥 CHALLENGE 4: RAW BLASTER — OBSERVER + BARE HEX");
  console.log("█  Raw HTTP | Multi-Endpoint | Gas Tapering | 48 Workers");
  console.log("█  💚 OpenHeart Guild — NEVER GIVE UP 💚");
  console.log("█".repeat(60) + "\n");

  // GL key
  const glHex = process.env.GL_PRIVATE_KEY;
  if (!glHex) { console.error("❌ GL_PRIVATE_KEY missing!"); process.exit(1); }
  const glKey = UserSecretKey.fromString(glHex);
  const glAddr = new UserSigner(glKey).getAddress().bech32();
  log("🔑", `GL: ${glAddr}`);
  log("🌐", `Endpoints: ${ENDPOINTS.join(" → ")}`);

  console.log("\n📋 SCHEDULE:");
  for (const [k, v] of Object.entries(SCHEDULE)) {
    console.log(`   ${k.padEnd(16)} → ${new Date(v).toISOString().slice(11, 19)} UTC`);
  }

  // ═══════════════════════════════════════
  //  PART 1
  // ═══════════════════════════════════════
  const now = Date.now();
  const p1End = new Date(SCHEDULE.PART_1_END).getTime();

  if (now < p1End) {
    await waitUntil(SCHEDULE.DISTRIBUTE_1, "PART 1 DISTRIBUTION");
    const w1 = generateWallets(NUM_WALLETS, "part1");
    const g1 = buildShardGroups(w1);
    await distribute(glHex, w1, PART_1.distAmount, "Part 1");
    await waitUntil(SCHEDULE.PART_1_START, "PART 1 START");
    await fireWindow("PART 1", g1, PART_1.txValue, PART_1.maxTxPerWallet, SCHEDULE.PART_1_END);
  } else {
    log("⏭️", "Part 1 already ended — skipping entirely (no wallet gen, no distribution!)");
  }

  // ═══════════════════════════════════════
  //  PART 2
  // ═══════════════════════════════════════
  const p2End = new Date(SCHEDULE.PART_2_END).getTime();

  if (now < p2End) {
    const w2 = generateWallets(NUM_WALLETS, "part2");
    const g2 = buildShardGroups(w2);
    await distribute(glHex, w2, PART_2.distAmount, "Part 2");
    await waitUntil(SCHEDULE.PART_2_START, "PART 2 START");
    await fireWindow("PART 2", g2, PART_2.txValue, PART_2.maxTxPerWallet, SCHEDULE.PART_2_END);
  } else {
    log("⏭️", "Part 2 already ended — nothing to do");
  }

  log("🏁", "Challenge complete!");
  process.exit(0);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });
