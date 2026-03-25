/**
 * ═══════════════════════════════════════════════════════════════
 *  🔥 CHALLENGE 4: CONTRACT STORM — FORWARDER BLASTER
 *
 *  Calls forwarder-blind contracts which forward DEX swaps.
 *  3 wallets (1/shard) → 3 forwarders → DEX pair (WEGLD/USDC)
 *  
 *  Call types: blindSync, blindAsyncV1, blindAsyncV2, blindTransfExec
 *  
 *  ESDTTransfer to forwarder:
 *  data: ESDTTransfer@WEGLD_hex@amount_hex@blindSync_hex@dest_hex@endpoint_hex@USDC_hex@minOut_hex
 *
 *  Usage: npx ts-node --transpileOnly scripts/c4_contract_storm.ts
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════
//  KEY ADDRESSES & TOKENS (from pre-brief)
// ═══════════════════════════════════════════════════════════════
const DEX_PAIR       = "erd1qqqqqqqqqqqqqpgqr8n2kjqhrupcrsceevkv6yydtjsgacvuqqqs23m8n6";
const SWAP_DEST      = "erd1qqqqqqqqqqqqqpgqeel2kumf0r8ffyhth7pqdujjat9nx0862jpsg2pqaq";
const WEGLD_TOKEN    = "WEGLD-bd4d79";
const USDC_TOKEN     = "USDC-c76f1f";
const SWAP_ENDPOINT  = "swapTokensFixedInput";
const CHAIN_ID       = "B";
const WRAP_SC        = "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44jurgn29psua5l2jps3ntjj3"; // wrapping SC

// ═══════════════════════════════════════════════════════════════
//  SCHEDULE — Challenge 4 Window
// ═══════════════════════════════════════════════════════════════
const WINDOW_START = process.env.C4_START || "2026-03-26T16:00:00Z";
const WINDOW_END   = process.env.C4_END   || "2026-03-26T17:00:00Z";

// ═══════════════════════════════════════════════════════════════
//  FORWARDER CONFIG — Set after deployment
// ═══════════════════════════════════════════════════════════════
interface ForwarderConfig {
  shard: number;
  wallet: { address: string; privateKey: string };
  forwarderAddress: string;
  callType: string; // blindSync, blindAsyncV1, etc.
}

// Will be loaded from c4_forwarders.json
let FORWARDERS: ForwarderConfig[] = [];

// ALL four call types must be used for full scoring
const ALL_CALL_TYPES = ["blindSync", "blindAsyncV1", "blindAsyncV2", "blindTransfExec"];
const callTypeCounts: Record<string, number> = {};
ALL_CALL_TYPES.forEach(t => callTypeCounts[t] = 0);

// ═══════════════════════════════════════════════════════════════
//  TX CONFIG
// ═══════════════════════════════════════════════════════════════
const GAS_LIMIT_SC    = BigInt(80_000_000); // 80M — forwarder→DEX chain needs 30-50M (unused gas is REFUNDED on MultiversX)
const GAS_PRICE_BASE  = BigInt(1_000_000_000);
const SWAP_AMOUNT     = BigInt(1_000_000_000_000_000); // 0.001 WEGLD per swap
const MIN_OUT_AMOUNT  = BigInt(1); // minimum 1 USDC unit
const MIN_EGLD_FOR_GAS = BigInt(80_000_000) * BigInt(1_000_000_000); // 0.08 EGLD max per tx (actual cost ~0.03 after refund)
const MIN_WEGLD_FOR_SWAP = SWAP_AMOUNT; // need at least 1 swap worth

// Multi-endpoint failover
const ENDPOINTS = [
  process.env.OBSERVER_URL,
  process.env.KEPLER_GATEWAY,
  "https://gateway.battleofnodes.com",
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
//  HEX ENCODING HELPERS
// ═══════════════════════════════════════════════════════════════
function strToHex(s: string): string {
  return Buffer.from(s).toString("hex");
}

function bigIntToHex(n: bigint): string {
  const h = n.toString(16);
  return h.length % 2 ? "0" + h : h;
}

function addressToHex(bech32: string): string {
  return Buffer.from(new Address(bech32).getPublicKey()).toString("hex");
}

/**
 * Build the `data` field for calling a forwarder with WEGLD payment.
 * 
 * Format: ESDTTransfer@tokenHex@amountHex@functionHex@destHex@endpointHex@tokenArgHex@minOutHex
 * 
 * The forwarder endpoints (blindSync etc.) take:
 *   - destination address (the DEX pair)
 *   - endpoint to call (swapTokensFixedInput)
 *   - arguments (USDC token identifier, min amount out)
 */
