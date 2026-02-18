#!/usr/bin/env bash
# Runs on first boot of each AgentBox instance (triggered by cloud-init).
# Generates a fresh EVM wallet, configures the OpenClaw gateway, and
# calls back to the AgentBox API with instance credentials.
#
# The backend's Hetzner provisioning code passes cloud-init user_data that
# writes /etc/agentbox/callback.env and then runs this script.
set -euo pipefail

LOG="/var/log/agentbox-init.log"
exec > >(tee -a "$LOG") 2>&1

echo "[$(date -Iseconds)] AgentBox init starting"

# --- Load callback config (written by cloud-init user_data) ---

CALLBACK_ENV="/etc/agentbox/callback.env"
if [[ ! -f "$CALLBACK_ENV" ]]; then
  echo "ERROR: $CALLBACK_ENV not found - cloud-init user_data may be missing"
  exit 1
fi
# shellcheck source=/dev/null
source "$CALLBACK_ENV"
# Expected vars: CALLBACK_URL, CALLBACK_SECRET, SERVER_ID, INSTANCE_HOSTNAME

# --- Generate fresh EVM wallet ---
#
# We pre-generate BEFORE starting the gateway so we know the address immediately
# for the API callback. ClawRouter also auto-generates on first start if none
# exists, but that would require waiting for the full boot cycle.
#
# Wallet format: raw hex private key "0x" + 64 hex chars, written to the path
# ClawRouter checks on every start. If this file exists, the BLOCKRUN_WALLET_KEY
# env var is completely ignored.
# See: https://github.com/BlockRunAI/ClawRouter (src/auth.ts)

echo "Generating EVM wallet..."
WALLET_DIR="/home/openclaw/.openclaw/blockrun"
mkdir -p "$WALLET_DIR"

WALLET_JSON=$(cd /usr/local/lib/agentbox && node --input-type=module <<'NODEOF'
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const key = generatePrivateKey();
const account = privateKeyToAccount(key);
console.log(JSON.stringify({ privateKey: key, address: account.address }));
NODEOF
)
WALLET_KEY=$(echo "$WALLET_JSON" | jq -r '.privateKey')
WALLET_ADDRESS=$(echo "$WALLET_JSON" | jq -r '.address')

echo -n "$WALLET_KEY" > "$WALLET_DIR/wallet.key"
chmod 600 "$WALLET_DIR/wallet.key"
chown -R openclaw:openclaw "$WALLET_DIR"
echo "Wallet address: $WALLET_ADDRESS"

# --- Generate gateway auth token ---

GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Gateway token generated"

# --- Write gateway token to OpenClaw config ---
#
# FIX: We write the token to BOTH the systemd unit AND openclaw.json to prevent
# the "device token mismatch" issue. When these diverge, the gateway starts fine
# but ALL CLI commands and agent tool calls fail silently.
# See: https://github.com/openclaw/openclaw/issues/17223
# See: https://github.com/openclaw/openclaw/issues/19409
# See: https://github.com/openclaw/openclaw/issues/19954

OPENCLAW_CONFIG="/home/openclaw/.openclaw/openclaw.json"
if [[ -f "$OPENCLAW_CONFIG" ]]; then
  jq --arg token "$GATEWAY_TOKEN" '.gateway.auth.token = $token' \
    "$OPENCLAW_CONFIG" > "${OPENCLAW_CONFIG}.tmp"
  mv "${OPENCLAW_CONFIG}.tmp" "$OPENCLAW_CONFIG"
  chown openclaw:openclaw "$OPENCLAW_CONFIG"
fi

# --- Enable silent device pairing ---
#
# When the OpenClaw dashboard connects, it sends a pairing request.
# Silent mode + auto-approve ensures users don't hit a "pairing pending" screen.


PENDING_DIR="/home/openclaw/.openclaw/devices"
mkdir -p "$PENDING_DIR"
echo '{"silent":true}' > "$PENDING_DIR/pending.json"
chown -R openclaw:openclaw "$PENDING_DIR"

# --- Create and start systemd service ---
#
# We use a system-level service instead of OpenClaw's user-level service to avoid
# XDG_RUNTIME_DIR and linger issues on headless VMs.
# See: https://github.com/openclaw/openclaw/issues/11805
#
# KillMode=process prevents child processes (Docker sandboxes) from blocking
# systemd shutdown. Matches OpenClaw's own unit template.
#
# OPENCLAW_GATEWAY_PORT env var is set because gateway.port config is IGNORED
# at runtime - only the env var or CLI flag takes effect.
# See: https://github.com/openclaw/openclaw/issues/7626

OPENCLAW_BIN=$(which openclaw)

