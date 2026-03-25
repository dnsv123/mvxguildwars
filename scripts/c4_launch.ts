/**
 * c4_launch.ts — FULLY AUTOMATED Challenge 4 Launch Script
 * 
 * ONE COMMAND to rule them all:
 *   npx ts-node --transpileOnly scripts/c4_launch.ts
 * 
 * What it does (in order):
 * 1. Check and fund all 60 wallets from GL (if not already funded)
 * 2. Wrap EGLD → WEGLD on all wallets (if needed)
 * 3. Print status
 * 4. Pre-sign burst TXs
 * 5. Wait for challenge window (C4_START env var or hardcoded)
 * 6. BLAST burst TXs at T=0
 * 7. Run sustained workers for remainder of window
 * 8. Drain forwarders
 * 
 * Env vars (optional overrides):
 *   C4_START  — ISO string for challenge start (default: 2026-03-26T16:00:00Z)
 *   C4_END    — ISO string for challenge end   (default: 2026-03-26T17:00:00Z)
 */
import "dotenv/config";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const ROOT = path.join(__dirname, "..");

function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts} UTC] ${icon} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function runSetup(step: string): void {
  log("🔧", `Running setup: ${step}...`);
  try {
    execSync(`npx ts-node --transpileOnly scripts/c4_setup.ts ${step}`, {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 300000, // 5 min max
    });
  } catch (e: any) {
    log("⚠️", `Setup ${step} had issues, continuing...`);
  }
}

async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🚀 C4 AUTO-LAUNCH — FULLY AUTOMATED");
  console.log("█  Fund → Wrap → Status → PRE-SIGN → BLAST → SUSTAINED");
  console.log("█  💚 OpenHeart Guild — NOW OR NEVER 💚");
  console.log("█".repeat(60) + "\n");

  // ═════════════════════════════════════
  //  PHASE 1: Ensure fleet wallets exist
  // ═════════════════════════════════════
  const walletPath = path.join(ROOT, "c4_wallets.json");
  const fleetPath = path.join(ROOT, "c4_wallets_60fleet.json");

  if (!fs.existsSync(walletPath) && fs.existsSync(fleetPath)) {
    log("📋", "Restoring 60-wallet fleet from backup...");
    fs.copyFileSync(fleetPath, walletPath);
  }

  if (!fs.existsSync(walletPath)) {
    log("❌", "No c4_wallets.json found! Run: npx ts-node --transpileOnly scripts/c4_setup.ts wallets");
    process.exit(1);
  }

  const wallets = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  log("📋", `Fleet: ${wallets.length} wallets loaded`);

  // ═════════════════════════════════════
  //  PHASE 2: Fund wallets (if needed)
  // ═════════════════════════════════════
  log("💰", "Checking if wallets need funding...");
  // Quick check: sample 3 wallets
  let needsFunding = false;
  for (const w of wallets.slice(0, 3)) {
    try {
      const r = await fetch(`https://api.battleofnodes.com/accounts/${w.address}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const egld = Number(BigInt(d.balance || "0")) / 1e18;
        if (egld < 1) { needsFunding = true; break; }
      }
    } catch { needsFunding = true; break; }
  }

  if (needsFunding) {
    log("💸", "Wallets need funding! Running fund...");
    runSetup("fund");
    log("⏳", "Waiting 20s for funding to confirm...");
    await sleep(20000);
  } else {
    log("✅", "Wallets already funded!");
  }

  // ═════════════════════════════════════
  //  PHASE 3: Wrap EGLD → WEGLD (if needed)
  // ═════════════════════════════════════
  log("🔄", "Checking WEGLD balances...");
  let needsWrapping = false;
  for (const w of wallets.slice(0, 3)) {
    try {
      const r = await fetch(`https://gateway.battleofnodes.com/address/${w.address}/esdt/WEGLD-bd4d79`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d: any = await r.json();
        const bal = d?.data?.tokenData?.balance;
        const wegld = bal ? Number(BigInt(bal)) / 1e18 : 0;
        if (wegld < 0.5) { needsWrapping = true; break; }
      } else { needsWrapping = true; break; }
    } catch { needsWrapping = true; break; }
  }

  if (needsWrapping) {
    log("🔄", "Wrapping EGLD → WEGLD...");
    runSetup("wrap");
    log("⏳", "Waiting 20s for wrapping to confirm...");
    await sleep(20000);
  } else {
    log("✅", "WEGLD already wrapped!");
  }

  // ═════════════════════════════════════
  //  PHASE 4: Status check
  // ═════════════════════════════════════
  runSetup("status");

  // ═════════════════════════════════════
  //  PHASE 5: Launch the Contract Storm!
  // ═════════════════════════════════════
  log("🚀", "Launching Contract Storm blaster...");
  log("🚀", "This will: pre-sign → wait → burst → sustained → drain");

  // Pass through env vars for window times
  const c4Start = process.env.C4_START || "2026-03-26T16:00:00Z";
  const c4End = process.env.C4_END || "2026-03-26T17:00:00Z";

  try {
    execSync(
      `C4_START="${c4Start}" C4_END="${c4End}" npx ts-node --transpileOnly scripts/c4_contract_storm.ts`,
      { cwd: ROOT, stdio: "inherit", timeout: 4200000 } // 70 min timeout
    );
  } catch (e: any) {
    log("❌", `Storm ended with error: ${e.message?.substring(0, 100)}`);
  }

  log("🏁", "AUTO-LAUNCH COMPLETE!");
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
