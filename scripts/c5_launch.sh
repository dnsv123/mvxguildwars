#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  🚀 C5 AGENT ARENA — ONE-CLICK LAUNCHER
#
#  Usage: bash scripts/c5_launch.sh ADMIN_ADDR TARGET_ADDR
#
#  This script:
#  1. Sets Admin + Target addresses in .env
#  2. Funds all 10 agent wallets (50 EGLD each)
#  3. Waits for confirmations
#  4. Registers all agents via MX-8004
#  5. Tests one TX per agent
#  6. Launches the autonomous agent bot
#
#  💚 OpenHeart Guild
# ═══════════════════════════════════════════════════════════════

set -e

ADMIN="$1"
TARGET="$2"

if [ -z "$ADMIN" ] || [ -z "$TARGET" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  🚀 C5 AGENT ARENA — ONE-CLICK LAUNCHER"
  echo "═══════════════════════════════════════════════════"
  echo ""
  echo "  Usage: bash scripts/c5_launch.sh ADMIN_ADDR TARGET_ADDR"
  echo ""
  echo "  Example:"
  echo "  bash scripts/c5_launch.sh erd1admin... erd1target..."
  echo ""
  exit 1
fi

echo ""
echo "████████████████████████████████████████████████████████████"
echo "█  🚀 C5 AGENT ARENA — LAUNCHING                        "
echo "█  Admin: ${ADMIN:0:25}..."
echo "█  Target: ${TARGET:0:25}..."
echo "████████████████████████████████████████████████████████████"
echo ""

cd "$(dirname "$0")/.."

# ═══ Step 1: Set addresses in .env ═══
echo "[$(date +%H:%M:%S)] ⚙️  Setting addresses in .env..."

# Remove old entries if they exist
sed -i '/^C5_ADMIN_ADDR=/d' .env 2>/dev/null || true
sed -i '/^C5_TARGET_ADDR=/d' .env 2>/dev/null || true

# Add new entries
echo "C5_ADMIN_ADDR=$ADMIN" >> .env
echo "C5_TARGET_ADDR=$TARGET" >> .env
echo "[$(date +%H:%M:%S)] ✅ .env updated"

# ═══ Step 2: Fund agents ═══
echo ""
echo "[$(date +%H:%M:%S)] 💰 Step 2/5: Funding 10 agents (50 EGLD each)..."
npx ts-node --transpileOnly scripts/c5_setup.ts fund

# ═══ Step 3: Wait and check balances ═══
echo ""
echo "[$(date +%H:%M:%S)] ⏳ Waiting 15s for confirmations..."
sleep 15
echo "[$(date +%H:%M:%S)] 📊 Step 3/5: Checking agent balances..."
npx ts-node --transpileOnly scripts/c5_setup.ts status

# ═══ Step 4: Register via MX-8004 ═══
echo ""
echo "[$(date +%H:%M:%S)] 📋 Step 4/5: Registering agents via MX-8004..."
npx ts-node --transpileOnly scripts/c5_register.ts

# ═══ Step 5: Test TX ═══
echo ""
echo "[$(date +%H:%M:%S)] 🧪 Step 5/5: Testing 1 TX per agent..."
npx ts-node --transpileOnly scripts/c5_setup.ts test-tx

# ═══ Launch agent bot ═══
echo ""
echo "████████████████████████████████████████████████████████████"
echo "█  ✅ ALL SETUP COMPLETE — LAUNCHING AGENT BOT"
echo "█  Agent will monitor admin wallet and react automatically"
echo "█  Press Ctrl+C to stop"
echo "████████████████████████████████████████████████████████████"
echo ""

npx ts-node --transpileOnly scripts/c5_agent.ts
