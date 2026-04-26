#!/bin/sh

# 1. Generate unique AGENT_ID if not set
if [ -z "$AGENT_ID" ]; then
  RAND_ID=$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 4 | head -n 1)
  export AGENT_ID="agent-$RAND_ID"
fi

echo "[Start] Starting Agent: $AGENT_ID"

# 2. Create local AXL config
# Every agent peers with the seed AND the API core
PEERS_JSON="[\"tcp://axl-seed:7000\", \"tcp://api:7000\"]"
if [ -n "$AXL_PEER" ]; then
  PEERS_JSON="[\"$AXL_PEER\", \"tcp://api:7000\"]"
fi

cat <<EOF > node-config.json
{
  "Peers": $PEERS_JSON,
  "Listen": ["tcp://0.0.0.0:7000"],
  "bridge_addr": "0.0.0.0"
}
EOF

# 3. Start AXL node in background
echo "[Start] Starting local AXL node..."
./axl-node -config node-config.json > axl.log 2>&1 &

# 4. Wait for AXL to be ready (poll /topology)
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

# 5. Start Agent application
echo "[Start] Starting Node.js Agent application..."
exec node backend/agent/src/index.js
