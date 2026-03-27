#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  🚀 C5 AGENT ARENA — DEFINITIVE LAUNCH SCRIPT
#
#  Usage: bash scripts/c5_launch.sh erd1ADMIN erd1TARGET
#
#  This does EVERYTHING:
#  1. Generates FRESH wallets (deletes old ones)
#  2. Sets Admin + Target in .env
#  3. Funds 10 agents (50 EGLD each = 500 EGLD)
#  4. Registers all 10 agents via MX-8004
#  5. Sends 1 test TX per agent to verify chain delivery
#  6. Prints all verification links
#  7. Launches the autonomous agent bot
#
#  💚 OpenHeart Guild — Challenge 5
# ═══════════════════════════════════════════════════════════════

set -e

ADMIN="$1"
TARGET="$2"

if [ -z "$ADMIN" ] || [ -z "$TARGET" ]; then
  echo ""
  echo "█████████████████████████████████████████████████████████"
  echo "█  🚀 C5 AGENT ARENA — LAUNCH SCRIPT                    "
  echo "█████████████████████████████████████████████████████████"
  echo ""
  echo "  Usage:"
  echo "    bash scripts/c5_launch.sh erd1ADMIN_ADDR erd1TARGET_ADDR"
  echo ""
  echo "  Example:"
  echo "    bash scripts/c5_launch.sh erd1qr... erd1xy..."
  echo ""
  exit 1
fi

cd "$(dirname "$0")/.."

echo ""
echo "██████████████████████████████████████████████████████████████"
echo "█  🚀 C5 AGENT ARENA — LAUNCHING"
echo "█  Admin:  ${ADMIN:0:30}..."
echo "█  Target: ${TARGET:0:30}..."
echo "█  Time:   $(date '+%H:%M:%S UTC%z')"
echo "██████████████████████████████████████████████████████████████"
echo ""

# ═══ Step 1: Fresh wallets ═══
echo "[$(date +%H:%M:%S)] 🔑 Step 1/7: Generating FRESH wallets..."
rm -f c5_agents.json
npx ts-node --transpileOnly scripts/c5_setup.ts wallets
echo ""

# ═══ Step 2: Set addresses in .env ═══
echo "[$(date +%H:%M:%S)] ⚙️  Step 2/7: Setting addresses in .env..."
sed -i '/^C5_ADMIN_ADDR=/d' .env 2>/dev/null || true
sed -i '/^C5_TARGET_ADDR=/d' .env 2>/dev/null || true
echo "C5_ADMIN_ADDR=$ADMIN" >> .env
echo "C5_TARGET_ADDR=$TARGET" >> .env
echo "  ✅ C5_ADMIN_ADDR=$ADMIN"
echo "  ✅ C5_TARGET_ADDR=$TARGET"
echo ""

# ═══ Step 3: Fund agents (50 EGLD each) ═══
echo "[$(date +%H:%M:%S)] 💰 Step 3/7: Funding 10 agents (50 EGLD each = 500 EGLD)..."
npx ts-node --transpileOnly scripts/c5_setup.ts fund
echo ""

# ═══ Step 4: Wait + verify balances ═══
echo "[$(date +%H:%M:%S)] ⏳ Step 4/7: Waiting 15s for confirmations..."
sleep 15
echo "[$(date +%H:%M:%S)] 📊 Checking balances..."
npx ts-node --transpileOnly scripts/c5_setup.ts status
echo ""

# ═══ Step 5: Register via MX-8004 ═══
echo "[$(date +%H:%M:%S)] 📋 Step 5/7: Registering 10 agents via MX-8004..."
npx ts-node --transpileOnly scripts/c5_register.ts
echo ""

# ═══ Step 6: Test TX ═══
echo "[$(date +%H:%M:%S)] 🧪 Step 6/7: Testing 1 TX per agent on chain..."
npx ts-node --transpileOnly scripts/c5_setup.ts test-tx
echo ""

# ═══ Step 7: Verification summary ═══
echo ""
echo "██████████████████████████████████████████████████████████████"
echo "█  ✅ ALL SETUP COMPLETE"
echo "██████████████████████████████████████████████████████████████"
echo ""
echo "🔗 VERIFY YOUR AGENTS ON EXPLORER:"
cat c5_agents.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for w in d:
    print(f'  Agent {w[\"index\"]}: https://bon-explorer.multiversx.com/accounts/{w[\"address\"]}')
"
echo ""
echo "📊 LIVE LEADERBOARD:"
echo "  https://bon.multiversx.com/guild-wars"
echo ""
echo "🖥️  DASHBOARD:"
echo "  http://164.90.166.81:3333/c5-dashboard.html"
echo "  → Enter ADMIN and TARGET addresses, click ▶ START"
echo ""
echo "🤖 ADMIN wallet (monitor):"
echo "  https://bon-explorer.multiversx.com/accounts/$ADMIN"
echo ""
echo "🎯 TARGET wallet:"
echo "  https://bon-explorer.multiversx.com/accounts/$TARGET"
echo ""
echo "██████████████████████████████████████████████████████████████"
echo "█  🤖 LAUNCHING AUTONOMOUS AGENT BOT..."
echo "█  Bot will monitor admin wallet and react automatically"
echo "█  Press Ctrl+C to stop"
echo "██████████████████████████████████████████████████████████████"
echo ""

# Start bot
npx ts-node --transpileOnly scripts/c5_agent.ts
