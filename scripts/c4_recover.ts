/**
 * c4_recover.ts — Recover EGLD from ALL old wallets back to GL
 * 
 * Scans: wallets.json (old challenge), c4_forwarders.json (C4 old wallets)
 * Sends any remaining EGLD (keeping ~0.00005 for the sweep TX) back to GL.
 * 
 * Usage: npx ts-node --transpileOnly scripts/c4_recover.ts
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

const CHAIN_ID = "B";
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

function log(icon: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11,19)}] ${icon} ${msg}`);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function gwPost(path: string, body: any): Promise<any> {
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const url = `${ENDPOINTS[(epIdx + i) % ENDPOINTS.length]}${path}`;
    try {
      const headers: any = { "Content-Type": "application/json" };
      if (KEPLER_KEY && url.includes("kepler")) headers["api-key"] = KEPLER_KEY;
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const d: any = await r.json();
      epIdx = (epIdx + i) % ENDPOINTS.length;
      return d?.data;
    } catch { continue; }
  }
  throw new Error("All endpoints failed");
}

async function gwGet(urlPath: string): Promise<any> {
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const url = `${ENDPOINTS[(epIdx + i) % ENDPOINTS.length]}${urlPath}`;
    try {
      const headers: any = { "Content-Type": "application/json" };
      if (KEPLER_KEY && url.includes("kepler")) headers["api-key"] = KEPLER_KEY;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const d: any = await r.json();
      return d?.data;
    } catch { continue; }
  }
  return null;
}

async function getBalance(address: string): Promise<{ balance: bigint; nonce: number }> {
  const d = await gwGet(`/address/${address}`);
  if (!d?.account) return { balance: BigInt(0), nonce: 0 };
  return {
    balance: BigInt(d.account.balance || "0"),
    nonce: d.account.nonce || 0,
  };
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
  const json = JSON.parse(Buffer.from(bytes).toString());
  json.signature = Buffer.from(tx.signature).toString("hex");
  const d = await gwPost("/transaction/send", json);
  return d?.txHash || "unknown";
}

async function main() {
  const glHex = process.env.GL_PRIVATE_KEY!;
  const glSigner = new UserSigner(UserSecretKey.fromString(glHex));
  const glAddr = glSigner.getAddress().bech32();

  console.log("\n" + "═".repeat(60));
  log("🏦", `EGLD RECOVERY → ${glAddr}`);
  console.log("═".repeat(60));

  // Collect all wallet sources
  const sources: { address: string; privateKey: string; source: string }[] = [];

  // 1. Old challenge wallets (wallets.json)
  const walletsPath = path.join(__dirname, "..", "wallets.json");
  if (fs.existsSync(walletsPath)) {
    const old = JSON.parse(fs.readFileSync(walletsPath, "utf-8"));
    old.forEach((w: any) => sources.push({ ...w, source: "wallets.json" }));
    log("📋", `wallets.json: ${old.length} wallets`);
  }

  // 2. C4 forwarder wallets (c4_forwarders.json)
  const fwdPath = path.join(__dirname, "..", "c4_forwarders.json");
  if (fs.existsSync(fwdPath)) {
    const fwds = JSON.parse(fs.readFileSync(fwdPath, "utf-8"));
    fwds.forEach((f: any) => {
      if (f.wallet) sources.push({ address: f.wallet.address, privateKey: f.wallet.privateKey, source: "c4_fwd" });
    });
    log("📋", `c4_forwarders.json: ${fwds.length} wallets`);
  }

  log("🔍", `Scanning ${sources.length} wallets for EGLD...`);

  const MIN_RECOVER = BigInt(100_000_000_000_000); // 0.0001 EGLD
  const TX_FEE = BigInt(55_000_000_000_000);       // ~0.000055 EGLD
  let totalRecovered = BigInt(0);
  let walletsFound = 0;

  for (let i = 0; i < sources.length; i++) {
    const w = sources[i];
    try {
      const { balance, nonce } = await getBalance(w.address);

      if (balance > MIN_RECOVER + TX_FEE) {
        walletsFound++;
        const sendAmount = balance - TX_FEE;
        const egldStr = (Number(sendAmount) / 1e18).toFixed(4);
        const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
        const hash = await signAndSend(signer, w.address, glAddr, nonce, sendAmount, BigInt(50_000), "");
        totalRecovered += sendAmount;
        log("💸", `#${walletsFound} [${w.source}] ${egldStr} EGLD → GL | TX: ${hash.substring(0,16)}...`);
      }
    } catch (e: any) {
      // Silently skip failures
    }

    // Progress every 50 wallets
    if (i > 0 && i % 50 === 0) {
      log("📊", `Scanned ${i}/${sources.length}... Found ${walletsFound} with EGLD`);
    }
  }

  console.log("\n" + "═".repeat(60));
  log("✅", `RECOVERY COMPLETE`);
  log("💰", `Recovered: ${(Number(totalRecovered) / 1e18).toFixed(4)} EGLD from ${walletsFound} wallets`);
  log("🏦", `Target: ${glAddr}`);
  console.log("═".repeat(60));
}

main().catch(e => { console.error("❌", e); process.exit(1); });