function buildForwarderCallData(
  callType: string,
  swapAmount: bigint,
  minOut: bigint,
): string {
  const parts = [
    "ESDTTransfer",
    strToHex(WEGLD_TOKEN),           // token identifier
    bigIntToHex(swapAmount),          // amount of WEGLD to send
    strToHex(callType),               // function on forwarder: blindSync etc.
    addressToHex(SWAP_DEST),          // destination: DEX pair swap endpoint
    strToHex(SWAP_ENDPOINT),          // endpoint: swapTokensFixedInput
    strToHex(USDC_TOKEN),             // token arg: USDC-c76f1f
    bigIntToHex(minOut),              // min amount out
  ];
  return parts.join("@");
}

/**
 * Build the `data` field for draining tokens from a forwarder.
 * Format: drain@tokenHex@
 */
function buildDrainData(tokenId: string): string {
  return `drain@${strToHex(tokenId)}@`;
}

/**
 * Build the `data` field for wrapping EGLD.
 * Receiver: wrapping SC, value: EGLD amount, data: "wrapEgld"
 */
function buildWrapData(): string {
  return "wrapEgld";
}

// ═══════════════════════════════════════════════════════════════
//  RAW HTTP — ZERO SDK NETWORKING
// ═══════════════════════════════════════════════════════════════
async function apiGet(endpoint: string): Promise<any> {
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
  return res.json();
}

async function gatewayPost(urlPath: string, body: any): Promise<any> {
  const url = `${getEndpoint()}${urlPath}`;
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
    throw new Error(`Gateway ${res.status}: ${txt.substring(0, 200)}`);
  }
  return res.json();
}

async function getAccountInfo(addr: string): Promise<{ balance: bigint; nonce: number }> {
  const d = await apiGet(`${API_URL}/accounts/${addr}`);
  return { balance: BigInt(d.balance), nonce: d.nonce };
}

