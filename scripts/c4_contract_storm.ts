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
let   USDC_SWAP_AMOUNT = BigInt(30_000); // ~0.03 USDC, calibrated at startup from DEX rate
const MIN_OUT_AMOUNT  = BigInt(1); // minimum 1 unit (slippage protection)
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
 * Build the `data` field for REVERSE swap: USDC → WEGLD via forwarder.
 * Same structure as forward, but tokens/amounts are swapped.
 */
function buildReverseSwapData(
  callType: string,
  usdcAmount: bigint,
  minOut: bigint,
): string {
  const parts = [
    "ESDTTransfer",
    strToHex(USDC_TOKEN),             // token: USDC
    bigIntToHex(usdcAmount),           // amount of USDC to send
    strToHex(callType),                // function on forwarder
    addressToHex(SWAP_DEST),           // destination: DEX pair
    strToHex(SWAP_ENDPOINT),           // endpoint: swapTokensFixedInput
    strToHex(WEGLD_TOKEN),             // expected output: WEGLD
    bigIntToHex(minOut),               // min amount out
  ];
  return parts.join("@");
}

/**
 * Calibrate USDC swap amount by querying DEX pair reserves.
 * Returns the USDC equivalent of SWAP_AMOUNT WEGLD (with 10% safety margin).
 */
async function calibrateUsdcAmount(): Promise<bigint> {
  try {
    const wegldReserve = await getTokenBalance(SWAP_DEST, WEGLD_TOKEN);
    const usdcReserve = await getTokenBalance(SWAP_DEST, USDC_TOKEN);
    if (wegldReserve > BigInt(0) && usdcReserve > BigInt(0)) {
      // Expected USDC for SWAP_AMOUNT WEGLD: (SWAP_AMOUNT * usdcReserve) / wegldReserve
      const expectedUsdc = (SWAP_AMOUNT * usdcReserve) / wegldReserve;
      // Use 90% for safety (fees + slippage)
      const safeAmount = (expectedUsdc * BigInt(90)) / BigInt(100);
      log("📊", `DEX reserves: ${(Number(wegldReserve)/1e18).toFixed(2)} WEGLD / ${(Number(usdcReserve)/1e6).toFixed(2)} USDC`);
      log("📊", `Calibrated: 0.001 WEGLD ≈ ${(Number(expectedUsdc)/1e6).toFixed(6)} USDC → using ${(Number(safeAmount)/1e6).toFixed(6)} USDC for reverse swaps`);
      return safeAmount > BigInt(100) ? safeAmount : BigInt(30_000);
    }
  } catch (e: any) {
    log("⚠️", `DEX rate calibration failed: ${e.message?.substring(0, 60)}`);
  }
  log("⚠️", `Using fallback USDC amount: 0.03 USDC (30000 units)`);
  return BigInt(30_000);
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
  const RETRIES = 3;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const timeoutMs = 10000 + attempt * 5000; // 10s, 15s, 20s
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
      return res.json();
    } catch (e: any) {
      if (attempt < RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw e; // last attempt
    }
  }
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

let _firstGwError = true; // log first gateway error for diagnostics

async function sendTxRaw(txJson: any): Promise<string> {
  const d = await gatewayPost("/transaction/send", txJson);
  if (d?.error && d.error !== "") {
    if (_firstGwError) { log("🚨", `GW error: ${d.error} | code: ${d.code}`); _firstGwError = false; }
    throw new Error(`GW: ${d.error}`);
  }
  return d?.data?.txHash || "";
}

async function sendTxBatchRaw(txJsons: any[]): Promise<number> {
  // Send individually for better error tracking
  let ok = 0;
  for (const tx of txJsons) {
    try {
      await sendTxRaw(tx);
      ok++;
    } catch (e: any) {
      if (_firstGwError) { log("🚨", `TX send failed: ${e.message?.substring(0, 120)}`); _firstGwError = false; }
    }
  }
  return ok;
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
  drainNonce: number,
): Promise<number> {
  const signer = new UserSigner(UserSecretKey.fromString(config.wallet.privateKey));

  const data = buildDrainData(tokenId);
  const txJson = await signAndSerializeSC(
    signer,
    config.wallet.address,
    config.forwarderAddress,
    drainNonce,
    BigInt(0),
    BigInt(30_000_000), // 30M gas for drain
    GAS_PRICE_BASE,
    data,
  );

  try {
    const hash = await sendTxRaw(txJson);
    log("🔄", `Drain ${tokenId} from S${config.shard} forwarder: ${hash}`);
  } catch (e: any) {
    log("⚠️", `Drain error S${config.shard}: ${e.message?.substring(0, 80)}`);
  }
  return drainNonce + 1;
}

