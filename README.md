# 🔥 OpenHeart Guild — Challenge 4: Contract Storm

> **Battle of Nodes — Guild Wars** | March 26, 2026  
> Smart Contract Composability — Forwarder → DEX Swap Blaster

## 🎯 Challenge Objective

Maximize **smart contract calls** through forwarder-blind contracts that forward DEX swaps (WEGLD/USDC) via 4 composability methods. Tests same-shard and cross-shard contract interactions.

| Parameter | Value |
|-----------|-------|
| Window | 16:00–17:00 UTC (60 minutes) |
| DEX Pair | WEGLD/USDC on Shard 1 |
| Call Types | blindSync, blindAsyncV1, blindAsyncV2, blindTransfExec |
| Network | Post-Supernova, 600ms blocks |

## 🏗️ Infrastructure

### Server
- **Droplet:** `openheart-guild` (DigitalOcean 32GB/8CPU, Frankfurt)
- **Observer Squad:** 4 nodes (Shard 0/1/2 + Meta) — v2.0.2.1-bon (Supernova)
- **Proxy:** localhost:8079

### Wallets (3 — one per shard)

| Shard | Address | Role | Call Type |
|-------|---------|------|-----------|
| 0 | `erd1m6cyl2zql2gvhhjw4r99dktc2j23pl4rlvq5r8938dwz2swp50wqvg075l` | Cross-shard caller | blindAsyncV1 |
| 1 | `erd1ypr6sdu2q6sxzlrtdtsxyw3lk4mrznkzfmt4w29ht3l4c0vs8t3srm97lf` | Same-shard caller ⚡ | blindSync |
| 2 | `erd1a5348kn5j37nn9ea697cnws098q3qv0g8dlq6kkfmc5l6h9ur0eqs2uqfg` | Cross-shard caller | blindAsyncV1 |

### Forwarder Contracts (deployed)

| Shard | Contract | Type |
|-------|----------|------|
| 0 | `erd1qqqqqqqqqqqqqpgqxdh3zsjktd3qpa9jnn72me83j77v6k7t50wqrtn6zl` | Cross-shard |
| 1 | `erd1qqqqqqqqqqqqqpgqejv0jxdpuyw4fl0ps73k98pd6h8w4d868t3st9tn3q` | Same-shard ⚡ |
| 2 | `erd1qqqqqqqqqqqqqpgqpskjkdvyceattq5vkgq6yy73khud43xur0eqhd2ha6` | Cross-shard |

## 📁 Project Structure

```
scripts/
├── c4_contract_storm.ts    # Main blaster (ESDT swaps via forwarder)
├── c4_setup.ts             # Setup: wallets, fund, wrap, test, status
├── 8_crossover_orchestrator.ts  # (C3 — legacy)
c4_wallets.json             # Shard-specific wallet configs
c4_forwarders.json          # Forwarder contract configs
c4-dashboard.html           # Live monitoring dashboard
```

## 🚀 Setup & Usage

```bash
# 1. Generate wallets
npx ts-node --transpileOnly scripts/c4_setup.ts wallets

# 2. Fund wallets (15 EGLD each)
OBSERVER_URL="" KEPLER_GATEWAY="" npx ts-node --transpileOnly scripts/c4_setup.ts fund

# 3. Wrap EGLD → WEGLD
OBSERVER_URL="" KEPLER_GATEWAY="" npx ts-node --transpileOnly scripts/c4_setup.ts wrap

# 4. Check status
OBSERVER_URL="" KEPLER_GATEWAY="" npx ts-node --transpileOnly scripts/c4_setup.ts status

# 5. Test call types
OBSERVER_URL="" KEPLER_GATEWAY="" npx ts-node --transpileOnly scripts/c4_setup.ts test-call

# 6. Run blaster (during challenge window)
OBSERVER_URL="" KEPLER_GATEWAY="" npx ts-node --transpileOnly scripts/c4_contract_storm.ts
```

## 📊 Live Dashboard

```bash
python3 -m http.server 8080
# Access: http://164.90.166.81:8080/c4-dashboard.html
```

## 💚 OpenHeart Guild

*Contract composability mastery. Forward smarter. Swap faster.*

**Redemption time — let's go!** 🔥

---

*Built with ❤️ by OpenHeart Guild — Powered by SuperVictor*
