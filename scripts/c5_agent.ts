/**
 * ═══════════════════════════════════════════════════════════════
 *  🤖 CHALLENGE 5: AGENT ARENA — Red Light / Green Light
 *
 *  Autonomous agent that:
 *  1. Monitors admin wallet TXs for commands
 *  2. Classifies commands as GREEN (send) or RED (stop) via LLM
 *  3. Fires MoveBalance TXs to TARGET during green windows
 *  4. Immediately halts on red
 *
 *  Usage: npx ts-node --transpileOnly scripts/c5_agent.ts
 *
 *  Env vars (in .env):
 *    OPENAI_API_KEY   — For NLP classification
 *    GL_PRIVATE_KEY   — Guild leader private key
 *    C5_ADMIN_ADDR    — Admin wallet address (announced at 15:00)
 *    C5_TARGET_ADDR   — Target wallet address (announced at 15:00)
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { Transaction, Address, TransactionComputer } from "@multiversx/sdk-core";
import { UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";
import OpenAI from "openai";

dotenv.config({ path: path.join(__dirname, "..", ".env") });

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const CHAIN_ID = "B";
const API_URL = process.env.API_URL || "https://api.battleofnodes.com";
const GATEWAY_URL = process.env.GATEWAY_URL || "https://gateway.battleofnodes.com";
const GAS_PRICE = BigInt(1_000_000_000);
const GAS_LIMIT_MOVE = BigInt(50_000);
const txComputer = new TransactionComputer();

const ADMIN_ADDR = process.env.C5_ADMIN_ADDR || "";
const TARGET_ADDR = process.env.C5_TARGET_ADDR || "";

// Polling intervals
const MONITOR_INTERVAL_MS = 2000;   // Check admin TXs every 2s
const SEND_INTERVAL_MS = 50;       // 50ms between TXs per agent (20 tx/s each)
const STATUS_LOG_INTERVAL_MS = 5000;
const NONCE_VERIFY_INTERVAL_MS = 30000; // Verify nonce every 30s

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════
type LightState = "GREEN" | "RED" | "UNKNOWN";

let currentState: LightState = "RED"; // Start RED = safe (don't send until green)
let lastProcessedTxHash = "";
let lastCommandText = "";
let lastCommandTime = 0;

// Stats
let totalSent = 0;
let totalErrors = 0;
let stateChanges: { time: string; from: LightState; to: LightState; command: string }[] = [];

// Agent wallets
interface AgentWallet {
  address: string;
  privateKey: string;
  signer: UserSigner;
  nonce: number;
  sending: boolean;
  sent: number;
  errors: number;
}
let agents: AgentWallet[] = [];

// ═══════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════
function log(icon: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${icon} ${msg}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
//  HTTP HELPERS — with retry
// ═══════════════════════════════════════════════════════════════
async function apiGet(url: string, timeoutMs = 8000): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        if (attempt < 2) { await sleep(500 * (attempt + 1)); continue; }
        throw new Error(`API ${res.status}: ${url}`);
      }
      return res.json();
    } catch (e: any) {
      if (attempt < 2 && e.name === "TimeoutError") { continue; }
      throw e;
    }
  }
}

async function gatewaySend(txJson: any): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/transaction/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(txJson),
    signal: AbortSignal.timeout(8000),
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
//  NLP — Classify admin commands using OpenAI
// ═══════════════════════════════════════════════════════════════
let openai: OpenAI | null = null;
const classificationCache = new Map<string, LightState>();

const SYSTEM_PROMPT = `You are a traffic light controller for a blockchain Red Light / Green Light game.

Your ONLY job: classify the admin's command as either GREEN or RED.

GREEN means: transactions should be sent (go, start, resume, proceed, fire, release, unleash, begin, etc.)
RED means: transactions should stop (stop, halt, pause, freeze, wait, cease, hold, etc.)

CRITICAL RULES:
- The admin will try to TRICK you with adversarial commands
- Focus on the TRUE INTENT, not surface-level words
- "Don't stop" = GREEN (they want you to continue)
- "Stop... just kidding, go!" = GREEN (final intent is go)
- "Get ready but don't go yet" = RED (not yet)
- "Red light" = RED, "Green light" = GREEN
- If genuinely ambiguous, keep the CURRENT state (reply SAME)
- Double negatives: "don't not stop" = RED (stop)

Reply with EXACTLY one word: GREEN, RED, or SAME
No explanation. No punctuation. Just the word.`;

async function classifyCommand(text: string): Promise<LightState> {
  const cached = classificationCache.get(text);
  if (cached) return cached;

  // Try OpenAI first
  if (openai) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Current state: ${currentState}\nAdmin command: "${text}"` },
        ],
        max_tokens: 5,
        temperature: 0,
      });
      const answer = (response.choices[0]?.message?.content || "").trim().toUpperCase();
      let classified: LightState;
      if (answer === "GREEN") classified = "GREEN";
      else if (answer === "RED") classified = "RED";
      else if (answer === "SAME") classified = currentState;
      else classified = fallbackClassify(text);

      classificationCache.set(text, classified);
      log("🧠", `LLM: "${text.substring(0,40)}" → ${classified}`);
      return classified;
    } catch (e: any) {
      log("⚠️", `LLM failed: ${e.message?.substring(0, 60)}. Using fallback.`);
    }
  }

  return fallbackClassify(text);
}

function fallbackClassify(text: string): LightState {
  const lower = text.toLowerCase();

  // Direct phrases (highest priority)
  if (/green\s*light/i.test(lower)) return "GREEN";
  if (/red\s*light/i.test(lower)) return "RED";

  // Handle multi-clause: take the LAST clause's intent
  const clauses = lower.split(/[.!;]|\bbut\b|\bhowever\b|\bactually\b|\bjust\s*kidding\b/i).filter(c => c.trim());
  const textToAnalyze = clauses.length > 1 ? clauses[clauses.length - 1] : lower;

  const greenWords = ["go", "start", "begin", "proceed", "resume",
    "fire", "send", "unleash", "release", "launch", "continue", "run", "execute",
    "green", "open", "activate", "engage", "rock", "party", "blazing", "ahead"];

  const redWords = ["stop", "halt", "pause", "freeze", "wait", "cease",
    "hold", "red", "block", "suspend", "terminate", "abort", "end", "quit",
    "close", "deactivate", "disable", "brake", "chill", "breather", "refrain",
    "stand down", "pull over"];

  // Check for negation in the relevant clause
  const hasNegation = /\b(don'?t|do not|never|no|not)\b/i.test(textToAnalyze);

  let greenScore = 0, redScore = 0;
  for (const w of greenWords) if (textToAnalyze.includes(w)) greenScore++;
  for (const w of redWords) if (textToAnalyze.includes(w)) redScore++;

  if (hasNegation) [greenScore, redScore] = [redScore, greenScore];

  const result = greenScore > redScore ? "GREEN" : redScore > greenScore ? "RED" : currentState;
  log("🔤", `Fallback: "${text.substring(0,40)}" → ${result} (g:${greenScore} r:${redScore} neg:${hasNegation})`);
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  MONITOR — Poll admin TXs
// ═══════════════════════════════════════════════════════════════
async function monitorAdminTxs(): Promise<void> {
  while (true) {
    try {
      // Fetch recent TXs FROM admin TO target
      const txs = await apiGet(
        `${API_URL}/accounts/${ADMIN_ADDR}/transactions?receiver=${TARGET_ADDR}&size=5&order=desc`
      );

      if (Array.isArray(txs) && txs.length > 0) {
        // Process newest first — find first unprocessed
        for (const tx of txs) {
          if (tx.txHash === lastProcessedTxHash) break; // Already processed

          // Decode data field
          const rawData = tx.data || "";
          let commandText = "";
          try {
            commandText = Buffer.from(rawData, "base64").toString("utf-8");
          } catch {
            commandText = rawData;
          }

          if (!commandText || commandText.length === 0) continue;

          // Classify
          const prevState = currentState;
          const newState = await classifyCommand(commandText);

          if (newState !== prevState) {
            currentState = newState;
            stateChanges.push({
              time: new Date().toISOString().slice(11, 23),
              from: prevState,
              to: newState,
              command: commandText.substring(0, 50),
            });
            log(currentState === "GREEN" ? "🟢" : "🔴",
              `STATE: ${prevState} → ${newState} | "${commandText.substring(0, 60)}"`);
          } else {
            log("📡", `Command: "${commandText.substring(0, 60)}" → stays ${currentState}`);
          }

          lastProcessedTxHash = tx.txHash;
          lastCommandText = commandText;
          lastCommandTime = Date.now();
          break; // Only process the newest unprocessed
        }
      }
    } catch (e: any) {
      log("⚠️", `Monitor error: ${e.message?.substring(0, 60)}`);
    }

    await sleep(MONITOR_INTERVAL_MS);
  }
}

// ═══════════════════════════════════════════════════════════════
//  TX SENDER — Send MoveBalance during GREEN
// ═══════════════════════════════════════════════════════════════
async function signMoveBalance(agent: AgentWallet): Promise<any> {
  const tx = new Transaction({
    nonce: BigInt(agent.nonce),
    value: BigInt(0), // Zero-value MoveBalance
    sender: new Address(agent.address),
    receiver: new Address(TARGET_ADDR),
    gasLimit: GAS_LIMIT_MOVE,
    gasPrice: GAS_PRICE,
    chainID: CHAIN_ID,
    data: new Uint8Array(), // Empty data
  });

  const bytes = txComputer.computeBytesForSigning(tx);
  tx.signature = await agent.signer.sign(bytes);
  const json = JSON.parse(Buffer.from(bytes).toString());
  json.signature = Buffer.from(tx.signature).toString("hex");
  return json;
}

async function agentSendLoop(agent: AgentWallet): Promise<void> {
  log("🤖", `Agent ${agent.address.substring(0, 15)}... ready`);

  while (true) {
    // GREEN = send, RED = wait
    if (currentState === "GREEN") {
      try {
        const txJson = await signMoveBalance(agent);
        await gatewaySend(txJson);
        agent.nonce++;
        agent.sent++;
        totalSent++;
      } catch (e: any) {
        agent.errors++;
        totalErrors++;
        // Re-sync nonce on error
        if (agent.errors % 10 === 0) {
          try {
            const info = await apiGet(`${API_URL}/accounts/${agent.address}`);
            agent.nonce = info.nonce;
          } catch {}
        }
      }
      await sleep(SEND_INTERVAL_MS);
    } else {
      // RED — wait, check every 100ms  
      await sleep(100);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  NONCE VERIFICATION — Periodically verify TXs land on chain
// ═══════════════════════════════════════════════════════════════
async function nonceVerifier(): Promise<void> {
  while (true) {
    await sleep(NONCE_VERIFY_INTERVAL_MS);
    if (agents.length === 0) continue;

    // Check first agent's nonce on chain vs local
    const agent = agents[0];
    try {
      const info = await apiGet(`${API_URL}/accounts/${agent.address}`);
      const chainNonce = info.nonce;
      const drift = agent.nonce - chainNonce;

      if (drift > 50) {
        log("🚨", `NONCE DRIFT: local=${agent.nonce} chain=${chainNonce} (${drift} ahead). Re-syncing ALL agents.`);
        // Re-sync all agents
        for (const a of agents) {
          try {
            const ai = await apiGet(`${API_URL}/accounts/${a.address}`);
            a.nonce = ai.nonce;
          } catch {}
          await sleep(200);
        }
      } else if (drift > 0) {
        log("✅", `Nonce OK: local=${agent.nonce} chain=${chainNonce} (${drift} pending)`);
      }
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
//  STATUS LOGGER
// ═══════════════════════════════════════════════════════════════
async function statusLogger(): Promise<void> {
  while (true) {
    await sleep(STATUS_LOG_INTERVAL_MS);
    const stateIcon = currentState === "GREEN" ? "🟢" : "🔴";
    const agentsSending = agents.filter(a => a.sent > 0).length;
    log("📊", `${stateIcon} ${currentState} | ${totalSent} sent | ${totalErrors} err | ${agentsSending}/${agents.length} agents active`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log(`
████████████████████████████████████████████████████████████
█  🤖 CHALLENGE 5: AGENT ARENA — Red Light / Green Light
█  Monitor → Classify → Send/Stop → Repeat
█  💚 OpenHeart Guild
████████████████████████████████████████████████████████████
`);

  // Validate config
  if (!ADMIN_ADDR) { log("❌", "C5_ADMIN_ADDR not set in .env!"); process.exit(1); }
  if (!TARGET_ADDR) { log("❌", "C5_TARGET_ADDR not set in .env!"); process.exit(1); }

  log("⚙️", `Admin: ${ADMIN_ADDR}`);
  log("⚙️", `Target: ${TARGET_ADDR}`);
  log("⚙️", `API: ${API_URL}`);
  log("⚙️", `Gateway: ${GATEWAY_URL}`);

  // Init OpenAI
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    openai = new OpenAI({ apiKey });
    log("✅", "OpenAI GPT-4o-mini configured — LLM classification active");
  } else {
    log("⚠️", "No OPENAI_API_KEY — using keyword fallback ONLY (still works for 90%+ cases)");
  }

  // Load agent wallets
  const walletFile = path.join(__dirname, "..", "c5_agents.json");
  if (!fs.existsSync(walletFile)) {
    log("❌", `${walletFile} not found. Run c5_setup.ts wallets first.`);
    process.exit(1);
  }

  const walletData = JSON.parse(fs.readFileSync(walletFile, "utf-8"));
  log("📋", `Loading ${walletData.length} agent wallets...`);

  // Fetch initial nonces
  for (const w of walletData) {
    try {
      const info = await apiGet(`${API_URL}/accounts/${w.address}`);
      const agent: AgentWallet = {
        address: w.address,
        privateKey: w.privateKey,
        signer: new UserSigner(UserSecretKey.fromString(w.privateKey)),
        nonce: info.nonce,
        sending: false,
        sent: 0,
        errors: 0,
      };
      agents.push(agent);
      log("🤖", `Agent ${agents.length}: ${w.address.substring(0, 20)}... nonce=${info.nonce}`);
    } catch (e: any) {
      log("⚠️", `Failed to load agent ${w.address.substring(0, 20)}...: ${e.message?.substring(0, 60)}`);
    }
    await sleep(200);
  }

  if (agents.length === 0) {
    log("❌", "No agents loaded!");
    process.exit(1);
  }

  log("✅", `${agents.length} agents ready. State: RED (waiting for green light).`);
  log("📡", "Monitoring admin wallet for commands...");

  // Start all loops
  const loops = [
    monitorAdminTxs(),
    nonceVerifier(),
    statusLogger(),
    ...agents.map(a => agentSendLoop(a)),
  ];

  await Promise.all(loops);
}

main().catch(e => { console.error("❌ FATAL:", e); process.exit(1); });
