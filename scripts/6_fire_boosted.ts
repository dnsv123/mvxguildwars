/**
 * 🚀 BOOSTED — 5x gasPrice for transaction priority in last 10 min
 * Same sliding-window nonce logic, higher priority in mempool.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

const GATEWAY_URL         = "https://gateway.battleofnodes.com";
const TX_VALUE            = BigInt(0);
const GAS_LIMIT           = BigInt(50_000);
const GAS_PRICE           = BigInt(5_000_000_000);   // ⬆️ 5x standard = PRIORITY
const MAX_NONCE_AHEAD     = 95;
const MAX_TX_PER_WALLET   = 20_000;
const DURATION_MINUTES    = 11;        // 10 min + 1 buffer
const STATS_INTERVAL_MS   = 5_000;
const NONCE_POLL_MS       = 1_500;     // faster polling
const SEND_CONCURRENCY    = 100;

interface WalletEntry { address: string; privateKey: string; }

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];
  constructor(p: number) { this.permits = p; }
  async acquire() {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise<void>(r => this.queue.push(r));
  }
  release() {
    if (this.queue.length > 0) this.queue.shift()!();
    else this.permits++;
  }
}

let totalSent = 0;
let totalErrors = 0;
let endTime = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fireWallet(
  wallet: WalletEntry,
  provider: ProxyNetworkProvider,
  chainID: string,
  sendSem: Semaphore,
): Promise<number> {
  const secretKey = UserSecretKey.fromString(wallet.privateKey);
  const signer = new UserSigner(secretKey);
  const senderAddress = new Address(wallet.address);
  const iAddr = { bech32: () => wallet.address };
  const txComputer = new TransactionComputer();

  let sent = 0;
  let nextNonce: number;
  let onChainNonce: number;

  try {
    const acc = await provider.getAccount(iAddr);
    onChainNonce = acc.nonce;
    nextNonce = onChainNonce;
  } catch { return 0; }

  while (sent < MAX_TX_PER_WALLET && Date.now() < endTime) {
    const canSend = Math.max(0, (onChainNonce + MAX_NONCE_AHEAD) - nextNonce);
    
    if (canSend === 0) {
      await sleep(NONCE_POLL_MS);
      try {
        const acc = await provider.getAccount(iAddr);
        onChainNonce = acc.nonce;
      } catch {}
      continue;
    }

    const batchSize = Math.min(canSend, MAX_TX_PER_WALLET - sent);
    const txs: Transaction[] = [];
    
    for (let i = 0; i < batchSize; i++) {
      const tx = new Transaction({
        nonce: BigInt(nextNonce + i),
        value: TX_VALUE,
        sender: senderAddress,
        receiver: senderAddress,
        gasLimit: GAS_LIMIT,
        gasPrice: GAS_PRICE,  // 5x PRIORITY
        chainID: chainID,
        data: new Uint8Array(),
      });
      tx.signature = await signer.sign(txComputer.computeBytesForSigning(tx));
      txs.push(tx);
    }

    await sendSem.acquire();
    try {
      await provider.sendTransactions(txs);
      sent += batchSize;
      nextNonce += batchSize;
      totalSent += batchSize;
    } catch {
      totalErrors++;
      nextNonce += batchSize;
    } finally {
      sendSem.release();
    }

    try {
      const acc = await provider.getAccount(iAddr);
      onChainNonce = acc.nonce;
    } catch {}
  }
  return sent;
}

function fmt(s: number): string {
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

async function main() {
  console.log("\n" + "█".repeat(60));
  console.log("█  ⚡ BOOSTED MODE — 5x GAS PRICE = PRIORITY TXNS");
  console.log("█  Fee: 0.00025 EGLD/tx (5x normal). Sliding window.");
  console.log("█".repeat(60) + "\n");

  const wallets: WalletEntry[] = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "wallets.json"), "utf-8")
  );

  const httpsAgent = new https.Agent({ maxSockets: 400, keepAlive: true });
  const provider = new ProxyNetworkProvider(GATEWAY_URL, { httpsAgent, timeout: 30_000 } as any);

  const networkConfig = await provider.getNetworkConfig();
  const chainID = networkConfig.ChainID;
  console.log(`🌐 Chain: ${chainID} | Wallets: ${wallets.length} | GasPrice: 5x PRIORITY`);

  console.log(`\n🚀 BOOSTED FIRE — NOW!\n`);

  const startTime = Date.now();
  endTime = startTime + DURATION_MINUTES * 60 * 1000;

  const statsTimer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const txps = Math.round(totalSent / elapsed);
    const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    const fees = (totalSent * 0.00025).toFixed(4);
    console.log(
      `⚡ [${fmt(elapsed)}] ${totalSent.toLocaleString()} tx | ${txps.toLocaleString()} tx/s | Fees: ${fees} EGLD | Err: ${totalErrors} | ${remaining}s left`
    );
  }, STATS_INTERVAL_MS);

  const sendSem = new Semaphore(SEND_CONCURRENCY);
  const results = await Promise.all(wallets.map(w => fireWallet(w, provider, chainID, sendSem)));

  clearInterval(statsTimer);
  const total = results.reduce((s, r) => s + r, 0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "█".repeat(60));
  console.log(`   Transactions: ${total.toLocaleString()}`);
  console.log(`   Fees (5x): ${(total * 0.00025).toFixed(4)} EGLD`);
  console.log("█".repeat(60));

  httpsAgent.destroy();
  process.exit(0);
}

main().catch(err => { console.error("❌", err); process.exit(1); });