async function getTokenBalance(addr: string, token: string): Promise<bigint> {
  // Use GATEWAY (not API) — the BoN API indexer has lag for ESDT balances
  // Gateway queries blockchain state directly = always accurate
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${getEndpoint()}/address/${addr}/esdt/${token}`;
      const headers: any = { "Content-Type": "application/json" };
      if (KEPLER_KEY && getEndpoint().includes("kepler")) headers["api-key"] = KEPLER_KEY;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) { await sleep(300); continue; }
      const d = await res.json();
      const bal = d?.data?.tokenData?.balance;
      if (bal) return BigInt(bal);
      return BigInt(0);
    } catch {
      await sleep(500);
    }
  }
  // Fallback to API
  try {
    const d = await apiGet(`${API_URL}/accounts/${addr}/tokens/${token}`);
    return BigInt(d.balance || "0");
  } catch {
    return BigInt(0);
  }
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

async function signAndSerializeSC(
  signer: UserSigner,
  senderAddr: string,
  receiverAddr: string,
  nonce: number,
  value: bigint,
  gasLimit: bigint,
  gasPrice: bigint,
  dataField: string,
): Promise<any> {
  const tx = new Transaction({
    nonce: BigInt(nonce),
    value,
    sender: new Address(senderAddr),
    receiver: new Address(receiverAddr),
    gasLimit,
    gasPrice,
    chainID: CHAIN_ID,
    data: new TextEncoder().encode(dataField),
  });

  const bytesForSigning = txComputer.computeBytesForSigning(tx);
  tx.signature = await signer.sign(bytesForSigning);

  const txJson = JSON.parse(Buffer.from(bytesForSigning).toString());
  txJson.signature = Buffer.from(tx.signature).toString("hex");

  return txJson;
}

// Gas price is fixed at 1x — no tapering to conserve EGLD
function getGasPrice(): bigint {
  return GAS_PRICE_BASE;
}

// ═══════════════════════════════════════════════════════════════
//  FORWARDER WORKER — Blast SC calls from one wallet
// ═══════════════════════════════════════════════════════════════
async function forwarderWorker(
  config: ForwarderConfig,
  windowEndMs: number,
  windowStartMs: number,
): Promise<{ sent: number; errors: number }> {
  const { wallet, forwarderAddress, shard } = config;
  const signer = new UserSigner(UserSecretKey.fromString(wallet.privateKey));
  
  let { nonce, balance: egldBal } = await getAccountInfo(wallet.address);
  let wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
  let sent = 0;
  let errors = 0;
  let batchCount = 0;
  let callTypeIdx = 0; // rotate through all 4 call types
  const BATCH_SIZE = 5;
  const NONCE_RESYNC_INTERVAL = 30;

  log("🔥", `Shard ${shard} worker: ALL 4 CALL TYPES → ${forwarderAddress.substring(0,20)}...`);
  log("💰", `  EGLD: ${(Number(egldBal) / 1e18).toFixed(4)} | WEGLD: ${(Number(wegldBal) / 1e18).toFixed(4)}`);

  while (Date.now() < windowEndMs) {
    // Safety: check balances
    const gasNeeded = MIN_EGLD_FOR_GAS * BigInt(BATCH_SIZE);

    if (egldBal < gasNeeded) {
      log("⚠️", `S${shard}: Low EGLD (${(Number(egldBal)/1e18).toFixed(4)}). Re-syncing...`);
      const fresh = await getAccountInfo(wallet.address);
      egldBal = fresh.balance;
      nonce = fresh.nonce;
      if (egldBal < MIN_EGLD_FOR_GAS) {
        log("🛑", `S${shard}: Out of EGLD for gas! Stopping.`);
        break;
      }
    }

    if (wegldBal < MIN_WEGLD_FOR_SWAP) {
      log("⚠️", `S${shard}: Low WEGLD (${(Number(wegldBal)/1e18).toFixed(4)}). Re-syncing...`);
      wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
      if (wegldBal < MIN_WEGLD_FOR_SWAP) {
        log("🛑", `S${shard}: Out of WEGLD! Stopping.`);
        break;
      }
    }

    // Periodic nonce re-sync
    if (batchCount > 0 && batchCount % NONCE_RESYNC_INTERVAL === 0) {
      const fresh = await getAccountInfo(wallet.address);
      nonce = fresh.nonce;
      egldBal = fresh.balance;
      wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
      log("🔄", `S${shard}: Nonce re-sync → ${nonce} | EGLD: ${(Number(egldBal)/1e18).toFixed(4)}`);
    }

    // Pick call type — round-robin across all 4
    const callType = ALL_CALL_TYPES[callTypeIdx % ALL_CALL_TYPES.length];
    callTypeIdx++;

    const gasPrice = getGasPrice();
    const batch: any[] = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      try {
        const data = buildForwarderCallData(callType, SWAP_AMOUNT, MIN_OUT_AMOUNT);
        const txJson = await signAndSerializeSC(
          signer,
          wallet.address,
          forwarderAddress,
          nonce,
          BigInt(0),
          GAS_LIMIT_SC,
          gasPrice,
          data,
        );
        batch.push(txJson);
        nonce++;
      } catch (e: any) {
        errors++;
      }
    }

    if (batch.length === 0) break;

    try {
      const ok = await sendTxBatchRaw(batch);
      sent += ok;
      totalSent += ok;
      callTypeCounts[callType] = (callTypeCounts[callType] || 0) + ok;
      egldBal -= GAS_LIMIT_SC * gasPrice * BigInt(ok);
      wegldBal -= SWAP_AMOUNT * BigInt(ok);
    } catch {
      errors++;
      totalErrors++;
      failoverEndpoint();
      const fresh = await getAccountInfo(wallet.address);
      nonce = fresh.nonce;
      egldBal = fresh.balance;
    }

    batchCount++;
    await sleep(300);
  }

  return { sent, errors };
}

// ═══════════════════════════════════════════════════════════════
//  DRAIN — Recover tokens stuck in forwarders
// ═══════════════════════════════════════════════════════════════
async function drainForwarder(
  config: ForwarderConfig,
  tokenId: string,
): Promise<void> {
  const signer = new UserSigner(UserSecretKey.fromString(config.wallet.privateKey));
  const { nonce } = await getAccountInfo(config.wallet.address);

  const data = buildDrainData(tokenId);
  const txJson = await signAndSerializeSC(
    signer,
    config.wallet.address,
    config.forwarderAddress,
    nonce,
    BigInt(0),
    BigInt(10_000_000),
    GAS_PRICE_BASE,
    data,
  );

  try {
    const hash = await sendTxRaw(txJson);
    log("🔄", `Drain ${tokenId} from S${config.shard} forwarder: ${hash}`);
  } catch (e: any) {
    log("⚠️", `Drain error S${config.shard}: ${e.message?.substring(0, 80)}`);
  }
}

async function drainAllForwarders(): Promise<void> {
  log("🔄", "Draining all forwarders...");
  for (const f of FORWARDERS) {
    // Drain both USDC and WEGLD
    await drainForwarder(f, USDC_TOKEN);
    await drainForwarder(f, WEGLD_TOKEN);
    await sleep(500);
  }
  log("✅", "Drain complete");
}

// ═══════════════════════════════════════════════════════════════
//  WRAP EGLD → WEGLD
// ═══════════════════════════════════════════════════════════════
async function wrapEgld(
  wallet: { address: string; privateKey: string },
  amount: bigint,
): Promise<string> {
  const signer = new UserSigner(UserSecretKey.fromString(wallet.privateKey));
  const { nonce } = await getAccountInfo(wallet.address);

  const txJson = await signAndSerializeSC(
    signer,
    wallet.address,
    WRAP_SC,
    nonce,
    amount,
    BigInt(5_000_000),
    GAS_PRICE_BASE,
    "wrapEgld",
  );

  const hash = await sendTxRaw(txJson);
  log("🔄", `Wrapped ${Number(amount) / 1e18} EGLD → WEGLD: ${hash}`);
  return hash;
}

// ═══════════════════════════════════════════════════════════════
//  STATS & CHECKPOINTING
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
//  MULTI-WALLET WORKER — Creates one worker per wallet
//  Each wallet maps to its shard's forwarder contract
//  Shard 1: all 4 call types (blindSync works same-shard)
//  Shard 0/2: 3 async types only (blindSync fails cross-shard!)
// ═══════════════════════════════════════════════════════════════
interface WalletWorkerConfig {
  wallet: { address: string; privateKey: string };
  shard: number;
  forwarderAddress: string;
  callTypes: string[]; // which call types this worker uses
  workerId: number;
}

async function walletWorker(
  config: WalletWorkerConfig,
  windowEndMs: number,
  windowStartMs: number,
): Promise<{ sent: number; errors: number }> {
  const { wallet, forwarderAddress, shard, callTypes, workerId } = config;
  const signer = new UserSigner(UserSecretKey.fromString(wallet.privateKey));
  
  let { nonce, balance: egldBal } = await getAccountInfo(wallet.address);
  let wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
  let sent = 0;
  let errors = 0;
  let batchCount = 0;
  let callTypeIdx = 0;
  const BATCH_SIZE = 5;
  const NONCE_RESYNC_INTERVAL = 30;

  log("🔥", `W${workerId} S${shard}: ${callTypes.length} types → ${forwarderAddress.substring(0,20)}...`);
  log("💰", `  EGLD: ${(Number(egldBal) / 1e18).toFixed(4)} | WEGLD: ${(Number(wegldBal) / 1e18).toFixed(4)}`);

  while (Date.now() < windowEndMs) {
    const gasNeeded = MIN_EGLD_FOR_GAS * BigInt(BATCH_SIZE);

    if (egldBal < gasNeeded) {
      const fresh = await getAccountInfo(wallet.address);
      egldBal = fresh.balance;
      nonce = fresh.nonce;
      if (egldBal < MIN_EGLD_FOR_GAS) {
        log("🛑", `W${workerId} S${shard}: Out of EGLD! Stopping.`);
        break;
      }
    }

    if (wegldBal < MIN_WEGLD_FOR_SWAP) {
      wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
      if (wegldBal < MIN_WEGLD_FOR_SWAP) {
        log("🛑", `W${workerId} S${shard}: Out of WEGLD! Stopping.`);
        break;
      }
    }

    // Periodic nonce re-sync
    if (batchCount > 0 && batchCount % NONCE_RESYNC_INTERVAL === 0) {
      const fresh = await getAccountInfo(wallet.address);
      nonce = fresh.nonce;
      egldBal = fresh.balance;
      wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
    }

    // Pick call type — round-robin across this worker's allowed types
    const callType = callTypes[callTypeIdx % callTypes.length];
    callTypeIdx++;

    const gasPrice = getGasPrice();
    const batch: any[] = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      try {
        const data = buildForwarderCallData(callType, SWAP_AMOUNT, MIN_OUT_AMOUNT);
        const txJson = await signAndSerializeSC(
          signer,
          wallet.address,
          forwarderAddress,
          nonce,
          BigInt(0),
          GAS_LIMIT_SC,
          gasPrice,
          data,
        );
        batch.push(txJson);
        nonce++;
        wegldBal -= SWAP_AMOUNT;
        egldBal -= GAS_LIMIT_SC * gasPrice;
      } catch (e: any) {
        errors++;
        totalErrors++;
      }
    }

    // Send batch
    for (const txJson of batch) {
      try {
        await sendTxRaw(txJson);
        sent++;
        totalSent++;
        callTypeCounts[callType] = (callTypeCounts[callType] || 0) + 1;
      } catch (e: any) {
        errors++;
        totalErrors++;
        if (e.message?.includes("nonce")) {
          const fresh = await getAccountInfo(wallet.address);
          nonce = fresh.nonce;
          break;
        }
      }
    }

    batchCount++;
    await sleep(50); // Tiny pause between batches for fairness
  }

  return { sent, errors };
}

// ═══════════════════════════════════════════════════════════════
//  MAIN — 60-WALLET FLEET
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  🚀 CHALLENGE 4: CONTRACT STORM");
  console.log("█  60-Wallet Fleet × 4 Call Types × 3 Shards");
  console.log("█  💚 OpenHeart Guild — NOW OR NEVER 💚");
  console.log("█".repeat(60) + "\n");

  // Load forwarder contracts (3 — one per shard)
  const fwdPath = path.join(__dirname, "..", "c4_forwarders.json");
  if (!fs.existsSync(fwdPath)) {
    log("❌", `Missing c4_forwarders.json. Deploy forwarders first.`);
    process.exit(1);
  }
  FORWARDERS = JSON.parse(fs.readFileSync(fwdPath, "utf-8"));
  
  // Build shard → forwarder map
  const fwdByShard: Record<number, string> = {};
  for (const f of FORWARDERS) {
    fwdByShard[f.shard] = f.forwarderAddress;
  }

  // Load wallet fleet
  const walletPath = path.join(__dirname, "..", "c4_wallets.json");
  if (!fs.existsSync(walletPath)) {
    log("❌", `Missing c4_wallets.json. Run setup wallets first.`);
    process.exit(1);
  }
  const wallets: { shard: number; address: string; privateKey: string }[] = 
    JSON.parse(fs.readFileSync(walletPath, "utf-8"));

  log("📋", `Loaded ${FORWARDERS.length} forwarders + ${wallets.length} wallets`);
  log("🌐", `Endpoints: ${ENDPOINTS.join(' → ')}`);
  log("🌐", `API: ${API_URL}`);

  // Create worker configs — map each wallet to its shard's forwarder
  // CRITICAL: blindSync only works SAME-SHARD (Shard 1)
  // Shard 0/2 = cross-shard → only 3 async types
  const SHARD1_TYPES = ["blindSync", "blindAsyncV1", "blindAsyncV2", "blindTransfExec"];
  const CROSS_SHARD_TYPES = ["blindAsyncV1", "blindAsyncV2", "blindTransfExec"];

  const workerConfigs: WalletWorkerConfig[] = [];
  let widx = 0;
  const shardCounts = { 0: 0, 1: 0, 2: 0 } as Record<number, number>;

  for (const w of wallets) {
    const fwdAddr = fwdByShard[w.shard];
    if (!fwdAddr) {
      log("⚠️", `No forwarder for shard ${w.shard}, skipping wallet ${w.address.substring(0,16)}`);
      continue;
    }
    const callTypes = w.shard === 1 ? SHARD1_TYPES : CROSS_SHARD_TYPES;
    workerConfigs.push({
      wallet: { address: w.address, privateKey: w.privateKey },
      shard: w.shard,
      forwarderAddress: fwdAddr,
      callTypes,
      workerId: widx,
    });
    shardCounts[w.shard] = (shardCounts[w.shard] || 0) + 1;
    widx++;
  }

  log("🚀", `Fleet: ${workerConfigs.length} workers`);
  for (const s of [0,1,2]) {
    const types = s === 1 ? '4 types (incl. blindSync)' : '3 async types';
    log("📡", `  S${s}: ${shardCounts[s]} workers → ${fwdByShard[s]?.substring(0,20)}... [${types}]`);
  }

  // Show aggregate balance per shard
  for (const s of [0,1,2]) {
    const sw = wallets.filter(w => w.shard === s);
    let totalEgld = BigInt(0), totalWegld = BigInt(0);
    // Sample first 3 wallets for speed  
    for (const w of sw.slice(0, 3)) {
      const { balance } = await getAccountInfo(w.address);
      const wegld = await getTokenBalance(w.address, WEGLD_TOKEN);
      totalEgld += balance;
      totalWegld += wegld;
    }
    const avgEgld = Number(totalEgld) / 3 / 1e18;
    const avgWegld = Number(totalWegld) / 3 / 1e18;
    log("💰", `  S${s}: ~${(avgEgld * sw.length).toFixed(2)} EGLD total, ~${(avgWegld * sw.length).toFixed(2)} WEGLD total (sampled)`);
  }

  // Wait for window
  await waitUntil(WINDOW_START, "CHALLENGE 4 START");

  const windowEndMs = new Date(WINDOW_END).getTime();
  const windowStartMs = Date.now();

  // FIRE ALL WORKERS
  log("🔥", `FIRING ${workerConfigs.length} WALLET WORKERS!`);

  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - windowStartMs) / 1000;
    const txps = elapsed > 0 ? Math.round(totalSent / elapsed) : 0;
    const rem = Math.max(0, Math.round((windowEndMs - Date.now()) / 1000));
    log("📊", `${totalSent} tx | ${txps} tx/s | Err: ${totalErrors} | ${rem}s left`);
    // Call type breakdown
    const breakdown = ALL_CALL_TYPES.map(t => `${t.replace('blind','')}:${callTypeCounts[t]||0}`).join(' | ');
    log("📡", `  ${breakdown}`);
    try {
      const cp = { totalSent, totalErrors, txps, callTypeCounts, elapsed, timestamp: new Date().toISOString() };
      fs.writeFileSync(path.join(__dirname, "..", "checkpoint.json"), JSON.stringify(cp, null, 2));
    } catch {}
  }, 5000);

  const results = await Promise.all(
    workerConfigs.map(wc => walletWorker(wc, windowEndMs, windowStartMs))
  );

  clearInterval(statsTimer);

  // SUMMARY
  console.log("\n" + "═".repeat(60));
  log("📊", "CONTRACT STORM SUMMARY");
  
  for (const s of [0,1,2]) {
    const shardResults = results.filter((_, i) => workerConfigs[i].shard === s);
    const shardSent = shardResults.reduce((a, r) => a + r.sent, 0);
    const shardErr = shardResults.reduce((a, r) => a + r.errors, 0);
    log("📡", `Shard ${s}: ${shardSent} sent, ${shardErr} errors (${shardResults.length} workers)`);
  }
  
  console.log(`\n  Call Type Breakdown:`);
  for (const ct of ALL_CALL_TYPES) {
    const count = callTypeCounts[ct] || 0;
    const status = count >= 300 ? '✅' : '❌';
    console.log(`    ${status} ${ct}: ${count} (min 300)`);
  }
  const elapsed = ((Date.now() - windowStartMs) / 1000).toFixed(1);
  console.log(`\n   TOTAL: ${totalSent} tx in ${elapsed}s (${Math.round(totalSent / parseFloat(elapsed))} tx/s)`);
  console.log("═".repeat(60));

  // DRAIN all forwarders
  log("🔄", "Draining forwarder contracts...");
  await drainAllForwarders();

  log("🏁", "Challenge 4: Contract Storm COMPLETE!");
  process.exit(0);
}

main().catch(err => { console.error("❌ Fatal:", err); process.exit(1); });

