/**
 * ═══════════════════════════════════════════════════════════════
 *  🔧 C5 REGISTER — Register 10 agents via MX-8004 protocol
 *
 *  Calls register_agent on the Identity Registry SC for each agent.
 *  Registry: erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p
 *
 *  Usage: npx ts-node --transpileOnly scripts/c5_register.ts
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { 
  Transaction, Address, TransactionComputer, 
} from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const CHAIN_ID = "B";
const API_URL = process.env.API_URL || "https://api.battleofnodes.com";
const GATEWAY_URL = process.env.GATEWAY_URL || "https://gateway.battleofnodes.com";
const GAS_PRICE = BigInt(1_000_000_000);
const txComputer = new TransactionComputer();

const REGISTRY_SC = "erd1qqqqqqqqqqqqqpgq4mar8ex8aj2gnc0cq7ay372eqfd5g7t33frqcg776p";
const AGENTS_FILE = path.join(__dirname, "..", "c5_agents.json");

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

function toHex(str: string): string {
  return Buffer.from(str).toString("hex");
}

/**
 * Build register_agent SC call manually as data field:
 * register_agent@name@uri@publicKey@metadataCount@...@servicesCount@...
 * 
 * For minimal registration we send:
 * - name (hex)
 * - uri (hex) — can be empty placeholder
 * - publicKey (hex) — the agent's public key
 * - 0 metadata entries (count = 0)
 * - 0 service configs (count = 0)
 */
function buildRegisterData(agentName: string, agentAddress: string): string {
  const nameHex = toHex(agentName);
  const uriHex = toHex(`https://agent.openheart.guild/${agentName}`);
  
  // Public key = address hex (without erd1 prefix, raw 32 bytes)
  const addr = new Address(agentAddress);
  const pubKeyHex = Buffer.from(addr.getPublicKey()).toString("hex");
  
  // No metadata (count = 0), no services (count = 0)
  const metadataCount = "00000000"; // u32 = 0
  const servicesCount = "00000000"; // u32 = 0
  
  return `register_agent@${nameHex}@${uriHex}@${pubKeyHex}@${metadataCount}@${servicesCount}`;
}

async function main() {
  console.log(`
══════════════════════════════════════════════════
  🔧 C5 REGISTER — MX-8004 Agent Registration
══════════════════════════════════════════════════
`);

  if (!fs.existsSync(AGENTS_FILE)) {
    log("❌", "c5_agents.json not found! Run c5_setup.ts wallets first.");
    return;
  }

  const wallets = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf-8"));
  log("📋", `Registering ${wallets.length} agents...`);
  log("📝", `Registry SC: ${REGISTRY_SC}`);

  let success = 0;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const signer = new UserSigner(UserSecretKey.fromString(w.privateKey));
    const agentName = `OpenHeart-Agent-${i}`;

    try {
      // Get current nonce
      const info = await apiGet(`${API_URL}/accounts/${w.address}`);
      const bal = Number(BigInt(info.balance || "0")) / 1e18;
      
      if (bal < 0.01) {
        log("⚠️", `Agent ${i}: balance too low (${bal.toFixed(4)} EGLD). Fund first!`);
        continue;
      }

      // Build registration TX
      const dataStr = buildRegisterData(agentName, w.address);
      
      const tx = new Transaction({
        nonce: BigInt(info.nonce),
        value: BigInt(0),
        sender: new Address(w.address),
        receiver: new Address(REGISTRY_SC),
        gasLimit: BigInt(30_000_000), // 30M gas for SC call
        gasPrice: GAS_PRICE,
        chainID: CHAIN_ID,
        data: new TextEncoder().encode(dataStr),
      });

      const bytes = txComputer.computeBytesForSigning(tx);
      tx.signature = await signer.sign(bytes);
      
      // Get JSON from TX (proper serialization)
      const txObj = tx.toPlainObject();
      
      // Send via gateway
      const res = await fetch(`${GATEWAY_URL}/transaction/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(txObj),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GW ${res.status}: ${body.substring(0, 100)}`);
      }

      const d: any = await res.json();
      if (d.error && d.error !== "") throw new Error(`GW: ${d.error}`);
      
      const txHash = d?.data?.txHash || "";
      log("✅", `Agent ${i} (${agentName}) registered! TX: ${txHash.substring(0, 20)}...`);
      log("🔗", `Explorer: https://bon-explorer.multiversx.com/transactions/${txHash}`);
      success++;
    } catch (e: any) {
      log("❌", `Agent ${i} registration FAILED: ${e.message?.substring(0, 80)}`);
    }

    await sleep(1000); // Wait between registrations
  }

  log("📊", `Registration complete: ${success}/${wallets.length} agents registered`);
  
  if (success < wallets.length) {
    log("⚠️", "Some registrations failed. Check agent balances and retry.");
  }

  // Verify registrations
  log("⏳", "Waiting 10s then verifying...");
  await sleep(10000);
  
  log("🔍", "Checking Agent Marketplace...");
  try {
    const count = await apiGet(`${API_URL}/accounts/${REGISTRY_SC}/transactions?size=20&order=desc`);
    log("📊", `Recent registry transactions: ${Array.isArray(count) ? count.length : 'N/A'}`);
  } catch {}
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
