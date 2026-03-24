# 💚 OpenHeart Guild — Challenge 3: Crossover

> **Battle of Nodes — Guild Wars** | March 24, 2026  
> Cross-Shard MoveBalance Orchestrator with 2-Tier Burst Gas Strategy

## 🎯 Challenge Objective

Maximize **cross-shard MoveBalance transactions** across two timed windows. Only transactions where sender and receiver are on **different shards** count toward scoring.

| Part | Window | Budget | Min Value | Wallets |
|------|--------|--------|-----------|---------|
| Part 1 | 16:00–16:30 UTC | 2,000 EGLD | 1×10⁻¹⁸ EGLD | 500 fresh |
| Part 2 | 17:00–17:30 UTC | 500 EGLD | 0.01 EGLD | 500 fresh |

## ⚡ Architecture

### Cross-Shard Routing
Our orchestrator distributes 500 wallets across all 3 shards and routes transactions in a triangle pattern — ensuring **100% cross-shard compliance**:

```
    Shard 0
   ╱       ╲
  ↙ S2→S0    ↘ S0→S1
Shard 2 ——→ Shard 1
      S1→S2
```

Shard assignment uses the **official MultiversX algorithm**:
```typescript
const lastByte = Buffer.from(bech32Address).at(-1)!;
const shard = (lastByte & 3) < 3 ? (lastByte & 3) : (lastByte & 1);
```

### 2-Tier Burst Gas Strategy

Instead of a flat gas price, we use a **2-tier approach**:

| Phase | Gas Multiplier | Purpose |
|-------|---------------|---------|
| **Pre-signed burst** | 8x | 250K tx hit mempool at window start with maximum priority |
| **Inline sustained** | 3x | Continuous fire above typical competition (1-2x) |

**Why this works:** The first 500 tx/wallet are pre-signed offline at 8x gas before the window opens. When `16:00:00 UTC` hits, they blast into the mempool instantly — dominating block inclusion. After the pre-signed queue depletes, inline signing continues at 3x, maintaining above-average priority while maximizing total transaction count.

**Budget safety:** 500 tx × 0.0004 (8x fee) + 24,500 tx × 0.00015 (3x fee) = 3.875 EGLD per wallet (of 4 EGLD budget). ✅

### 3 Parallel Shard Workers

Each shard runs an independent async worker:
- **Worker 0:** Shard 0 → Shard 1
- **Worker 1:** Shard 1 → Shard 2
- **Worker 2:** Shard 2 → Shard 0

All 3 fire simultaneously via `Promise.all()`, maximizing throughput across the network.

## 🏗️ Technical Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js v20 + TypeScript |
| SDK | `@multiversx/sdk-core` |
| Gateway | Kepler Private Gateway (authenticated API key) |
| Infrastructure | DigitalOcean Droplet, Frankfurt (FRA1) |
| Block Heartbeat | 650ms cycle (aligned with 600ms block time) |
| Batch Size | 500 tx/wallet/cycle |
| Retry Logic | 3 attempts per batch, 200ms backoff |
| Checkpointing | `checkpoint.json` + `run.log` every 5s (crash-safe) |

## 📁 Project Structure

```
scripts/
├── 8_crossover_orchestrator.ts   # Main orchestrator (Challenge 3)
├── 9_test_crossover.ts           # Cross-shard verification test
├── 10_kepler_swap.ts             # Kepler gateway test
├── 1_generate_wallets.ts         # Wallet generation utility
├── 2_distribute_funds.ts         # Fund distribution utility
└── helper_extract_key.ts         # Key extraction helper
```

## 🚀 Execution Flow

```
15:45 UTC  →  Generate 500 Part 1 wallets
           →  Distribute 2,000 EGLD (4 EGLD × 500 wallets)
           →  Pre-sign 500 tx/wallet at 8x gas (250K tx ready)
16:00 UTC  →  💥 BLAST! Pre-signed burst hits mempool
           →  ⚡ Inline fire at 3x gas continues
16:30 UTC  →  Part 1 ends
           →  Generate 500 Part 2 wallets (fresh set)
           →  Distribute 500 EGLD (1 EGLD × 500 wallets)
17:00 UTC  →  💥 Part 2 burst + sustained fire
17:30 UTC  →  ✅ Challenge complete
```

## 🛡️ Safety Features

- **Budget caps** — Mathematically impossible to exceed 2,000/500 EGLD limits
- **Direct funding** — GL → wallet (no intermediaries, compliant with rules)
- **GL wallet clean** — Only distributes funds, never sends MoveBalance
- **Fresh wallets** — Random mnemonic generation for each part
- **Checkpoint logging** — Progress saved every 5 seconds to survive crashes
- **Retry logic** — 3 attempts per batch with exponential backoff

## 📊 Live Monitoring

- **Dashboard:** `challenge3-live.html` — Real-time telemetry with shard visualization, speedometers, and TX throughput chart
- **Leaderboard:** [bon.multiversx.com/guild-wars](https://bon.multiversx.com/guild-wars)
- **Explorer:** [bon-explorer.multiversx.com](https://bon-explorer.multiversx.com)

## 🏃 How to Run

```bash
# Clone and install
git clone https://github.com/dnsv123/mvxguildwars.git
cd mvxguildwars && npm install

# Configure .env
echo "GL_PRIVATE_KEY=your_key_here" > .env
echo "KEPLER_GATEWAY=https://bon-kepler-api.projectx.mx/gateway" >> .env
echo "KEPLER_API_KEY=your_api_key" >> .env

# Run orchestrator
npx ts-node scripts/8_crossover_orchestrator.ts
```

## 💚 OpenHeart Guild

*Cross-shard mastery. Route smarter. Score more.*

**Never give up — keep pushing!** 🔥

---

*Built with ❤️ by OpenHeart Guild — Powered by SuperVictor*