cat > /etc/systemd/system/openclaw-gateway.service << EOF
[Unit]
Description=OpenClaw Gateway (AgentBox)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw
ExecStart=${OPENCLAW_BIN} gateway run --port 18789 --bind loopback --token ${GATEWAY_TOKEN} --allow-unconfigured
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=/home/openclaw
Environment=OPENCLAW_GATEWAY_PORT=18789
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable openclaw-gateway
systemctl start openclaw-gateway

# --- Auto-approve device pairing ---
#
# OpenClaw dashboard (openclaw-control-ui) sends a pairing request on first connect.
# This service auto-approves it so the user sees the chat immediately.
# Auto-approves operator/openclaw-control-ui pairing requests.

cat > /usr/local/bin/agentbox-auto-pair.sh << 'AUTOPAIREOF'
#!/usr/bin/env bash
set -euo pipefail
PENDING="/home/openclaw/.openclaw/devices/pending.json"
OPENCLAW_BIN=$(which openclaw)

while true; do
  if [[ -f "$PENDING" ]]; then
    REQUESTS=$(jq -r 'to_entries[] | select(.value.role == "operator" and .value.clientId == "openclaw-control-ui") | .key' "$PENDING" 2>/dev/null || true)
    for req_id in $REQUESTS; do
      echo "[$(date -Iseconds)] Auto-approving pairing request: $req_id"
      su - openclaw -c "$OPENCLAW_BIN device approve $req_id" 2>/dev/null || true
    done
  fi
  sleep 2
done
AUTOPAIREOF
chmod +x /usr/local/bin/agentbox-auto-pair.sh

cat > /etc/systemd/system/agentbox-auto-pair.service << 'APEOF'
[Unit]
Description=AgentBox auto-pair approver
After=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
Type=simple
ExecStart=/usr/local/bin/agentbox-auto-pair.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
APEOF

systemctl daemon-reload
systemctl enable agentbox-auto-pair
systemctl start agentbox-auto-pair

# --- Wait for gateway to become healthy ---
#
# FIX: The OpenClaw gateway has NO plain HTTP /health endpoint - it's WebSocket
# RPC requiring auth. We check ClawRouter's proxy at :8402 instead, which has a
# proper HTTP health endpoint returning {"status":"ok","wallet":"0x..."}.

echo "Waiting for gateway and ClawRouter..."
HEALTHY=false
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8402/health > /dev/null 2>&1; then
    echo "ClawRouter proxy healthy on :8402"
    HEALTHY=true
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "WARNING: health check timed out after 60s"
  fi
  sleep 2
done

if [[ "$HEALTHY" == "true" ]]; then
  curl -sf "http://127.0.0.1:8402/health?full=true" || true
fi

# --- ttyd web terminal ---

echo "Starting ttyd service..."
cat > /etc/systemd/system/ttyd.service << 'TTYDEOF'
[Unit]
Description=ttyd web terminal (AgentBox)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
ExecStart=/usr/local/bin/ttyd -p 7681 -i lo -W bash
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
TTYDEOF

systemctl daemon-reload
systemctl enable ttyd
systemctl start ttyd

# --- Caddy reverse proxy ---
#
# Caddy provides HTTPS via Let's Encrypt (HTTP-01 challenge) and routes:
#   /            -> OpenClaw gateway (localhost:18789) - gateway handles its own auth
#   /terminal/*  -> ttyd (localhost:7681)

if [[ -n "${INSTANCE_HOSTNAME:-}" ]]; then
  echo "Configuring Caddy for ${INSTANCE_HOSTNAME}..."

  cat > /etc/caddy/Caddyfile << CADDYEOF
${INSTANCE_HOSTNAME} {
    handle_path /terminal/* {
        reverse_proxy localhost:7681
    }
    redir /terminal /terminal/
    handle {
        reverse_proxy localhost:18789
    }
}
CADDYEOF

  systemctl enable caddy
  systemctl start caddy
  echo "Caddy started for ${INSTANCE_HOSTNAME}"
else
  echo "WARNING: INSTANCE_HOSTNAME not set, skipping Caddy setup"
fi

# --- Callback to API ---

echo "Calling back to API..."
PAYLOAD=$(jq -n \
  --argjson serverId "$SERVER_ID" \
  --arg walletAddress "$WALLET_ADDRESS" \
  --arg gatewayToken "$GATEWAY_TOKEN" \
  --arg secret "$CALLBACK_SECRET" \
  '{serverId: $serverId, walletAddress: $walletAddress, gatewayToken: $gatewayToken, secret: $secret}')

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$CALLBACK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD") || HTTP_CODE="failed"

echo "Callback response: $HTTP_CODE"
if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
  echo "WARNING: callback returned $HTTP_CODE (retrying in 30s)"
  sleep 30
  curl -sf -X POST "$CALLBACK_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" || echo "ERROR: callback retry also failed"
fi

echo "[$(date -Iseconds)] AgentBox init complete"
