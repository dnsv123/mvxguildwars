/**
 * ═══════════════════════════════════════════════════════════════
 *  🔧 CHALLENGE 5: SETUP — Agent Wallets, Fund, Register, Status
 *
 *  Steps:
 *    wallets  — Generate 10 agent wallets → c5_agents.json
 *    fund     — Distribute EGLD from GL to agents (50 each)
 *    register — Register agents via MX-8004
 *    status   — Show agent balances + check
 *    test-tx  — Send 1 test TX per agent to verify chain delivery
 *    cleanup  — Sweep remaining EGLD back to GL
 *
 *  Usage: npx ts-node --transpileOnly scripts/c5_setup.ts [step]
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
const GATEWAY_URL = process.env.GATEWAY_URL || "https://gateway.battleofnodes.com";
const GAS_PRICE = BigInt(1_000_000_000);
const txComputer = new TransactionComputer();
const TARGET_ADDR = process.env.C5_TARGET_ADDR || "";
const REGISTRY_SC = process.env.C5_REGISTRY_SC || "erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p";

const AGENTS_FILE = path.join(__dirname, "..", "c5_agents.json");
const NUM_AGENTS = 10;
const FUND_PER_AGENT = BigInt(50_000_000_000_000_000_000); // 50 EGLD each

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

async function signAndSend(
  signer: UserSigner, from: string, to: string,
  nonce: number, value: bigint, gasLimit: bigint, data: string
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
    throw new Error(`GW ${res.status}: ${body.substring(0, 100)}`);
  }
  const d: any = await res.json();
  if (d.error && d.error !== "") throw new Error(`GW: ${d.error}`);
  return d?.data?.txHash || "";
}

// ═══════════════════════════════════════════════════════════════
//  STEP: Generate wallets
// ═══════════════════════════════════════════════════════════════
async function stepWallets() {
  if (fs.existsSync(AGENTS_FILE)) {
    const existing = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
    log("⚠️", `c5_agents.json already exists with ${existing.length} wallets. Delete first to regenerate.`);
    return;
  }

  const wallets: any[] = [];
  for (let i = 0; i < NUM_AGENTS; i++) {
    const mnemonic = Mnemonic.generate();
    const sk = mnemonic.deriveKey(0);
    const signer = new UserSigner(sk);
    wallets.push({
      index: i,
      address: signer.getAddress().bech32(),
      privateKey: Buffer.from(sk.valueOf()).toString("hex"),
      mnemonic: mnemonic.toString(),
    });
    log("🔑", `Agent ${i}: ${signer.getAddress().bech32()}`);
  }

  fs.writeFileSync(AGENTS_FILE, JSON.stringify(wallets, null, 2));
  log("✅", `Generated ${NUM_AGENTS} agent wallets → c5_agents.json`);
}

// ═══════════════════════════════════════════════════════════════
//  STEP: Fund agents from GL
// ═══════════════════════════════════════════════════════════════
async function stepFund() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  if (!glHex) { log("❌", "GL_PRIVATE_KEY not set!"); return; }

  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  const glInfo = await apiGet(`${API_URL}/accounts/${glAddr}`);
  const glBal = Number(BigInt(glInfo.balance)) / 1e18;

  log("💰", `GL: ${glBal.toFixed(4)} EGLD | Funding ${NUM_AGENTS} agents × 50 EGLD = ${NUM_AGENTS * 50} EGLD needed`);

  if (glBal < NUM_AGENTS * 50 + 1) {
    log("❌", `Not enough EGLD! Have ${glBal.toFixed(2)}, need ${NUM_AGENTS * 50 + 1}`);
    return;
  }

  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
  let nonce = glInfo.nonce;

  for (let i = 0; i < wallets.length; i++) {
    try {
      const hash = await signAndSend(glSigner, glAddr, wallets[i].address, nonce, FUND_PER_AGENT, BigInt(50_000), "");
      log("📤", `Funded agent ${i}: ${wallets[i].address.substring(0, 20)}... (50 EGLD) TX: ${hash.substring(0, 16)}...`);
      nonce++;
    } catch (e: any) {
      log("❌", `Fund error agent ${i}: ${e.message?.substring(0, 60)}`);
    }
    if (i % 5 === 4) await sleep(1000);
  }

  log("⏳", "Waiting 10s for confirmations...");
  await sleep(10000);
  log("✅", "Funding complete! Run 'status' to verify.");
}

// ═══════════════════════════════════════════════════════════════
//  STEP: Status check
// ═══════════════════════════════════════════════════════════════
async function stepStatus() {
  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
  let totalBal = 0;

  for (let i = 0; i < wallets.length; i++) {
    try {
      const info = await apiGet(`${API_URL}/accounts/${wallets[i].address}`);
      const bal = Number(BigInt(info.balance || "0")) / 1e18;
      totalBal += bal;
      log("🤖", `Agent ${i}: ${wallets[i].address.substring(0, 25)}... | ${bal.toFixed(4)} EGLD | nonce: ${info.nonce}`);
    } catch {
      log("⚠️", `Agent ${i}: ${wallets[i].address.substring(0, 25)}... | CANNOT FETCH`);
    }
    await sleep(200);
  }

  log("💰", `Total: ${totalBal.toFixed(4)} EGLD across ${wallets.length} agents`);
}

// ═══════════════════════════════════════════════════════════════
//  STEP: Test TX — Send 1 TX per agent, verify nonce changes
// ═══════════════════════════════════════════════════════════════
async function stepTestTx() {
  if (!TARGET_ADDR) { log("❌", "C5_TARGET_ADDR not set in .env!"); return; }

  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
  let success = 0;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    try {
      const info = await apiGet(`${API_URL}/accounts/${w.address}`);
      const nonceBefore = info.nonce;

      const hash = await signAndSend(signer, w.address, TARGET_ADDR, nonceBefore, BigInt(0), BigInt(50_000), "");
      log("📤", `Agent ${i} TX: ${hash.substring(0, 20)}...`);

      // Wait and verify nonce changed
      await sleep(3000);
      const infoAfter = await apiGet(`${API_URL}/accounts/${w.address}`);
      if (infoAfter.nonce > nonceBefore) {
        log("✅", `Agent ${i}: nonce ${nonceBefore} → ${infoAfter.nonce} ✓ TX CONFIRMED ON CHAIN`);
        success++;
      } else {
        log("⚠️", `Agent ${i}: nonce still ${nonceBefore} — TX may not have landed!`);
      }
    } catch (e: any) {
      log("❌", `Agent ${i} test FAILED: ${e.message?.substring(0, 60)}`);
    }
    await sleep(500);
  }

  log(success === wallets.length ? "✅" : "⚠️",
    `Test complete: ${success}/${wallets.length} agents confirmed TXs on chain`);
}

// ═══════════════════════════════════════════════════════════════
//  STEP: Register agents via MX-8004
// ═══════════════════════════════════════════════════════════════
async function stepRegister() {
  log("📋", "Agent registration via MX-8004...");
  log("⚠️", "NOTE: Use moltbot-starter-kit for MX-8004 registration.");
  log("⚠️", "Run on server: cd moltbot-starter-kit && npx ts-node scripts/register.ts");
  log("ℹ️", "Each agent wallet needs its own registration call.");

  // For now, list agent addresses for manual registration
  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
  log("📋", "Agent addresses for registration:");
  for (let i = 0; i < wallets.length; i++) {
    console.log(`  Agent ${i}: ${wallets[i].address}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP: Cleanup — sweep back to GL
// ═══════════════════════════════════════════════════════════════
async function stepCleanup() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();
  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    try {
      const info = await apiGet(`${API_URL}/accounts/${w.address}`);
      const bal = BigInt(info.balance || "0");
      const fee = BigInt(50_000) * GAS_PRICE;
      if (bal <= fee) { log("⚠️", `Agent ${i}: not enough balance to sweep`); continue; }
      const sendAmt = bal - fee;
      const hash = await signAndSend(signer, w.address, glAddr, info.nonce, sendAmt, BigInt(50_000), "");
      log("🔄", `Swept agent ${i}: ${(Number(sendAmt) / 1e18).toFixed(4)} EGLD → GL`);
    } catch (e: any) {
      log("❌", `Sweep error agent ${i}: ${e.message?.substring(0, 60)}`);
    }
    await sleep(500);
  }
  log("✅", "Cleanup complete!");
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  const step = process.argv[2]?.toLowerCase();

  console.log(`\n══════════════════════════════════════════════════`);
  console.log(` 🔧 C5 SETUP — Step: ${step || "(none)"}`);
  console.log(`══════════════════════════════════════════════════\n`);

  switch (step) {
    case "wallets": await stepWallets(); break;
    case "fund": await stepFund(); break;
    case "status": await stepStatus(); break;
    case "test-tx": await stepTestTx(); break;
    case "register": await stepRegister(); break;
    case "cleanup": await stepCleanup(); break;
    default:
      console.log("Usage: npx ts-node --transpileOnly scripts/c5_setup.ts [wallets|fund|status|test-tx|register|cleanup]");
  }
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
