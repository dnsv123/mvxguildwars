/**
 * ═══════════════════════════════════════════════════════════════
 *  🔧 CHALLENGE 4: SETUP — Wallets, Wrap, Deploy, Test
 *
 *  Run this BEFORE the challenge window to prepare everything.
 *
 *  Steps:
 *  1. Generate 3 shard-specific wallets
 *  2. Fund wallets from GL
 *  3. Wrap EGLD → WEGLD
 *  4. Deploy forwarder-blind contracts (via mxpy, manual step)
 *  5. Test all 4 call types
 *
 *  Usage: npx ts-node --transpileOnly scripts/c4_setup.ts [step]
 *  Steps: wallets | fund | wrap | status | test-call
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner, Mnemonic } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const CHAIN_ID = "B";
const API_URL = process.env.API_URL || "https://api.battleofnodes.com";
const WEGLD_TOKEN = "WEGLD-bd4d79";
const USDC_TOKEN = "USDC-c76f1f";
const WRAP_SC = "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44jurgn29psua5l2jps3ntjj3";
const GAS_PRICE = BigInt(10_000_000_000); // 10x gas price — ALL OR NOTHING
const txComputer = new TransactionComputer();

const ENDPOINTS = [
  process.env.OBSERVER_URL,
  process.env.KEPLER_GATEWAY,
  "https://gateway.battleofnodes.com",
].filter(Boolean) as string[];
const KEPLER_KEY = process.env.KEPLER_API_KEY || "";

let epIdx = 0;
function getEP() { return ENDPOINTS[epIdx % ENDPOINTS.length]; }

// ═══════════════════════════════════════════════════════════════
//  HTTP helpers
// ═══════════════════════════════════════════════════════════════
async function apiGet(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function gwPost(p: string, body: any) {
  const url = `${getEP()}${p}`;
  const h: any = { "Content-Type": "application/json" };
  if (KEPLER_KEY && getEP().includes("kepler")) h["api-key"] = KEPLER_KEY;
  const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`GW ${r.status}: ${t.substring(0,200)}`); }
  return r.json();
}

async function acctInfo(addr: string) {
  const d = await apiGet(`${API_URL}/accounts/${addr}`);
  return { balance: BigInt(d.balance), nonce: d.nonce as number };
}

async function tokenBal(addr: string, tok: string) {
  // Use GATEWAY for accurate real-time ESDT balance (BoN API indexer has lag)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${getEP()}/address/${addr}/esdt/${tok}`;
      const headers: any = { "Content-Type": "application/json" };
      if (KEPLER_KEY && getEP().includes("kepler")) headers["api-key"] = KEPLER_KEY;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) { await sleep(300); continue; }
      const d: any = await res.json();
      const bal = d?.data?.tokenData?.balance;
      if (bal) return BigInt(bal);
      return BigInt(0);
    } catch { await sleep(500); }
  }
  return BigInt(0);
}

async function signAndSend(
  signer: UserSigner, from: string, to: string,
  nonce: number, value: bigint, gasLimit: bigint, data: string
) {
  const tx = new Transaction({
    nonce: BigInt(nonce), value,
    sender: new Address(from), receiver: new Address(to),
    gasLimit, gasPrice: GAS_PRICE, chainID: CHAIN_ID,
    data: data ? new TextEncoder().encode(data) : new Uint8Array(),
  });
  const bytes = txComputer.computeBytesForSigning(tx);
  tx.signature = await signer.sign(bytes);
  const json = JSON.parse(Buffer.from(bytes).toString());
  json.signature = Buffer.from(tx.signature).toString("hex");
  const d = await gwPost("/transaction/send", json);
  return d?.data?.txHash || "";
}

function log(icon: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11,19)}] ${icon} ${msg}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getWalletShard(bech32: string): number {
  const pk = new Address(bech32).getPublicKey();
  const last = pk[pk.length - 1];
  let shard = last % 4;
  if (shard === 3) shard = last % 2;
  return shard;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 1: Generate shard-specific wallets (60 total fleet)
//  Shard 1 gets 30 (same-shard as DEX → fastest, blindSync works)
//  Shard 0/2 get 15 each (cross-shard, async calls only)
// ═══════════════════════════════════════════════════════════════
function stepWallets() {
  // Optimal distribution: S0=15, S1=30, S2=15 (total=60)
  // Shard 1 = DEX shard → blindSync + same-shard = fastest, so we give it 2x
  const SHARD_COUNTS: Record<number, number> = { 0: 15, 1: 30, 2: 15 };
  const total = Object.values(SHARD_COUNTS).reduce((a,b) => a+b, 0);
  log("⚙️", `Generating ${total}-wallet fleet: S0=${SHARD_COUNTS[0]}, S1=${SHARD_COUNTS[1]} (DEX shard), S2=${SHARD_COUNTS[2]}`);
  const wallets: { shard: number; address: string; privateKey: string; mnemonic: string }[] = [];

  for (let targetShard = 0; targetShard < 3; targetShard++) {
    const needed = SHARD_COUNTS[targetShard];
    let generated = 0;
    while (generated < needed) {
      const mnemonic = Mnemonic.generate();
      const sk = mnemonic.deriveKey(0);
      const signer = new UserSigner(sk);
      const addr = signer.getAddress().bech32();
      const shard = getWalletShard(addr);

      if (shard === targetShard) {
        wallets.push({
          shard: targetShard,
          address: addr,
          privateKey: Buffer.from(sk.valueOf()).toString("hex"),
          mnemonic: mnemonic.toString(),
        });
        generated++;
        if (generated % 5 === 0 || generated === needed) {
          log("✅", `Shard ${targetShard}: ${generated}/${needed} wallets generated`);
        }
      }
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = path.join(__dirname, "..", `c4_wallets_${ts}.json`);
  fs.writeFileSync(filepath, JSON.stringify(wallets, null, 2));
  // Also save as latest
  fs.writeFileSync(path.join(__dirname, "..", "c4_wallets.json"), JSON.stringify(wallets, null, 2));
  log("💾", `Saved to ${filepath} + c4_wallets.json`);
  console.log(`\n🚀 Fleet: ${wallets.length} wallets ready`);
  for (const s of [0,1,2]) {
    const sw = wallets.filter(w => w.shard === s);
    console.log(`  Shard ${s}: ${sw.length} wallets ${s===1 ? '(DEX shard — all 4 types)' : '(cross-shard — 3 async types)'}`);
  }
  return wallets;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2: Fund wallets from GL
// ═══════════════════════════════════════════════════════════════
async function stepFund() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();

  const { balance, nonce } = await acctInfo(glAddr);
  log("💰", `GL: ${(Number(balance) / 1e18).toFixed(4)} EGLD, nonce=${nonce}`);

  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));
  // Split GL balance evenly using BIGINT to avoid rounding to 0
  const reserveEgld = BigInt(5) * BigInt(1e18); // Keep 5 EGLD in GL
  let distributable = balance > reserveEgld ? balance - reserveEgld : BigInt(0);
  // Optional budget cap via env var (e.g., FUND_BUDGET=100 → max 100 EGLD)
  const budgetEnv = process.env.FUND_BUDGET;
  if (budgetEnv) {
    const budgetWei = BigInt(Math.floor(parseFloat(budgetEnv) * 1e18));
    if (budgetWei < distributable) {
      distributable = budgetWei;
      log("💡", `Budget capped at ${budgetEnv} EGLD (env FUND_BUDGET)`);
    }
  }
  const amountEach = distributable / BigInt(wallets.length);
  const perWalletEgld = Number(amountEach) / 1e18;
  log("📊", `GL has ${(Number(balance)/1e18).toFixed(2)} EGLD → sending ${perWalletEgld.toFixed(4)} EGLD to each of ${wallets.length} wallets (total: ${(Number(distributable)/1e18).toFixed(2)} EGLD)`);

  if (amountEach < BigInt(50_000_000_000_000)) {
    log("❌", `Amount per wallet too small (${perWalletEgld.toFixed(6)} EGLD). Need more EGLD in GL!`);
    return;
  }

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    log("📤", `Funding Shard ${w.shard}: ${w.address} with ${perWalletEgld.toFixed(4)} EGLD...`);
    const hash = await signAndSend(glSigner, glAddr, w.address, nonce + i, amountEach, BigInt(50_000), "");
    log("✅", `TX: ${hash}`);
  }

  log("⏳", "Waiting 30s for cross-shard confirmations...");
  await sleep(30000);

  for (const w of wallets) {
    const { balance } = await acctInfo(w.address);
    log("💰", `Shard ${w.shard}: ${(Number(balance) / 1e18).toFixed(4)} EGLD`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3: Wrap EGLD → WEGLD
// ═══════════════════════════════════════════════════════════════
async function stepWrap() {
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));

  for (const w of wallets) {
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    const { balance, nonce } = await acctInfo(w.address);
    const egld = Number(balance) / 1e18;
    // Keep 5.0 EGLD for gas fees, wrap the rest as WEGLD for swaps
    // With bidirectional swap recycling, we need less WEGLD but more gas headroom
    // 5.0 EGLD gas = enough for 60 min sustained operation
    const GAS_RESERVE = 5.0;
    const toWrap = Math.max(0, egld - GAS_RESERVE);
    if (toWrap <= 0.01) {
      log("⚠️", `Shard ${w.shard}: Only ${egld.toFixed(4)} EGLD — not enough to wrap (need >0.51)`);
      continue;
    }
    const wrapAmount = BigInt(Math.floor(toWrap * 1e18));
    log("🔄", `Wrapping ${toWrap.toFixed(4)} EGLD on Shard ${w.shard} (keeping 0.5 EGLD for gas)...`);
    const hash = await signAndSend(signer, w.address, WRAP_SC, nonce, wrapAmount, BigInt(5_000_000), "wrapEgld");
    log("✅", `Wrap TX: ${hash}`);
    await sleep(500);  // Faster pacing
  }

  log("⏳", "Waiting 15s for confirmations...");
  await sleep(15000);

  for (const w of wallets) {
    // Use gateway for accurate ESDT balance
    const wegld = await tokenBal(w.address, WEGLD_TOKEN);
    log("💰", `Shard ${w.shard}: ${(Number(wegld) / 1e18).toFixed(4)} WEGLD`);
    await sleep(300);
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 4: Show status of all wallets + forwarders
// ═══════════════════════════════════════════════════════════════
async function stepStatus() {
  log("📋", "=== WALLET STATUS ===");
  if (fs.existsSync(path.join(__dirname, "..", "c4_wallets.json"))) {
    const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));
    for (const w of wallets) {
      const { balance } = await acctInfo(w.address);
      await sleep(300);
      const wegld = await tokenBal(w.address, WEGLD_TOKEN);
      const usdc = await tokenBal(w.address, USDC_TOKEN);
      await sleep(300);
      log("💰", `S${w.shard} ${w.address.substring(0,20)}... | EGLD: ${(Number(balance)/1e18).toFixed(4)} | WEGLD: ${(Number(wegld)/1e18).toFixed(4)} | USDC: ${(Number(usdc)/1e6).toFixed(2)}`);
    }
  }

  if (fs.existsSync(path.join(__dirname, "..", "c4_forwarders.json"))) {
    log("📋", "=== FORWARDER STATUS ===");
    const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));
    for (const f of fwds) {
      const wegld = await tokenBal(f.forwarderAddress, WEGLD_TOKEN);
      const usdc = await tokenBal(f.forwarderAddress, USDC_TOKEN);
      await sleep(300);
      log("📦", `S${f.shard} ${f.forwarderAddress.substring(0,20)}... | ${f.callType} | WEGLD: ${(Number(wegld)/1e18).toFixed(4)} | USDC: ${(Number(usdc)/1e6).toFixed(2)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 5: Test a single forwarder call
// ═══════════════════════════════════════════════════════════════
async function stepTestCall() {
  if (!fs.existsSync(path.join(__dirname, "..", "c4_forwarders.json"))) {
    log("❌", "c4_forwarders.json not found. Deploy contracts first.");
    return;
  }

  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));
  const swapDest = "erd1qqqqqqqqqqqqqpgqeel2kumf0r8ffyhth7pqdujjat9nx0862jpsg2pqaq";
  const swapEndpoint = "swapTokensFixedInput";
  const swapAmount = BigInt(1_000_000_000_000_000); // 0.001 WEGLD

  function strToHex(s: string) { return Buffer.from(s).toString("hex"); }
  function bigIntToHex(n: bigint) { const h = n.toString(16); return h.length % 2 ? "0"+h : h; }
  function addressToHex(b: string) { return Buffer.from(new Address(b).getPublicKey()).toString("hex"); }

  for (const f of fwds) {
    const signer = new UserSigner(UserSecretKey.fromString(f.wallet.privateKey));
    const { nonce } = await acctInfo(f.wallet.address);

    const data = [
      "ESDTTransfer",
      strToHex(WEGLD_TOKEN),
      bigIntToHex(swapAmount),
      strToHex(f.callType),
      addressToHex(swapDest),
      strToHex(swapEndpoint),
      strToHex(USDC_TOKEN),
      bigIntToHex(BigInt(1)),
    ].join("@");

    log("🧪", `Testing ${f.callType} on Shard ${f.shard}...`);
    try {
      const hash = await signAndSend(signer, f.wallet.address, f.forwarderAddress, nonce, BigInt(0), BigInt(30_000_000), data);
      log("✅", `${f.callType} TX: ${hash}`);
    } catch (e: any) {
      log("❌", `${f.callType} FAILED: ${e.message?.substring(0, 100)}`);
    }
    await sleep(3000);
  }
}

// ═══════════════════════════════════════════════════════════════
//  BLAST: Rapid loop of test-call — PROVEN to produce calls
// ═══════════════════════════════════════════════════════════════
async function stepBlast() {
  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));
  const swapDest = "erd1qqqqqqqqqqqqqpgqeel2kumf0r8ffyhth7pqdujjat9nx0862jpsg2pqaq";
  const swapEndpoint = "swapTokensFixedInput";
  const swapAmount = BigInt(1_000_000_000_000_000);

  function strToHex(s: string) { return Buffer.from(s).toString("hex"); }
  function bigIntToHex(n: bigint) { const h = n.toString(16); return h.length % 2 ? "0"+h : h; }
  function addressToHex(b: string) { return Buffer.from(new Address(b).getPublicKey()).toString("hex"); }

  const WINDOW_END = new Date("2026-03-26T17:00:00Z").getTime();
  const ALL_TYPES = ["blindAsyncV1", "blindAsyncV2", "blindSync", "blindTransfExec"];
  const ASYNC_TYPES = ["blindAsyncV1", "blindAsyncV2"];
  let totalSent = 0, totalErrors = 0, round = 0;
  const startTime = Date.now();

  log("🔥", `BLAST MODE: ${fwds.length} deployer wallets, window ends ${new Date(WINDOW_END).toISOString()}`);

  while (Date.now() < WINDOW_END) {
    round++;
    for (const f of fwds) {
      if (Date.now() >= WINDOW_END) break;
      try {
        const signer = new UserSigner(UserSecretKey.fromString(f.wallet.privateKey));
        const { nonce } = await acctInfo(f.wallet.address);
        const types = f.shard === 1 ? ALL_TYPES : ASYNC_TYPES;
        const callType = types[round % types.length];

        const data = [
          "ESDTTransfer", strToHex(WEGLD_TOKEN), bigIntToHex(swapAmount),
          strToHex(callType), addressToHex(swapDest), strToHex(swapEndpoint),
          strToHex(USDC_TOKEN), bigIntToHex(BigInt(1)),
        ].join("@");

        await signAndSend(signer, f.wallet.address, f.forwarderAddress, nonce, BigInt(0), BigInt(30_000_000), data);
        totalSent++;
      } catch (e: any) {
        totalErrors++;
        if (totalErrors <= 10) log("❌", `S${f.shard}: ${e.message?.substring(0,80)}`);
      }
      await sleep(500);
    }
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.floor((WINDOW_END - Date.now()) / 1000);
    log("📊", `R${round}: ${totalSent} calls | ${totalErrors} err | ${(totalSent/elapsed).toFixed(1)}/s | ${remaining}s left`);
  }
  log("✅", `BLAST DONE! ${totalSent} calls, ${totalErrors} errors`);
}

// ═══════════════════════════════════════════════════════════════
//  MICRO-FUND: Send tiny amounts to 60 fleet wallets for testing
// ═══════════════════════════════════════════════════════════════
async function stepMicroFund() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  const { balance, nonce } = await acctInfo(glAddr);
  const glEgld = Number(balance) / 1e18;

  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));
  const PER_WALLET = BigInt(100_000_000_000_000_000); // 0.1 EGLD per wallet
  const totalNeeded = Number(PER_WALLET) * wallets.length / 1e18;

  log("💰", `GL: ${glEgld.toFixed(4)} EGLD | Need: ${totalNeeded.toFixed(2)} EGLD for ${wallets.length} wallets`);
  if (glEgld < totalNeeded + 1) {
    log("⚠️", `Not enough EGLD! Need ${totalNeeded.toFixed(2)} + 1 reserve`);
    return;
  }

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      const hash = await signAndSend(glSigner, glAddr, w.address, nonce + i, PER_WALLET, BigInt(50_000), "");
      if (i % 10 === 0 || i === wallets.length - 1) log("📤", `Funded ${i + 1}/${wallets.length} (S${w.shard})`);
    } catch (e: any) {
      log("❌", `Fund error wallet ${i}: ${e.message?.substring(0, 60)}`);
    }
  }

  log("⏳", "Waiting 15s for confirmations...");
  await sleep(15000);

  // Now micro-wrap: wrap 0.05 EGLD on each wallet
  log("🔄", "Micro-wrapping 0.05 EGLD → WEGLD on each wallet...");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    const { nonce: wNonce } = await acctInfo(w.address);
    const wrapAmt = BigInt(50_000_000_000_000_000); // 0.05 EGLD
    try {
      await signAndSend(signer, w.address, WRAP_SC, wNonce, wrapAmt, BigInt(5_000_000), "wrapEgld");
      if (i % 10 === 0 || i === wallets.length - 1) log("🔄", `Wrapped ${i + 1}/${wallets.length}`);
    } catch (e: any) {
      log("❌", `Wrap error wallet ${i}: ${e.message?.substring(0, 60)}`);
    }
    if (i % 5 === 4) await sleep(1000); // Pace to avoid nonce issues
  }

  log("⏳", "Waiting 15s...");
  await sleep(15000);
  log("✅", "Micro-fund + wrap complete! Run 'status' to verify.");
}

// ═══════════════════════════════════════════════════════════════
//  CLEANUP: Sweep ALL tokens from wallets back to GL
// ═══════════════════════════════════════════════════════════════
async function stepCleanup() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));
  log("🧹", `CLEANUP — Sweeping ${wallets.length} wallets back to GL`);

  const DEX_PAIR = "erd1qqqqqqqqqqqqqpgqeel2kumf0r8ffyhth7pqdujjat9nx0862jpsg2pqaq";

  // Step 0: Micro-fund wallets that have USDC but no gas
  log("💸", "Step 0: Micro-funding wallets with USDC for gas...");
  let glNonce = (await acctInfo(glAddr)).nonce;
  const MICRO_GAS = BigInt(50_000_000_000_000_000); // 0.05 EGLD
  let fundedCount = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const usdc = await tokenBal(w.address, USDC_TOKEN);
    const { balance } = await acctInfo(w.address);
    if (usdc > BigInt(0) && balance < BigInt(30_000_000_000_000_000)) {
      try {
        await signAndSend(glSigner, glAddr, w.address, glNonce, MICRO_GAS, BigInt(50_000), "");
        glNonce++;
        fundedCount++;
      } catch (e: any) { log("⚠️", `Micro-fund fail ${i}: ${e.message?.substring(0,50)}`); }
    }
    if (i % 5 === 4) await sleep(200);
  }
  if (fundedCount > 0) {
    log("💸", `Micro-funded ${fundedCount} wallets with 0.05 EGLD each`);
    log("⏳", "Waiting 15s...");
    await sleep(15000);
  }

  // Step 0.5: Swap USDC → WEGLD via DEX pair directly
  log("🔄", "Step 0.5: Swapping USDC → WEGLD on DEX...");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const usdc = await tokenBal(w.address, USDC_TOKEN);
    if (usdc > BigInt(0)) {
      const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
      const { nonce } = await acctInfo(w.address);
      const hexAmt = usdc.toString(16).length % 2 ? '0' + usdc.toString(16) : usdc.toString(16);
      const data = `ESDTTransfer@${Buffer.from(USDC_TOKEN).toString('hex')}@${hexAmt}@${Buffer.from('swapTokensFixedInput').toString('hex')}@${Buffer.from(WEGLD_TOKEN).toString('hex')}@01`;
      try {
        await signAndSend(signer, w.address, DEX_PAIR, nonce, BigInt(0), BigInt(20_000_000), data);
        if (i % 10 === 0) log("🔄", `Swapped ${(Number(usdc)/1e6).toFixed(4)} USDC → WEGLD wallet ${i+1}`);
      } catch (e: any) { log("⚠️", `USDC swap fail ${i}: ${e.message?.substring(0,50)}`); }
    }
    if (i % 5 === 4) await sleep(500);
  }
  log("⏳", "Waiting 15s for USDC swaps...");
  await sleep(15000);

  log("🔄", "Step 1: Unwrapping WEGLD → EGLD...");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const wegld = await tokenBal(w.address, WEGLD_TOKEN);
    if (wegld > BigInt(0)) {
      const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
      const { nonce } = await acctInfo(w.address);
      const hexAmt = wegld.toString(16).length % 2 ? '0' + wegld.toString(16) : wegld.toString(16);
      const data = `ESDTTransfer@${Buffer.from(WEGLD_TOKEN).toString('hex')}@${hexAmt}@${Buffer.from('unwrapEgld').toString('hex')}`;
      try {
        await signAndSend(signer, w.address, WRAP_SC, nonce, BigInt(0), BigInt(5_000_000), data);
        if (i % 10 === 0) log("🔄", `Unwrapped ${(Number(wegld)/1e18).toFixed(4)} WEGLD wallet ${i+1}`);
      } catch (e: any) { log("⚠️", `Unwrap fail ${i}: ${e.message?.substring(0,50)}`); }
    }
    if (i % 5 === 4) await sleep(500);
  }
  log("⏳", "Waiting 20s for unwrap...");
  await sleep(20000);

  log("💸", "Step 2: Sending EGLD back to GL...");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const { balance, nonce } = await acctInfo(w.address);
    const fee = BigInt(50_000) * GAS_PRICE;
    const toSend = balance - fee - fee;
    if (toSend > BigInt(0)) {
      const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
      try {
        await signAndSend(signer, w.address, glAddr, nonce, toSend, BigInt(50_000), "");
        if (i % 10 === 0) log("💸", `Recovered ${(Number(toSend)/1e18).toFixed(4)} EGLD wallet ${i+1}`);
      } catch (e: any) { log("⚠️", `Recover fail ${i}: ${e.message?.substring(0,50)}`); }
    }
    if (i % 5 === 4) await sleep(300);
  }
  log("⏳", "Waiting 30s...");
  await sleep(30000);
  const { balance: glBal } = await acctInfo(glAddr);
  log("✅", `CLEANUP DONE! GL: ${(Number(glBal)/1e18).toFixed(4)} EGLD`);
}

// ═══════════════════════════════════════════════════════════════
//  FIX-DRAIN: Fund drain wallets, drain forwarders
// ═══════════════════════════════════════════════════════════════
async function stepFixDrain() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  if (!fs.existsSync(path.join(__dirname, "..", "c4_forwarders.json"))) { log("❌", "No forwarders!"); return; }
  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));

  const { nonce: glNonce } = await acctInfo(glAddr);
  const DRAIN_FUND = BigInt(100_000_000_000_000_000); // 0.1 EGLD
  for (let i = 0; i < fwds.length; i++) {
    const f = fwds[i];
    const { balance } = await acctInfo(f.wallet.address);
    if (balance < BigInt(50_000_000_000_000_000)) {
      await signAndSend(glSigner, glAddr, f.wallet.address, glNonce + i, DRAIN_FUND, BigInt(50_000), "");
      log("💸", `Funded S${f.shard} drain wallet 0.1 EGLD`);
    }
  }
  await sleep(15000);

  for (const f of fwds) {
    const signer = new UserSigner(UserSecretKey.fromString(f.wallet.privateKey));
    const { nonce } = await acctInfo(f.wallet.address);
    let n = nonce;
    for (const token of [USDC_TOKEN, WEGLD_TOKEN]) {
      const bal = await tokenBal(f.forwarderAddress, token);
      if (bal > BigInt(0)) {
        const data = `drain@${Buffer.from(token).toString('hex')}@`;
        try {
          await signAndSend(signer, f.wallet.address, f.forwarderAddress, n, BigInt(0), BigInt(30_000_000), data);
          log("🔄", `Drained ${token} from S${f.shard}`);
          n++;
        } catch (e: any) { log("⚠️", `Drain ${token} S${f.shard}: ${e.message?.substring(0,50)}`); }
        await sleep(1000);
      }
    }
  }
  await sleep(15000);
  for (const f of fwds) {
    const w = await tokenBal(f.forwarderAddress, WEGLD_TOKEN);
    const u = await tokenBal(f.forwarderAddress, USDC_TOKEN);
    log("📦", `S${f.shard}: WEGLD=${(Number(w)/1e18).toFixed(4)} USDC=${(Number(u)/1e6).toFixed(4)}`);
  }
  log("✅", "FIX-DRAIN done! Run 'cleanup' next.");
}

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  CORRECT FUNDING: Return excess to GL to cap at 500 EGLD total
// ═══════════════════════════════════════════════════════════════
async function stepCorrectFunding() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));
  const TARGET_TOTAL = 500;
  const TARGET_PER_WALLET = (TARGET_TOTAL / wallets.length);
  log("🔧", `CORRECT FUNDING — Capping fleet to ${TARGET_TOTAL} EGLD (${TARGET_PER_WALLET.toFixed(4)} per wallet)`);

  // Step 1: Calculate excess per wallet and unwrap WEGLD
  log("🔄", "Step 1: Unwrapping excess WEGLD...");
  let totalReturned = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const { balance } = await acctInfo(w.address);
    const wegld = await tokenBal(w.address, WEGLD_TOKEN);
    const totalBal = Number(balance) / 1e18 + Number(wegld) / 1e18;
    const excess = totalBal - TARGET_PER_WALLET;
    if (excess <= 0.01) continue; // skip if within tolerance

    // Unwrap the excess from WEGLD
    const toUnwrap = Math.min(excess, Number(wegld) / 1e18);
    if (toUnwrap < 0.01) continue;
    const unwrapAmt = BigInt(Math.floor(toUnwrap * 1e18));
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    const { nonce } = await acctInfo(w.address);
    const hexAmt = unwrapAmt.toString(16).length % 2 ? '0' + unwrapAmt.toString(16) : unwrapAmt.toString(16);
    const data = `ESDTTransfer@${Buffer.from(WEGLD_TOKEN).toString('hex')}@${hexAmt}@${Buffer.from('unwrapEgld').toString('hex')}`;
    try {
      await signAndSend(signer, w.address, WRAP_SC, nonce, BigInt(0), BigInt(5_000_000), data);
      totalReturned += toUnwrap;
      if (i % 10 === 0) log("🔄", `Unwrapped ${toUnwrap.toFixed(4)} WEGLD wallet ${i+1}/${wallets.length}`);
    } catch (e: any) { log("⚠️", `Unwrap fail ${i}: ${e.message?.substring(0,50)}`); }
    if (i % 5 === 4) await sleep(300);
  }
  log("⏳", `Unwrapped ~${totalReturned.toFixed(2)} WEGLD total. Waiting 20s...`);
  await sleep(20000);

  // Step 2: Send excess EGLD back to GL
  log("💸", "Step 2: Sending excess EGLD back to GL...");
  let totalSent = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const { balance, nonce } = await acctInfo(w.address);
    const wegld = await tokenBal(w.address, WEGLD_TOKEN);
    const totalBal = Number(balance) / 1e18 + Number(wegld) / 1e18;
    const excess = totalBal - TARGET_PER_WALLET;
    if (excess <= 0.01) continue;

    const fee = BigInt(50_000) * GAS_PRICE;
    const toSend = BigInt(Math.floor(excess * 1e18)) - fee;
    if (toSend <= BigInt(0)) continue;
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    try {
      await signAndSend(signer, w.address, glAddr, nonce, toSend, BigInt(50_000), "");
      totalSent += Number(toSend) / 1e18;
      if (i % 10 === 0) log("💸", `Returned ${(Number(toSend)/1e18).toFixed(4)} EGLD wallet ${i+1}`);
    } catch (e: any) { log("⚠️", `Return fail ${i}: ${e.message?.substring(0,50)}`); }
    if (i % 5 === 4) await sleep(300);
  }
  log("⏳", "Waiting 30s...");
  await sleep(30000);
  const { balance: glBal } = await acctInfo(glAddr);
  log("✅", `CORRECT DONE! Returned ~${totalSent.toFixed(2)} EGLD. GL: ${(Number(glBal)/1e18).toFixed(4)} EGLD`);
}

// ═══════════════════════════════════════════════════════════════
//  FIX PAYABLE: Upgrade contracts to add payable-by-sc flag
// ═══════════════════════════════════════════════════════════════
async function stepFixPayable() {
  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));

  // Fetch current contract code from first forwarder
  log("🔄", "Fetching contract WASM code from API...");
  const acctData: any = await apiGet(`${API_URL}/accounts/${fwds[0].forwarderAddress}`);
  const codeHex = acctData.code;
  if (!codeHex || codeHex.length < 100) { log("❌", "No code found!"); return; }
  log("✅", `Got WASM code: ${codeHex.length} hex chars`);

  // Metadata: 0506 = Upgradeable(01)+Readable(04) | Payable(02)+PayableBySC(04)
  const metadata = "0506";

  for (let i = 0; i < fwds.length; i++) {
    const f = fwds[i];
    // The WALLET is the contract owner/deployer — must sign upgrade
    const walletSigner = new UserSigner(UserSecretKey.fromString(f.wallet.privateKey));
    const walletAddr = f.wallet.address;
    const { nonce } = await acctInfo(walletAddr);
    const data = `upgradeContract@${codeHex}@${metadata}`;
    const gasLimit = BigInt(200_000_000);
    try {
      const txHash = await signAndSend(walletSigner, walletAddr, f.forwarderAddress, nonce, BigInt(0), gasLimit, data);
      log("✅", `Upgraded S${f.shard} TX: ${txHash}`);
    } catch (e: any) {
      log("❌", `Upgrade S${f.shard} failed: ${e.message?.substring(0,100)}`);
    }
  }
  log("⏳", "Waiting 30s for confirmations...");
  await sleep(30000);

  // Verify
  for (const f of fwds) {
    try {
      const info: any = await apiGet(`${API_URL}/accounts/${f.forwarderAddress}`);
      log(info.isPayableBySmartContract ? "✅" : "❌",
        `S${f.shard} isPayableBySmartContract: ${info.isPayableBySmartContract}`);
    } catch { log("⚠️", `Could not verify S${f.shard}`); }
  }
}

async function main() {
  const step = process.argv[2] || "status";

  console.log("\n" + "═".repeat(50));
  console.log(" 🔧 C4 SETUP — Step:", step);
  console.log("═".repeat(50) + "\n");

  switch (step) {
    case "wallets":    stepWallets(); break;
    case "fund":       await stepFund(); break;
    case "wrap":       await stepWrap(); break;
    case "status":     await stepStatus(); break;
    case "test-call":  await stepTestCall(); break;
    case "micro-fund": await stepMicroFund(); break;
    case "fix-drain":  await stepFixDrain(); break;
    case "cleanup":    await stepCleanup(); break;
    case "correct-funding": await stepCorrectFunding(); break;
    case "fix-payable": await stepFixPayable(); break;
    case "blast": await stepBlast(); break;
    default:
      console.log("Usage: npx ts-node --transpileOnly scripts/c4_setup.ts [wallets|fund|wrap|status|test-call|micro-fund|fix-drain|cleanup|correct-funding|fix-payable]");
  }
}

main().catch(e => { console.error("❌", e); process.exit(1); });
