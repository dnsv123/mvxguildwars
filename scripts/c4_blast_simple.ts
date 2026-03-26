/**
 * 🔥 EMERGENCY BLASTER v2 — Local nonce tracking (no API per-TX)
 * Fetches nonce ONCE per wallet, then increments locally.
 * Re-syncs only on error.
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
const GAS_LIMIT = BigInt(80_000_000);
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
  if (!res.ok) throw new Error(`GW ${res.status}`);
  const d: any = await res.json();
  if (d.error && d.error !== "") throw new Error(`GW: ${d.error}`);
  return d?.data?.txHash || "";
}

async function getNonce(addr: string): Promise<number> {
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

const CALL_TYPES_ASYNC = ["blindAsyncV1", "blindAsyncV2"];
const CALL_TYPES_ALL = ["blindAsyncV1", "blindAsyncV2", "blindSync", "blindTransfExec"];

function getWalletShard(bech32: string): number {
  const pk = new Address(bech32).getPublicKey();
  const last = pk[pk.length - 1];
  let shard = last % 4;
  if (shard === 3) shard = last % 2;
  return shard;
}

async function main() {
  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));

  const shardForwarder: Record<number, string> = {};
  for (const f of fwds) shardForwarder[f.shard] = f.forwarderAddress;

  interface Worker { address: string; shard: number; signer: UserSigner; nonce: number; alive: boolean; }
  const fleet: Worker[] = wallets.map((w: any) => ({
    address: w.address,
    shard: getWalletShard(w.address),
    signer: new UserSigner(UserSecretKey.fromString(w.privateKey)),
    nonce: -1, // will be fetched
    alive: true,
  }));

  // Fetch initial nonces — staggered to avoid API overload
  log("🔄", "Fetching initial nonces...");
  const BATCH = 10;
  for (let i = 0; i < fleet.length; i += BATCH) {
    const batch = fleet.slice(i, i + BATCH);
    await Promise.all(batch.map(async (w) => {
      try {
        w.nonce = await getNonce(w.address);
      } catch { w.alive = false; }
    }));
    await sleep(200);
  }
  const aliveCount = fleet.filter(w => w.alive).length;
  log("✅", `Nonces loaded: ${aliveCount}/${fleet.length} wallets ready`);

  let totalSent = 0;
  let totalErrors = 0;
  let round = 0;
  const startTime = Date.now();

  while (Date.now() < WINDOW_END) {
    round++;
    const alive = fleet.filter(w => w.alive);
    if (alive.length === 0) { log("🛑", "All wallets dead!"); break; }

    // Send 1 TX per alive wallet, 15 at a time to avoid gateway overload
    const CONCURRENCY = 15;
    for (let i = 0; i < alive.length; i += CONCURRENCY) {
      const chunk = alive.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (w) => {
        const forwarder = shardForwarder[w.shard];
        if (!forwarder) return;

        const types = (w.shard === 1) ? CALL_TYPES_ALL : CALL_TYPES_ASYNC;
        const callType = types[round % types.length];
        const data = buildSwapData(callType);

        try {
          await sendTx(w.signer, w.address, forwarder, w.nonce, BigInt(0), GAS_LIMIT, data);
          w.nonce++; // LOCAL increment — no API needed!
          totalSent++;
        } catch (e: any) {
          totalErrors++;
          // Try to re-sync nonce on error
          try { w.nonce = await getNonce(w.address); } catch { w.alive = false; }
        }
      }));
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.floor((WINDOW_END - Date.now()) / 1000);
    if (round % 5 === 0 || round <= 3) {
      log("📊", `R${round}: ${totalSent} sent | ${totalErrors} err | ${(totalSent/elapsed).toFixed(1)} tx/s | ${remaining}s left | ${alive.length} alive`);
    }

    await sleep(100); // Minimal pause between rounds
  }

  log("✅", `DONE! Total: ${totalSent} sent, ${totalErrors} errors in ${((Date.now()-startTime)/1000).toFixed(0)}s`);
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
