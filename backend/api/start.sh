#!/bin/sh

echo "[Start] Starting API Core"

# 0. Ensure persistent data dir exists and is writable. AGENT_SECRETS_PATH +
# BRIDGE_STATE_DIR live under /data, which the compose file bind-mounts from
# ./data on the host. On platforms where the bind-mount silently fails to
# attach (Dokploy / Coolify / Railway when no Volume is declared in the UI,
# rootless podman, read-only root FS, etc.) the runtime would later crash
# with `ENOENT: open '/data/agent-secrets.json.tmp'` mid-write. Fail loud
# here instead so the operator knows exactly what to fix.
DATA_DIR="${AGENT_SECRETS_DIR:-/data}"
mkdir -p "$DATA_DIR" 2>/dev/null || true
if ! ( touch "$DATA_DIR/.write-test" && rm "$DATA_DIR/.write-test" ) 2>/dev/null; then
  echo "[Fatal] $DATA_DIR is not writable."
  echo "[Fatal] On Dokploy: open the service → 'Advanced' → 'Volumes/Mounts',"
  echo "[Fatal] add a Bind Mount with Host Path '../files/data' (or any host"
  echo "[Fatal] path you want to persist) and Container Path '/data'."
  echo "[Fatal] Then redeploy."
  exit 1
fi
echo "[Start] /data writable."


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
