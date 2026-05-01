#!/bin/sh

echo "[Start] Starting API Core"


# 1. Create local AXL config
# API connects to axl-seed as well
PEERS_JSON="[]"
if [ -n "$AXL_PEER" ]; then
  PEERS_JSON="[\"$AXL_PEER\"]"
fi

# Stable AXL peer identity comes from AXL_PRIVATE_KEY (baked into the
# image). When unset (e.g. dev runs without env), the field is omitted
# and AXL falls back to its own GenerateConfig() which mints a fresh
# random key on every boot — fine for one-off runs but wrecks routing
# tables across restarts.
if [ -n "$AXL_PRIVATE_KEY" ]; then
  PRIVATE_KEY_LINE="\"PrivateKey\": \"$AXL_PRIVATE_KEY\","
else
  PRIVATE_KEY_LINE=""
fi

cat <<EOF > node-config.json
{
  $PRIVATE_KEY_LINE
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