async function drainAllForwarders(): Promise<void> {
  log("🔄", "Waiting 10s for pending TXs to settle before draining...");
  await sleep(10000);
  log("🔄", "Draining all forwarders...");
  for (const f of FORWARDERS) {
    // Re-fetch FRESH nonce after all TXs are settled
    const { nonce } = await getAccountInfo(f.wallet.address);
    let currentNonce = nonce;
    // Drain both USDC and WEGLD sequentially with correct nonces
    currentNonce = await drainForwarder(f, USDC_TOKEN, currentNonce);
    await sleep(1000);
    currentNonce = await drainForwarder(f, WEGLD_TOKEN, currentNonce);
    await sleep(1000);
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
  startNonce?: number, // If provided (from pre-sign burst), skip getAccountInfo nonce
): Promise<{ sent: number; errors: number }> {
  const { wallet, forwarderAddress, shard, callTypes, workerId } = config;
  const signer = new UserSigner(UserSecretKey.fromString(wallet.privateKey));
  let sent = 0;
  let errors = 0;

  try {
  let nonce: number;
  let egldBal: bigint;
  if (startNonce !== undefined) {
    nonce = startNonce;
    const fresh = await getAccountInfo(wallet.address);
    egldBal = fresh.balance;
  } else {
    const fresh = await getAccountInfo(wallet.address);
    nonce = fresh.nonce;
    egldBal = fresh.balance;
  }
  let wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
  let usdcBal = await getTokenBalance(wallet.address, USDC_TOKEN);
  let batchCount = 0;
  let callTypeIdx = 0;
  const BATCH_SIZE = 10; // Increased from 5 → 10 for higher throughput
  const NONCE_RESYNC_INTERVAL = 10;

  // Bidirectional swap state: alternate forward (WEGLD→USDC) and reverse (USDC→WEGLD)
  // Only recycle on S1 same-shard with sync/asyncV1/asyncV2 (tokens auto-return)
  let swapForward = true; // true = WEGLD→USDC, false = USDC→WEGLD

  log("🔥", `W${workerId} S${shard}: ${callTypes.length} types → ${forwarderAddress.substring(0,20)}...`);
  log("💰", `  EGLD: ${(Number(egldBal) / 1e18).toFixed(4)} | WEGLD: ${(Number(wegldBal) / 1e18).toFixed(4)} | USDC: ${(Number(usdcBal) / 1e6).toFixed(4)}`);

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

    // Pick call type — round-robin
    const callType = callTypes[callTypeIdx % callTypes.length];
    callTypeIdx++;

    // Determine if this call type supports bidirectional recycling
    // Recycling works on S1 (same-shard) with blindSync/asyncV1/asyncV2
    // These types auto-return tokens to the caller on same-shard
    const canRecycle = shard === 1 && callType !== 'blindTransfExec';

    // Determine swap direction for this batch
    let useForward: boolean;
    if (canRecycle) {
      // Try reverse if we have USDC and want to recycle
      if (!swapForward && usdcBal >= USDC_SWAP_AMOUNT) {
        useForward = false;
      } else {
        // Forward: need WEGLD
        if (wegldBal < MIN_WEGLD_FOR_SWAP) {
          wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
          usdcBal = await getTokenBalance(wallet.address, USDC_TOKEN);
          if (wegldBal < MIN_WEGLD_FOR_SWAP && usdcBal >= USDC_SWAP_AMOUNT) {
            useForward = false; // No WEGLD but have USDC → force reverse
          } else if (wegldBal < MIN_WEGLD_FOR_SWAP) {
            log("🛑", `W${workerId} S${shard}: Out of WEGLD and USDC! Stopping.`);
            break;
          } else {
            useForward = true;
          }
        } else {
          useForward = true;
        }
      }
      swapForward = !swapForward; // Toggle for next batch
    } else {
      // Non-recyclable: always forward (WEGLD→USDC)
      useForward = true;
      if (wegldBal < MIN_WEGLD_FOR_SWAP) {
        wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
        if (wegldBal < MIN_WEGLD_FOR_SWAP) {
          log("🛑", `W${workerId} S${shard}: Out of WEGLD! Stopping.`);
          break;
        }
      }
    }

    // Periodic nonce re-sync
    if (batchCount > 0 && batchCount % NONCE_RESYNC_INTERVAL === 0) {
      const fresh = await getAccountInfo(wallet.address);
      nonce = fresh.nonce;
      egldBal = fresh.balance;
      wegldBal = await getTokenBalance(wallet.address, WEGLD_TOKEN);
      usdcBal = await getTokenBalance(wallet.address, USDC_TOKEN);
    }

    const gasPrice = getGasPrice();
    const batch: any[] = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      try {
        let data: string;
        if (useForward) {
          data = buildForwarderCallData(callType, SWAP_AMOUNT, MIN_OUT_AMOUNT);
        } else {
          data = buildReverseSwapData(callType, USDC_SWAP_AMOUNT, MIN_OUT_AMOUNT);
        }
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
        if (useForward) {
          wegldBal -= SWAP_AMOUNT;
          if (canRecycle) usdcBal += USDC_SWAP_AMOUNT; // Estimate USDC received
        } else {
          usdcBal -= USDC_SWAP_AMOUNT;
          wegldBal += SWAP_AMOUNT; // Estimate WEGLD received (slightly less due to fees)
        }
        egldBal -= GAS_LIMIT_SC * gasPrice;
      } catch (e: any) {
        errors++;
        totalErrors++;
      }
    }

    // Send batch via send-multiple API (1 HTTP call for all TXs = much faster)
    if (batch.length > 0) {
      try {
        const ok = await sendTxBatchRaw(batch);
        sent += ok;
        totalSent += ok;
        callTypeCounts[callType] = (callTypeCounts[callType] || 0) + ok;
        if (ok < batch.length) {
          // Partial success — some TXs rejected, resync nonce
          const fresh = await getAccountInfo(wallet.address);
          nonce = fresh.nonce;
          egldBal = fresh.balance;
        }
      } catch {
        errors += batch.length;
        totalErrors += batch.length;
        // Full batch failed — resync nonce
        try {
          const fresh = await getAccountInfo(wallet.address);
          nonce = fresh.nonce;
          egldBal = fresh.balance;
        } catch {}
        failoverEndpoint();
        await sleep(200);
      }
    }

    batchCount++;
    await sleep(10); // Reduced from 50ms → 10ms for higher throughput
  }

  } catch (e: any) {
    log("⚠️", `W${workerId} S${shard}: Worker crashed: ${e.message?.substring(0, 100)}. Sent ${sent} before crash.`);
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
  // S0/S2 forwarders NOT payable → blindTransfExec fails (USDC can't return)
  // Only blindAsyncV1 + blindAsyncV2 work cross-shard
  const CROSS_SHARD_TYPES = ["blindAsyncV1", "blindAsyncV2"];

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
    const types = s === 1 ? '4 types (incl. blindSync + blindTransfExec)' : '2 async types (V1+V2 only, no TransfExec)';
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

  // ═══════════════════════════════════════
  //  CALIBRATE USDC SWAP AMOUNT from DEX rate
  // ═══════════════════════════════════════
  USDC_SWAP_AMOUNT = await calibrateUsdcAmount();
  log("🔄", `BIDIRECTIONAL RECYCLING ENABLED — S1 workers will alternate WEGLD↔USDC`);
  log("🔄", `Forward: 0.001 WEGLD → USDC | Reverse: ${(Number(USDC_SWAP_AMOUNT)/1e6).toFixed(6)} USDC → WEGLD`);

  // ═══════════════════════════════════════
  //  PRE-SIGN BURST — Sign TXs BEFORE window opens!
  //  This gives us 600 TXs ready to blast at T=0
  // ═══════════════════════════════════════
  const PRE_SIGN_PER_WALLET = 10; // 10 TXs per wallet = 600 total burst
  const preSignedByWorker: Map<number, { txJsons: string[]; nextNonce: number; callType: string }> = new Map();

  const startMs = new Date(WINDOW_START).getTime();
  const timeToStart = startMs - Date.now();

  if (timeToStart > 15000) {
    // We have time — pre-sign now
    log("⚡", `PRE-SIGNING ${PRE_SIGN_PER_WALLET} TXs per wallet (${workerConfigs.length * PRE_SIGN_PER_WALLET} total)...`);

    for (const wc of workerConfigs) {
      try {
        const signer = new UserSigner(UserSecretKey.fromString(wc.wallet.privateKey));
        const { nonce } = await getAccountInfo(wc.wallet.address);
        const txJsons: string[] = [];
        let currentNonce = nonce;
        let preSignForward = true; // Alternate directions in pre-sign too

        for (let i = 0; i < PRE_SIGN_PER_WALLET; i++) {
          const callType = wc.callTypes[i % wc.callTypes.length];
          const canRecycle = wc.shard === 1 && callType !== 'blindTransfExec';
          
          let data: string;
          if (canRecycle && !preSignForward) {
            // Reverse swap for recyclable types — needs USDC from a prior forward swap
            // For pre-sign, only alternate after first forward swap
            data = buildReverseSwapData(callType, USDC_SWAP_AMOUNT, MIN_OUT_AMOUNT);
          } else {
            data = buildForwarderCallData(callType, SWAP_AMOUNT, MIN_OUT_AMOUNT);
          }
          if (canRecycle) preSignForward = !preSignForward;
          
          const txJson = await signAndSerializeSC(
            signer, wc.wallet.address, wc.forwarderAddress,
            currentNonce, BigInt(0), GAS_LIMIT_SC, GAS_PRICE_BASE, data,
          );
          txJsons.push(txJson);
          currentNonce++;
        }

        preSignedByWorker.set(wc.workerId, {
          txJsons,
          nextNonce: currentNonce,
          callType: wc.callTypes[0],
        });
      } catch (e: any) {
        log("⚠️", `Pre-sign failed W${wc.workerId}: ${e.message?.substring(0, 60)}`);
      }
    }

    log("⚡", `PRE-SIGNED ${preSignedByWorker.size} wallets × ${PRE_SIGN_PER_WALLET} = ${preSignedByWorker.size * PRE_SIGN_PER_WALLET} TXs ready!`);
  } else {
    log("⏭️", "Not enough time for pre-sign, will fire workers directly");
  }

  // Wait for window
  await waitUntil(WINDOW_START, "CHALLENGE 4 START");

  const windowEndMs = new Date(WINDOW_END).getTime();
  const windowStartMs = Date.now();

  // ═══════════════════════════════════════
  //  T=0: BURST — Fire all pre-signed TXs instantly!
  // ═══════════════════════════════════════
  if (preSignedByWorker.size > 0) {
    log("💥", `BURST FIRE: ${preSignedByWorker.size * PRE_SIGN_PER_WALLET} pre-signed TXs!`);

    const burstPromises: Promise<void>[] = [];
    for (const [workerId, data] of preSignedByWorker) {
      const wc = workerConfigs[workerId];
      burstPromises.push((async () => {
        for (const txJson of data.txJsons) {
          try {
            await sendTxRaw(txJson);
            totalSent++;
            // Count all pre-signed TXs evenly across call types
            const ctIdx = data.txJsons.indexOf(txJson) % wc.callTypes.length;
            const ct = wc.callTypes[ctIdx];
            callTypeCounts[ct] = (callTypeCounts[ct] || 0) + 1;
          } catch {
            totalErrors++;
          }
        }
      })());
    }
    await Promise.allSettled(burstPromises);
    log("💥", `BURST COMPLETE: ${totalSent} sent in ${((Date.now() - windowStartMs) / 1000).toFixed(1)}s!`);
  }

  // FIRE ALL WORKERS (with updated nonce from pre-sign)
  log("🔥", `FIRING ${workerConfigs.length} SUSTAINED WORKERS!`);

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

  const results = await Promise.allSettled(
    workerConfigs.map(wc => {
      const preSigned = preSignedByWorker.get(wc.workerId);
      const startNonce = preSigned ? preSigned.nextNonce : undefined;
      return walletWorker(wc, windowEndMs, windowStartMs, startNonce);
    })
  ).then(settled => settled.map(r => r.status === 'fulfilled' ? r.value : { sent: 0, errors: 1 }));

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

