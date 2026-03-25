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
const GAS_PRICE = BigInt(1_000_000_000);
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
//  STEP 1: Generate shard-specific wallets
// ═══════════════════════════════════════════════════════════════
function stepWallets() {
  log("⚙️", "Generating 3 shard-specific wallets...");
  const wallets: { shard: number; address: string; privateKey: string; mnemonic: string }[] = [];

  for (let targetShard = 0; targetShard < 3; targetShard++) {
    let attempts = 0;
    while (attempts < 10000) {
      attempts++;
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
        log("✅", `Shard ${targetShard}: ${addr} (${attempts} attempts)`);
        break;
      }
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = path.join(__dirname, "..", `c4_wallets_${ts}.json`);
  fs.writeFileSync(filepath, JSON.stringify(wallets, null, 2));
  // Also save as latest
  fs.writeFileSync(path.join(__dirname, "..", "c4_wallets.json"), JSON.stringify(wallets, null, 2));
  log("💾", `Saved to ${filepath} + c4_wallets.json`);
  console.log("\nWallets:");
  wallets.forEach(w => console.log(`  Shard ${w.shard}: ${w.address}`));
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
  // Split GL balance evenly, keeping 5 EGLD reserve in GL
  const glEgld = Number(balance) / 1e18;
  const perWallet = Math.floor((glEgld - 5) / wallets.length);
  const amountEach = BigInt(Math.floor(perWallet * 1e18));
  log("📊", `GL has ${glEgld.toFixed(2)} EGLD → sending ${perWallet} EGLD to each of ${wallets.length} wallets`);

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    log("📤", `Funding Shard ${w.shard}: ${w.address} with ${perWallet} EGLD...`);
    const hash = await signAndSend(glSigner, glAddr, w.address, nonce + i, amountEach, BigInt(50_000), "");
    log("✅", `TX: ${hash}`);
  }

  log("⏳", "Waiting 15s for confirmations...");
  await sleep(15000);

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
    // Keep 3 EGLD for gas, wrap the rest
    const toWrap = Math.max(0, egld - 3);
    if (toWrap <= 0) {
      log("⚠️", `Shard ${w.shard}: Only ${egld.toFixed(4)} EGLD — not enough to wrap (need >3)`);
      continue;
    }
    const wrapAmount = BigInt(Math.floor(toWrap * 1e18));
    log("🔄", `Wrapping ${toWrap.toFixed(2)} EGLD on Shard ${w.shard} (keeping 3 EGLD for gas)...`);
    const hash = await signAndSend(signer, w.address, WRAP_SC, nonce, wrapAmount, BigInt(5_000_000), "wrapEgld");
    log("✅", `Wrap TX: ${hash}`);
    await sleep(2000);
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
//  CLI
// ═══════════════════════════════════════════════════════════════
async function main() {
  const step = process.argv[2] || "status";

  console.log("\n" + "═".repeat(50));
  console.log(" 🔧 C4 SETUP — Step:", step);
  console.log("═".repeat(50) + "\n");

  switch (step) {
    case "wallets":  stepWallets(); break;
    case "fund":     await stepFund(); break;
    case "wrap":     await stepWrap(); break;
    case "status":   await stepStatus(); break;
    case "test-call": await stepTestCall(); break;
    default:
      console.log("Usage: npx ts-node --transpileOnly scripts/c4_setup.ts [wallets|fund|wrap|status|test-call]");
  }
}

main().catch(e => { console.error("❌", e); process.exit(1); });
