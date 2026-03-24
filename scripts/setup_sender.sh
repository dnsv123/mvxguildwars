#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Sender Node Setup — Challenge 4
#  Run on: 16-32 GB RAM, 8 vCPU, Ubuntu 22.04
#  Usage: bash scripts/setup_sender.sh
# ═══════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  🔥 C4 Sender Setup — OpenHeart Guild"
echo "═══════════════════════════════════════════════════════════════"

# ─── Install Node.js 20 ───
if ! command -v node &> /dev/null; then
  echo "🔧 Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs git screen
fi
echo "✅ Node: $(node --version)"

# ─── Clone repo ───
cd /root
if [ ! -d "mvxguildwars" ]; then
  git clone https://github.com/dnsv123/mvxguildwars.git
fi
cd mvxguildwars && git pull

# ─── Install dependencies ───
echo "📦 Installing npm dependencies..."
npm install

# ─── Prompt for .env ───
if [ ! -f ".env" ]; then
  echo ""
  echo "⚙️ Creating .env file..."
  read -p "GL_PRIVATE_KEY: " GL_KEY
  read -p "OBSERVER_URL (e.g. http://OBSERVER_IP:8079): " OBS_URL
  read -p "KEPLER_API_KEY (leave empty if none): " KEP_KEY

  cat > .env << EOF
GL_PRIVATE_KEY=${GL_KEY}
OBSERVER_URL=${OBS_URL}
KEPLER_GATEWAY=https://bon-kepler-api.projectx.mx/gateway
KEPLER_API_KEY=${KEP_KEY}
EOF
  echo "✅ .env created"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Sender Ready!"
echo ""
echo "  Test:  npx ts-node scripts/c4_blaster.ts"
echo "  Run:   screen -S c4 bash -c 'npx ts-node scripts/c4_blaster.ts 2>&1 | tee run_c4.log'"
echo "═══════════════════════════════════════════════════════════════"
