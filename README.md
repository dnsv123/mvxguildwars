# ⚔️ MVX Guild Wars — Transaction Sprint

Scripts for Battle of Nodes Guild Wars Challenge 1: **Transaction Sprint**.

## 🏗️ Architecture

| Script | Purpose |
|--------|---------|
| `scripts/0_orchestrator.ts` | Full autopilot: distribute → Window A → Window B |
| `scripts/1_generate_wallets.ts` | Generate 500 unique sending wallets |
| `scripts/2_distribute_funds.ts` | GL Wallet → 500 wallets (5 EGLD each) |
| `scripts/3_fire_transactions.ts` | Spam MoveBalance from all 500 wallets (configurable) |
| `scripts/4_fire_windowB.ts` | Optimized Window B: higher concurrency + parallel signing |

## ⚡ Strategy

- **500 wallets** firing MoveBalance(value=0) transactions in parallel
- **Batched signing + bulk sending** via `sendTransactions()` endpoint
- **Semaphore-based concurrency** control to avoid gateway rate limits
- **Auto-nonce management**: fetch once, increment locally
- **Budget-capped**: 80,000 tx/wallet (Window A) · 20,000 tx/wallet (Window B)

## 🔧 Setup

```bash
npm install
# Generate wallets
npx ts-node scripts/1_generate_wallets.ts
# Set GL_PRIVATE_KEY in .env
# Run orchestrator
npx ts-node scripts/0_orchestrator.ts
```

## 📊 Key Numbers

| Metric | Value |
|--------|-------|
| Fee per tx | 0.00005 EGLD |
| Gas limit | 50,000 |
| Gas price | 1,000,000,000 |
| Window A budget | 2,000 EGLD |
| Window B budget | 500 EGLD |

## 🛡️ Security

Private keys, `.env`, and `wallets.json` are protected via `.gitignore` and never committed.

Built with [MultiversX SDK](https://github.com/multiversx) · TypeScript · Node.js
