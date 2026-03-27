/**
 * ═══════════════════════════════════════════════════════════════
 *  🧪 C5 LIVE TEST — Test the full pipeline on blockchain
 *
 *  Tests with TINY amounts (0.1 EGLD per agent = 1 EGLD total)
 *  then cleans up immediately.
 *
 *  What it tests:
 *   1. Fund 10 agents with 0.1 EGLD each from GL wallet
 *   2. Wait for confirmations
 *   3. Send 1 MoveBalance TX per agent (agent → agent0)
 *   4. Verify TXs landed on chain
 *   5. Sweep all funds back to GL
 *
 *  Usage: npx ts-node --transpileOnly scripts/c5_test_live.ts
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const CHAIN_ID = "B";
const API_URL = process.env.API_URL || "https://api.battleofnodes.com";
const GATEWAY_URL = process.env.GATEWAY_URL || "https://gateway.battleofnodes.com";
const GAS_PRICE = BigInt(1_000_000_000);
const txComputer = new TransactionComputer();
const AGENTS_FILE = path.join(__dirname, "..", "c5_agents.json");

// TINY test amount — 0.1 EGLD per agent
const TEST_FUND = BigInt(100_000_000_000_000_000); // 0.1 EGLD

function log(icon: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${icon} ${msg}`);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function apiGet(url: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { await sleep(500); continue; }
      return res.json();
    } catch { await sleep(500); }
  }
  throw new Error(`API failed: ${url}`);
}

async function sendTx(
  signer: UserSigner, from: string, to: string,
  nonce: number, value: bigint, gasLimit: bigint, data: string = ""
): Promise<string> {
  const tx = new Transaction({
    nonce: BigInt(nonce), value,
    sender: new Address(from), receiver: new Address(to),
    gasLimit, gasPrice: GAS_PRICE, chainID: CHAIN_ID,
    data: data ? new TextEncoder().encode(data) : new Uint8Array(),
  });
  const bytes = txComputer.computeBytesForSigning(tx);
  tx.signature = await signer.sign(bytes);
  const json = tx.toPlainObject();

  const res = await fetch(`${GATEWAY_URL}/transaction/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GW ${res.status}: ${body.substring(0, 150)}`);
  }
  const d: any = await res.json();
  if (d.error && d.error !== "") throw new Error(`GW error: ${d.error}`);
  return d?.data?.txHash || "";
}

async function main() {
  console.log(`
██████████████████████████████████████████████████████████████
█  🧪 C5 LIVE TEST — Full Pipeline Verification
█  Funding: 0.1 EGLD × 10 agents = 1 EGLD total
█  💚 OpenHeart Guild
██████████████████████████████████████████████████████████████
`);

  // Load GL wallet
  const glHex = process.env.GL_PRIVATE_KEY;
  if (!glHex) { log("❌", "GL_PRIVATE_KEY not set in .env!"); return; }

  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  
  // Load agents
  if (!fs.existsSync(AGENTS_FILE)) {
    log("❌", "c5_agents.json not found! Run: npx ts-node --transpileOnly scripts/c5_setup.ts wallets");
    return;
  }
  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));

  // Check GL balance
  const glInfo = await apiGet(`${API_URL}/accounts/${glAddr}`);
  const glBal = Number(BigInt(glInfo.balance)) / 1e18;
  log("💰", `GL wallet: ${glAddr.substring(0, 25)}...`);
  log("💰", `GL balance: ${glBal.toFixed(4)} EGLD`);
  
  if (glBal < 2) {
    log("❌", "Need at least 2 EGLD for test. Aborting.");
    return;
  }

  // ═══ STEP 1: Fund agents with 0.1 EGLD each ═══
  log("📤", "═══ STEP 1: Funding agents (0.1 EGLD each) ═══");
  let glNonce = glInfo.nonce;
  let funded = 0;

  for (let i = 0; i < wallets.length; i++) {
    try {
      const hash = await sendTx(glSigner, glAddr, wallets[i].address, glNonce, TEST_FUND, BigInt(50_000));
      log("✅", `Agent ${i} funded → TX: ${hash.substring(0, 20)}...`);
      glNonce++;
      funded++;
    } catch (e: any) {
      log("❌", `Agent ${i} fund FAILED: ${e.message?.substring(0, 80)}`);
    }
    if (i % 5 === 4) await sleep(500);
  }
  
  log("📊", `Funded ${funded}/${wallets.length} agents`);

  // ═══ STEP 2: Wait for confirmations ═══
  log("⏳", "═══ STEP 2: Waiting 12s for confirmations ═══");
  await sleep(12000);

  // Verify balances
  log("🔍", "Checking agent balances...");
  let allFunded = true;
  for (let i = 0; i < wallets.length; i++) {
    try {
      const info = await apiGet(`${API_URL}/accounts/${wallets[i].address}`);
      const bal = Number(BigInt(info.balance || "0")) / 1e18;
      const status = bal > 0 ? "✅" : "❌";
      log(status, `Agent ${i}: ${bal.toFixed(4)} EGLD | nonce: ${info.nonce}`);
      if (bal <= 0) allFunded = false;
    } catch {
      log("❌", `Agent ${i}: FAILED to fetch`);
      allFunded = false;
    }
    await sleep(200);
  }

  if (!allFunded) {
    log("⚠️", "Some agents not funded. Continuing with funded agents...");
  }

  // ═══ STEP 3: Test MoveBalance TX (agent → agent0) ═══
  log("🚀", "═══ STEP 3: Sending test MoveBalance TXs ═══");
  const targetAddr = wallets[0].address; // Use agent0 as test target
  let txSuccess = 0;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    try {
      const info = await apiGet(`${API_URL}/accounts/${w.address}`);
      if (Number(BigInt(info.balance || "0")) <= 0) {
        log("⚠️", `Agent ${i}: no balance, skipping`);
        continue;
      }
      const hash = await sendTx(signer, w.address, targetAddr, info.nonce, BigInt(0), BigInt(50_000));
      log("📤", `Agent ${i} → Agent 0: TX ${hash.substring(0, 20)}...`);
      txSuccess++;
    } catch (e: any) {
      log("❌", `Agent ${i} TX FAILED: ${e.message?.substring(0, 80)}`);
    }
    await sleep(300);
  }
  log("📊", `TX test: ${txSuccess}/${wallets.length} sent successfully`);

  // ═══ STEP 4: Verify on chain ═══
  log("⏳", "═══ STEP 4: Waiting 10s then verifying ═══");
  await sleep(10000);

  let verified = 0;
  for (let i = 0; i < wallets.length; i++) {
    try {
      const info = await apiGet(`${API_URL}/accounts/${wallets[i].address}`);
      if (info.nonce > 0) {
        log("✅", `Agent ${i}: nonce=${info.nonce} — TX CONFIRMED ON CHAIN`);
        verified++;
      } else {
        log("⚠️", `Agent ${i}: nonce=0 — TX pending or failed`);
      }
    } catch {
      log("❌", `Agent ${i}: failed to verify`);
    }
    await sleep(200);
  }

  // ═══ STEP 5: Cleanup — sweep back to GL ═══
  log("🧹", "═══ STEP 5: Sweeping funds back to GL ═══");
  let swept = 0;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    try {
      const info = await apiGet(`${API_URL}/accounts/${w.address}`);
      const bal = BigInt(info.balance || "0");
      const fee = BigInt(50_000) * GAS_PRICE;
      if (bal <= fee) {
        log("⚠️", `Agent ${i}: balance too low to sweep (${(Number(bal)/1e18).toFixed(6)} EGLD)`);
        continue;
      }
      const sweepAmt = bal - fee;
      const hash = await sendTx(signer, w.address, glAddr, info.nonce, sweepAmt, BigInt(50_000));
      log("🔄", `Agent ${i}: swept ${(Number(sweepAmt)/1e18).toFixed(4)} EGLD → GL`);
      swept++;
    } catch (e: any) {
      log("❌", `Agent ${i} sweep FAILED: ${e.message?.substring(0, 80)}`);
    }
    await sleep(300);
  }

  // ═══ RESULTS ═══
  console.log(`
██████████████████████████████████████████████████████████████
█  📊 LIVE TEST RESULTS
█  Funded:  ${funded}/${wallets.length} agents
█  TXs:     ${txSuccess}/${wallets.length} sent
█  Verified: ${verified}/${wallets.length} on chain
█  Swept:   ${swept}/${wallets.length} back to GL
█  
█  ${verified >= 8 ? "✅ READY FOR CHALLENGE!" : "⚠️ Some agents failed — check logs"}
██████████████████████████████████████████████████████████████
`);

  // Show explorer links for verification
  log("🔗", "Verify on explorer:");
  for (let i = 0; i < Math.min(3, wallets.length); i++) {
    log("🔗", `Agent ${i}: https://bon-explorer.multiversx.com/accounts/${wallets[i].address}`);
  }
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
