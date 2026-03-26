/**
 * 🔥 EMERGENCY SIMPLE BLASTER — Uses EXACT test-call code path
 * Each wallet sends 1 TX at a time, sequentially, proven to work.
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

// EXACT same signAndSend from c4_setup.ts (PROVEN WORKING)
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

async function acctNonce(addr: string): Promise<number> {
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

const CALL_TYPES = ["blindAsyncV1", "blindAsyncV2", "blindSync", "blindTransfExec"];

async function main() {
  // Load forwarders + wallets
  const fwds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_forwarders.json"), "utf-8"));
  const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "c4_wallets.json"), "utf-8"));

  // Map shard → forwarder address
  const shardForwarder: Record<number, string> = {};
  for (const f of fwds) shardForwarder[f.shard] = f.forwarderAddress;

  function getWalletShard(bech32: string): number {
    const pk = new Address(bech32).getPublicKey();
    const last = pk[pk.length - 1];
    let shard = last % 4;
    if (shard === 3) shard = last % 2;
    return shard;
  }

  // Build wallet list with signers
  const fleet = wallets.map((w: any) => ({
    address: w.address,
    shard: getWalletShard(w.address),
    signer: new UserSigner(UserSecretKey.fromString(w.privateKey)),
  }));

  log("🚀", `Simple Blaster: ${fleet.length} wallets, ${Object.keys(shardForwarder).length} forwarders`);
  log("🚀", `Window ends: ${new Date(WINDOW_END).toISOString()}`);

  let totalSent = 0;
  let totalErrors = 0;
  let callIdx = 0;
  const startTime = Date.now();

  while (Date.now() < WINDOW_END) {
    // Round-robin through wallets, send 1 TX each
    const promises: Promise<void>[] = [];

    for (const w of fleet) {
      const forwarder = shardForwarder[w.shard];
      if (!forwarder) continue;

      // S0 and S2: only async types (no blindSync, no blindTransfExec)
      let callType: string;
      if (w.shard === 0 || w.shard === 2) {
        callType = callIdx % 2 === 0 ? "blindAsyncV1" : "blindAsyncV2";
      } else {
        callType = CALL_TYPES[callIdx % CALL_TYPES.length];
      }

      promises.push((async () => {
        try {
          const nonce = await acctNonce(w.address);
          const data = buildSwapData(callType);
          await signAndSend(w.signer, w.address, forwarder, nonce, BigInt(0), GAS_LIMIT, data);
          totalSent++;
        } catch (e: any) {
          totalErrors++;
          if (totalErrors <= 3) log("❌", `${w.address.substring(0,15)}... ${e.message?.substring(0,60)}`);
        }
      })());
    }

    await Promise.all(promises);
    callIdx++;

    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.floor((WINDOW_END - Date.now()) / 1000);
    log("📊", `Round ${callIdx}: ${totalSent} sent | ${totalErrors} err | ${(totalSent/elapsed).toFixed(1)} tx/s | ${remaining}s left`);

    await sleep(200); // Brief pause between rounds
  }

  log("✅", `DONE! Total: ${totalSent} sent, ${totalErrors} errors in ${((Date.now()-startTime)/1000).toFixed(0)}s`);
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
