#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  MultiversX Observer Node Setup for Battle of Nodes
#  Run on: 32+ GB RAM, 8+ vCPU, Ubuntu 22.04
#  Usage: bash scripts/setup_observer.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  🔭 MultiversX Observer Node Setup — Battle of Nodes"
echo "═══════════════════════════════════════════════════════════════"

# ─── System Updates ───
echo "📦 Installing dependencies..."
apt update -y
apt install -y build-essential git wget curl jq screen

# ─── Install Go 1.21 ───
if ! command -v go &> /dev/null; then
  echo "🔧 Installing Go 1.21.6..."
  wget -q https://go.dev/dl/go1.21.6.linux-amd64.tar.gz
  tar -C /usr/local -xzf go1.21.6.linux-amd64.tar.gz
  rm go1.21.6.linux-amd64.tar.gz
  echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
  export PATH=$PATH:/usr/local/go/bin
fi
echo "✅ Go: $(go version)"

# ─── Install Node.js 20 (for sender) ───
if ! command -v node &> /dev/null; then
  echo "🔧 Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
echo "✅ Node: $(node --version)"

# ─── Clone mx-chain-scripts (official observer setup) ───
echo "📥 Cloning mx-chain-scripts..."
cd /root
if [ ! -d "mx-chain-scripts" ]; then
  git clone https://github.com/multiversx/mx-chain-scripts.git
fi
cd mx-chain-scripts

# ─── Configure for BoN ───
echo "⚙️ Configuring for Battle of Nodes..."
cat > config/variables.cfg << 'EOF'
ENVIRONMENT="mainnet"
CUSTOM_HOME="/root"
CUSTOM_USER="root"
NODE_EXTRA_FLAGS="-log-save"
EOF

# Note: BoN might use a different config. Check BoN docs for:
# - Genesis file
# - Seed nodes
# - Chain ID
# Update variables.cfg if BoN requires different ENVIRONMENT

# ─── Install Observer Squad ───
echo "🔭 Installing Observing Squad (4 observers + proxy)..."
echo "This may take 10-15 minutes..."
./script.sh observing_squad

# ─── Start observers ───
echo "🚀 Starting observers..."
./script.sh start

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Observer Squad Installed!"
echo "  Proxy endpoint: http://localhost:8079"
echo "  Check status: curl localhost:8079/network/status | jq"
echo ""
echo "  ⏳ Observers need time to sync."
echo "  Monitor: curl localhost:8079/network/status | jq '.data.status.erd_current_round'"
echo "═══════════════════════════════════════════════════════════════"
