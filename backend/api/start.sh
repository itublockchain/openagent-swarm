#!/bin/sh

echo "[Start] Starting API Core"

# 1. Create local AXL config
# API connects to axl-seed as well
PEERS_JSON="[]"
if [ -n "$AXL_PEER" ]; then
  PEERS_JSON="[\"$AXL_PEER\"]"
fi

cat <<EOF > node-config.json
{
  "Peers": $PEERS_JSON,
  "Listen": ["tcp://0.0.0.0:7000"],
  "bridge_addr": "0.0.0.0"
}
EOF

# 2. Start AXL node in background
echo "[Start] Starting local AXL node..."
./axl-node -config node-config.json > axl.log 2>&1 &

# 3. Wait for AXL to be ready
echo "[Start] Waiting for AXL bridge..."
MAX_RETRIES=30
COUNT=0
while ! wget -qO- http://127.0.0.1:9002/topology > /dev/null 2>&1; do
  sleep 1
  COUNT=$((COUNT+1))
  if [ $COUNT -ge $MAX_RETRIES ]; then
    echo "[Error] AXL node failed to start"
    cat axl.log
    exit 1
  fi
done
echo "[Start] AXL bridge ready."

# 4. Start API application
echo "[Start] Starting Node.js API application..."
exec node backend/api/src/index.js
