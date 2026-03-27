# ⚔️ Agent Arena — OpenHeart Guild

> **Challenge 5: Red Light / Green Light** — Battle of Nodes Guild Wars 2026
>
> Deploy autonomous agents that monitor on-chain natural-language commands and react in real time.

## 🏗️ Architecture

```
┌─────────────────┐    TX with text    ┌──────────────┐
│   ADMIN wallet   │ ───────────────→  │ TARGET wallet │
└─────────────────┘                    └──────┬───────┘
                                              │
                              ┌───────────────┤ monitor
                              │               │
                    ┌─────────▼─────────┐     │
                    │  NLP Classifier    │     │
                    │  GPT-4o-mini +     │     │
                    │  Keyword Fallback  │     │
                    └─────────┬─────────┘     │
                              │               │
                    ┌─────────▼─────────┐     │
                    │   GREEN → FIRE!    │─────┘
                    │   RED → STOP!      │  MoveBalance TXs
                    └───────────────────┘
                         10 Agents
```

## ⚡ Key Features

- **NLP Classification**: GPT-4o-mini with adversarial-resistant keyword fallback (32/32 test cases)
- **10 Autonomous Agents**: Each with its own wallet, nonce tracking, and TX pipeline
- **Instant State Switching**: ~100ms reaction time on state change
- **MX-8004 Registration**: Automated agent registration on Identity Registry SC
- **Live Dashboard**: Real-time battlefield visualization with pixel tanks, projectiles, and Smarugon boss target
- **One-Click Deployment**: Single command launches everything

## 📁 Project Structure

```
scripts/
├── c5_agent.ts        # Main autonomous agent bot
├── c5_setup.ts        # Wallet generation, funding, status, cleanup
├── c5_register.ts     # MX-8004 agent registration
├── c5_launch.sh       # One-click launcher (does everything)
├── c5_test_nlp.ts     # NLP adversarial test suite (32 cases)
├── c5_test_live.ts    # Live blockchain pipeline test
└── c5_simulate.sh     # Full end-to-end simulation

c5-dashboard.html      # Live battlefield dashboard
c5_agents.json         # Generated agent wallets (gitignored)
```

## 🧠 NLP Strategy

### Primary: GPT-4o-mini
- System prompt engineered for adversarial command classification
- Handles negation ("Don't stop" → GREEN), multi-clause ("Stop... just kidding, go!" → GREEN)
- Temperature 0 for deterministic output
- Response: exactly one word — `GREEN`, `RED`, or `SAME`

### Fallback: Hardened Keyword Classifier
- Activated on API timeout/error
- Multi-clause parsing (splits on "but", "however", "actually", "just kidding")
- Negation detection with score inversion
- 32/32 accuracy on adversarial test suite

## 🚀 Deployment

### Prerequisites
- Node.js 18+
- Server with MultiversX observer node (optional, uses public gateway)
- OpenAI API key with credits

### Launch (at 15:00 UTC on challenge day)
```bash
cd /root/mvxguildwars && git pull
bash scripts/c5_launch.sh erd1ADMIN_ADDRESS erd1TARGET_ADDRESS
```

This single command:
1. 🔑 Generates 10 fresh agent wallets
2. ⚙️ Configures Admin + Target addresses
3. 💰 Funds each agent with 50 EGLD from GL wallet
4. 📋 Registers all agents via MX-8004
5. 🧪 Sends test TX per agent (verification)
6. 🔗 Prints explorer links for all agents
7. 🤖 Launches autonomous bot

### Dashboard
Open `http://YOUR_SERVER:3333/c5-dashboard.html`, enter Admin + Target addresses, click ▶ START.

## 📊 Verified Results

| Component | Result |
|---|---|
| Funding GL → Agents | ✅ 10/10 |
| MoveBalance TXs | ✅ 10/10 confirmed on chain |
| NLP Classification | ✅ 32/32 adversarial cases |
| MX-8004 Registration | ✅ TX success on chain |
| Auto-sweep cleanup | ✅ 10/10 |

## 🛡️ Scoring Strategy

- **Score** = `PermittedTXs − UnpermittedTXs`
- Start in RED (safe — no TXs until confirmed GREEN)
- Instant kill switch on RED detection
- Nonce verification every 30s to prevent drift
- Zero-value MoveBalance (50k gas = 0.00005 EGLD per TX)

## 🔧 Tech Stack

- **Runtime**: Node.js + TypeScript (ts-node)
- **NLP**: OpenAI GPT-4o-mini
- **Blockchain SDK**: @multiversx/sdk-core, @multiversx/sdk-wallet
- **Network**: Battle of Nodes shadow fork (Chain ID: B, 600ms blocks)
- **Gateway**: gateway.battleofnodes.com
- **API**: api.battleofnodes.com

## 💚 OpenHeart Guild

Built for [Battle of Nodes Guild Wars](https://bon.multiversx.com/guild-wars) — Challenge 5: Agent Arena.
