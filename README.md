# 🔥 OpenHeart Guild — Challenge 4: Contract Storm

> **Battle of Nodes — Guild Wars** | March 26, 2026  
> Smart Contract Composability — Forwarder → DEX Swap Blaster  
> 💚 *OpenHeart Guild — Forward Smarter. Swap Faster.* 💚

---

## 🎯 Challenge Objective

Maximize **successful smart contract calls** through forwarder-blind contracts that forward DEX swaps (WEGLD/USDC) via **4 distinct composability mechanisms**. This challenge tests both same-shard and cross-shard contract interactions on MultiversX's post-Supernova network with 600ms block times.

| Parameter | Value |
|-----------|-------|
| **Window** | 16:00–17:00 UTC, March 26, 2026 (60 minutes) |
| **DEX Pair** | WEGLD/USDC on Shard 1 |
| **Call Types** | `blindSync`, `blindAsyncV1`, `blindAsyncV2`, `blindTransfExec` |
| **Min per type** | 300 successful calls |
| **Budget** | 500 EGLD (gas + swap amounts) |
| **Max wallets** | 100 per guild |

---

## 🏗️ Infrastructure

### Server
| Component | Details |
|-----------|---------|
| **Droplet** | `openheart-guild` — DigitalOcean 32GB RAM / 8 CPU, Frankfurt |
| **Observer Squad** | 4 nodes (Shard 0, 1, 2 + Meta) — v2.0.2.1-bon Supernova |
| **Local Proxy** | `localhost:8079` |
| **Gateway Failover** | Observer → Kepler → Public GW (automatic rotation) |

### 60-Wallet Fleet

| Shard | Wallets | Call Types | Role |
|-------|---------|------------|------|
| 0 | 15 | `blindAsyncV1`, `blindAsyncV2` | Cross-shard async |
| 1 | 30 | All 4 types (incl. `blindSync` + `blindTransfExec`) | Same-shard + all types |
| 2 | 15 | `blindAsyncV1`, `blindAsyncV2` | Cross-shard async |

### Forwarder Contracts

| Shard | Contract | Interaction |
|-------|----------|-------------|
| 0 | `erd1qqq...rtn6zl` | 🔴 Cross-shard → DEX on S1 |
| 1 | `erd1qqq...8t3st` | 🟢 Same-shard (DEX lives here) |
| 2 | `erd1qqq...d2ha6` | 🔴 Cross-shard → DEX on S1 |

---

## 📁 Project Structure

```
scripts/
├── c4_launch.ts            # 🚀 ONE-COMMAND automated launcher
├── c4_contract_storm.ts    # 🔥 Main blaster (pre-sign, burst, sustained, drain)
├── c4_setup.ts             # 🔧 Setup: wallets, fund, wrap, status
├── c4_recover.ts           # 💰 Recover EGLD from old challenge wallets
c4_wallets.json             # 60-wallet fleet configs
c4_forwarders.json          # Forwarder contract configs
c4-dashboard.html           # 📊 Live "spaceship cockpit" monitoring dashboard
checkpoint.json             # Auto-saved every 5s during blast
OpenMem.md                  # 🧠 Agent memory (local only, not on GitHub)
```

---

## 🚀 Quick Start

### One-Command Launch (Challenge Day)
```bash
cd /root/mvxguildwars && git pull
C4_START="2026-03-26T16:00:00Z" C4_END="2026-03-26T17:00:00Z" \
  npx ts-node --transpileOnly scripts/c4_launch.ts
```

This runs the **full automated pipeline**:
1. **Phase 0** — Observer & gateway health check
2. **Phase 1** — Restore 60-wallet fleet
3. **Phase 2** — Fund all wallets from GL (if EGLD < 3)
4. **Phase 3** — Wrap EGLD → WEGLD (if WEGLD < 1)
5. **Phase 4** — Status check
6. **Phase 5** — Launch blaster (pre-sign burst → sustained fire → drain)

### Manual Steps
```bash
# Generate 60 wallets
npx ts-node --transpileOnly scripts/c4_setup.ts wallets

# Fund wallets (optional budget cap)
FUND_BUDGET=100 npx ts-node --transpileOnly scripts/c4_setup.ts fund

# Wrap EGLD → WEGLD
npx ts-node --transpileOnly scripts/c4_setup.ts wrap

# Check status
npx ts-node --transpileOnly scripts/c4_setup.ts status

# Run blaster (custom window)
C4_START="..." C4_END="..." npx ts-node --transpileOnly scripts/c4_contract_storm.ts

# Recover EGLD from old wallets
npx ts-node --transpileOnly scripts/c4_recover.ts
```

---

## 🔥 Blaster Architecture

### Pre-Sign Burst Strategy
- **600 TXs** pre-signed before window opens (10 per wallet × 60 wallets)
- Fired at T=0 in ~1.1 seconds
- Hits 2,500 milestone in ~6 seconds

### Sustained Fire
- 60 parallel workers cycling call types round-robin
- Batch size: 5 TXs
- Nonce resync: every 10 batches + immediate on error
- 3-endpoint gateway failover with automatic rotation

### Error Handling
- Nonce conflicts: auto-resync on every error
- Gateway timeout: failover to next endpoint
- Worker crash: isolated — other workers continue
- Gas exhaustion: worker stops gracefully

---

## 📊 Test Results (March 25)

### Supreme Test — 100 EGLD, 3 minutes
```
════════════════════════════════════════
 Shard 0: 17,711 sent (15 workers)
 Shard 1: 36,427 sent (30 workers)
 Shard 2: 17,697 sent (15 workers)

 blindSync:        9,266 ✅
 blindAsyncV1:    27,131 ✅
 blindAsyncV2:    26,953 ✅
 blindTransfExec:  9,085 ✅

 TOTAL: 72,435 tx in 180s (401 tx/s)
 Error rate: 2.1%
════════════════════════════════════════
```

### Projection — 500 EGLD, 60 minutes
| Metric | Value |
|--------|-------|
| EGLD per wallet | ~8.33 |
| WEGLD per wallet | ~6.83 |
| Swaps per wallet | ~6,830 |
| Total possible | ~410,000 |
| Sustained TPS | 400+ |

---

## 📊 Live Dashboard

```bash
python3 -m http.server 8080
# Access: http://164.90.166.81:8080/c4-dashboard.html
```

Features:
- Real-time shard status (EGLD/WEGLD/USDC per shard)
- 4 call type progress bars with live counts
- Milestone bonus tracker (2,500 calls)
- WEGLD spent, USDC earned, gas used
- Links to explorer, live scores, API docs

---

## 💚 OpenHeart Guild

*Contract composability mastery. Forward smarter. Swap faster.*

**Let's show them what 60 wallets can do!** 🔥

---

*Built with ❤️ by OpenHeart Guild — Powered by SuperVictor & Antigravity AI*
