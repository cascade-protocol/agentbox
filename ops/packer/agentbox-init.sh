#!/usr/bin/env bash
# Runs on first boot of each AgentBox instance (triggered by cloud-init).
# Uses preloaded OpenClaw, creates Solana/SATI identity on devnet, configures
# the gateway, and calls back to the AgentBox API with instance credentials.
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

# --- Verify preloaded OpenClaw ---
#
# OpenClaw is installed globally via npm in the golden image.
# Boot-time updates run in the background via `npm i -g openclaw@latest`.

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw binary not found (expected npm global install)"
  exit 1
fi
echo "Using preloaded OpenClaw $(openclaw --version)"

# --- OpenClaw onboarding ---
#
# Runs as the openclaw user so config writes to /home/openclaw/.openclaw/
# We avoid --install-daemon: it creates a user-level systemd service that
# breaks on headless VMs (XDG_RUNTIME_DIR, linger issues) and has a
# token-mismatch footgun when config rotates but the unit file does not.
# See: https://github.com/openclaw/openclaw/issues/11805
# See: https://github.com/openclaw/openclaw/issues/17223
#
# NOTE: The flag is --non-interactive, NOT --headless.

echo "Running OpenClaw onboarding..."
su - openclaw -c "openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice skip \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --skip-channels \
  --skip-skills \
  --skip-health"

# --- Create Solana wallet + SATI identity (devnet) ---
#
# We create the Solana keypair and publish agent identity on first boot.
# This replaces prior ClawRouter/EVM wallet provisioning.

echo "Creating Solana wallet and SATI agent identity..."
IDENTITY_DIR="/home/openclaw/agent-identity"
mkdir -p "$IDENTITY_DIR"
chown -R openclaw:openclaw "$IDENTITY_DIR"

su - openclaw -c "cd $IDENTITY_DIR && create-sati-agent init --force"

