/**
 * 🔥 DEPLOYER BLASTER — Uses ONLY the 3 deployer wallets that PRODUCE CALLS
 * Local nonce tracking. Rapid fire. No API per TX.
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const CHAIN_ID = "B";
const GW = "https://gateway.battleofnodes.com";
const API = process.env.API_URL || "https://api.battleofnodes.com";
const GAS_PRICE = BigInt(1_000_000_000);
const GAS_LIMIT = BigInt(30_000_000); // 30M — MUST match test-call! 80M drains EGLD too fast
const txComputer = new TransactionComputer();

const WEGLD_TOKEN = "WEGLD-bd4d79";
const USDC_TOKEN  = "USDC-c76f1f";
const SWAP_DEST   = "erd1qqqqqqqqqqqqqpgqeel2kumf0r8ffyhth7pqdujjat9nx0862jpsg2pqaq";
const SWAP_ENDPOINT = "swapTokensFixedInput";
const SWAP_AMOUNT = BigInt(1_000_000_000_000_000); // 0.001 WEGLD

const WINDOW_END = new Date("2026-03-26T17:00:00Z").getTime();

function strToHex(s: string): string { return Buffer.from(s).toString("hex"); }
function bigIntToHex(n: bigint): string { const h = n.toString(16); return h.length % 2 ? "0" + h : h; }
function addressToHex(b: string): string { return Buffer.from(new Address(b).getPublicKey()).toString("hex"); }
function log(i: string, m: string) { console.log(`[${new Date().toISOString().slice(11,19)}] ${i} ${m}`); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function sendTx(
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

  const res = await fetch(`${GW}/transaction/send`, {
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

async function getNonce(addr: string): Promise<number> {
  // Try gateway first (most accurate), fallback to API
  try {
    const r = await fetch(`${GW}/address/${addr}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d: any = await r.json();
      return d?.data?.account?.nonce || 0;
    }
  } catch {}
  const r = await fetch(`${API}/accounts/${addr}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`API ${r.status}`);
  const d: any = await r.json();
  return d.nonce as number;
}

function buildSwapData(callType: string): string {
  return [
    "ESDTTransfer",
    strToHex(WEGLD_TOKEN),
    bigIntToHex(SWAP_AMOUNT),
    strToHex(callType),
    addressToHex(SWAP_DEST),
    strToHex(SWAP_ENDPOINT),
    strToHex(USDC_TOKEN),
    bigIntToHex(BigInt(1)),
  ].join("@");
}

const CALL_TYPES_S1 = ["blindAsyncV1", "blindAsyncV2", "blindSync", "blindTransfExec"];
const CALL_TYPES_OTHER = ["blindAsyncV1", "blindAsyncV2"];

async function deployerWorker(
  walletAddr: string, walletKey: string, forwarderAddr: string, shard: number,
  stats: { sent: number; errors: number; }
): Promise<void> {
  const signer = new UserSigner(UserSecretKey.fromString(walletKey));
  let nonce = await getNonce(walletAddr);
  const types = shard === 1 ? CALL_TYPES_S1 : CALL_TYPES_OTHER;
  let callIdx = 0;

  log("🔥", `S${shard} deployer ${walletAddr.substring(0,20)}... nonce=${nonce}`);

  while (Date.now() < WINDOW_END) {
    const callType = types[callIdx % types.length];
    callIdx++;
    const data = buildSwapData(callType);

    try {
      await sendTx(signer, walletAddr, forwarderAddr, nonce, BigInt(0), GAS_LIMIT, data);
      nonce++; // LOCAL increment
      stats.sent++;
    } catch (e: any) {
      stats.errors++;
      if (stats.errors <= 5) log("❌", `S${shard}: ${e.message?.substring(0, 80)}`);
      // Re-sync nonce on error
      await sleep(1000);
      try { nonce = await getNonce(walletAddr); } catch {}
    }

    // Tiny pause to not hammer gateway — 50ms = ~20 tx/s per worker
    await sleep(50);
  }
}

async function main() {
  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));

  log("🚀", `DEPLOYER BLASTER: ${fwds.length} deployer wallets (PROVEN TO PRODUCE CALLS)`);
  log("🚀", `Window ends: ${new Date(WINDOW_END).toISOString()}`);

  const stats = { sent: 0, errors: 0 };
  const startTime = Date.now();

  // Status logger
  const statusInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.floor((WINDOW_END - Date.now()) / 1000);
    log("📊", `${stats.sent} calls | ${stats.errors} err | ${(stats.sent/elapsed).toFixed(1)} calls/s | ${remaining}s left`);
  }, 5000);

  // Fire all 3 deployer workers in parallel
  const workers = fwds.map((f: any) =>
    deployerWorker(f.wallet.address, f.wallet.privateKey, f.forwarderAddress, f.shard, stats)
  );

  await Promise.all(workers);
  clearInterval(statusInterval);

  const elapsed = (Date.now() - startTime) / 1000;
  log("✅", `DONE! ${stats.sent} total calls, ${stats.errors} errors in ${elapsed.toFixed(0)}s (${(stats.sent/elapsed).toFixed(1)} calls/s)`);
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