# Fill template with runtime values so publish is non-interactive and deterministic.
# Keep services empty for now - we'll define runtime endpoints/skills later.
SHORT_NAME=$(echo "${INSTANCE_HOSTNAME:-instance}" | cut -d. -f1 | head -c 32)
su - openclaw -c "cd $IDENTITY_DIR && jq --arg name \"$SHORT_NAME\" '
  .name = \$name |
  .description = \"OpenClaw instance provisioned by AgentBox\" |
  .image = \"https://api.dicebear.com/9.x/bottts/svg?seed=agentbox\" |
  .services = [] |
  .supportedTrust = [\"reputation\"] |
  .active = false |
  .x402Support = false
' agent-registration.json > agent-registration.json.tmp && mv agent-registration.json.tmp agent-registration.json"

PUBLISH_JSON=$(su - openclaw -c "cd $IDENTITY_DIR && create-sati-agent publish --network devnet --json")
AGENT_ID=$(echo "$PUBLISH_JSON" | jq -r '.agentId // empty')
SOLANA_WALLET_ADDRESS=$(su - openclaw -c "solana address")

echo "Solana wallet: $SOLANA_WALLET_ADDRESS"
echo "SATI agent id: ${AGENT_ID:-unknown}"

# --- Generate gateway auth token ---

GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Gateway token generated"

# --- Configure OpenClaw ---
#
# Set gateway.mode = "local" (required or gateway refuses to start) and
# write the gateway auth token (keeps unit file and openclaw.json in sync).
#
# One jq pass to avoid multiple file rewrites.
# See: https://github.com/openclaw/openclaw/issues/17191 (gateway.mode required)
# See: https://github.com/openclaw/openclaw/issues/17223 (token mismatch footgun)

OPENCLAW_CONFIG="/home/openclaw/.openclaw/openclaw.json"
if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  echo "ERROR: openclaw.json not found after onboarding"
  exit 1
fi

jq --arg token "$GATEWAY_TOKEN" '
  .gateway.mode = "local" |
  .gateway.auth.token = $token
' "$OPENCLAW_CONFIG" > "${OPENCLAW_CONFIG}.tmp"
mv "${OPENCLAW_CONFIG}.tmp" "$OPENCLAW_CONFIG"
chown openclaw:openclaw "$OPENCLAW_CONFIG"
echo "OpenClaw config: gateway.mode=local, token set"

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
    REQUESTS=$(jq -r 'to_entries[] | select(.value | type == "object") | select(.value.role == "operator" and .value.clientId == "openclaw-control-ui") | .key' "$PENDING" 2>/dev/null || true)
    for req_id in $REQUESTS; do
      echo "[$(date -Iseconds)] Auto-approving pairing request: $req_id"
      su - openclaw -c "$OPENCLAW_BIN devices approve $req_id" && \
        echo "[$(date -Iseconds)] Approved $req_id" || \
        echo "[$(date -Iseconds)] Failed to approve $req_id"
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
# OpenClaw gateway has no plain HTTP /health endpoint. Validate readiness by
# checking service state and that port 18789 is listening on loopback.

echo "Waiting for OpenClaw gateway..."
HEALTHY=false
for i in $(seq 1 30); do
  if systemctl is-active --quiet openclaw-gateway && ss -ltn '( sport = :18789 )' | grep -q 18789; then
    echo "OpenClaw gateway healthy on :18789"
    HEALTHY=true
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "WARNING: health check timed out after 60s"
  fi
  sleep 2
done

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
# Caddy routes: / -> OpenClaw gateway (:18789), /terminal/* -> ttyd (:7681)
# TLS: uses wildcard cert from /etc/caddy/tls/ if present (written by cloud-init
# user_data), otherwise falls back to per-VM Let's Encrypt (HTTP-01 challenge).

if [[ -n "${INSTANCE_HOSTNAME:-}" ]]; then
  echo "Configuring Caddy for ${INSTANCE_HOSTNAME}..."

  TLS_DIRECTIVE=""
  if [[ -f /etc/caddy/tls/cert.pem && -f /etc/caddy/tls/key.pem ]]; then
    TLS_DIRECTIVE="tls /etc/caddy/tls/cert.pem /etc/caddy/tls/key.pem"
    echo "Using wildcard TLS cert"
  else
    echo "No wildcard cert found, using automatic Let's Encrypt"
  fi

  cat > /etc/caddy/Caddyfile << CADDYEOF
${INSTANCE_HOSTNAME} {
    ${TLS_DIRECTIVE}
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
  --arg solanaWalletAddress "$SOLANA_WALLET_ADDRESS" \
  --arg gatewayToken "$GATEWAY_TOKEN" \
  --arg agentId "$AGENT_ID" \
  --arg secret "$CALLBACK_SECRET" \
  '{serverId: $serverId, solanaWalletAddress: $solanaWalletAddress, gatewayToken: $gatewayToken, agentId: $agentId, secret: $secret}')

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

# --- Background OpenClaw refresh ---
#
# Boot-speed optimization: serve traffic immediately, then run update in the
# background and restart gateway only if update succeeds.

cat > /usr/local/bin/agentbox-openclaw-refresh.sh << 'REFRESHEOF'
#!/usr/bin/env bash
set -euo pipefail

LOG="/var/log/agentbox-openclaw-refresh.log"
exec >>"$LOG" 2>&1

echo "[$(date -Iseconds)] OpenClaw background refresh starting"

if npm i -g openclaw@latest; then
  echo "[$(date -Iseconds)] OpenClaw refresh succeeded ($(openclaw --version)); restarting gateway"
  systemctl restart openclaw-gateway || echo "[$(date -Iseconds)] gateway restart failed"
else
  echo "[$(date -Iseconds)] OpenClaw refresh failed"
  exit 1
fi
REFRESHEOF
chmod +x /usr/local/bin/agentbox-openclaw-refresh.sh

cat > /etc/systemd/system/agentbox-openclaw-refresh.service << 'UPDATESVCEOF'
[Unit]
Description=AgentBox background OpenClaw refresh
After=openclaw-gateway.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/agentbox-openclaw-refresh.sh
UPDATESVCEOF

systemctl daemon-reload
systemctl start --no-block agentbox-openclaw-refresh.service || true
echo "Background OpenClaw refresh triggered"

echo "[$(date -Iseconds)] AgentBox init complete"
