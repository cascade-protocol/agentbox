#!/usr/bin/env bash
# Runs on first boot of each AgentBox instance (triggered by cloud-init).
# Generates a gateway token, creates Solana/SATI identity on devnet, starts
# pre-configured services, and calls back to the AgentBox API.
#
# Gateway config, systemd units, and workspace are pre-baked in the golden image
# (setup.sh). This script only handles per-instance runtime config.
#
# The backend's Hetzner provisioning code passes cloud-init user_data that
# writes /etc/agentbox/callback.env with bootstrap credentials, then runs
# this script. Dynamic config (hostname, TLS certs, registration template)
# is fetched from the backend's config endpoint at boot time.
set -euo pipefail

LOG="/var/log/agentbox-init.log"
exec > >(tee -a "$LOG") 2>&1

echo "[$(date -Iseconds)] AgentBox init starting"

# --- Load bootstrap config (written by cloud-init user_data) ---

CALLBACK_ENV="/etc/agentbox/callback.env"
if [[ ! -f "$CALLBACK_ENV" ]]; then
  echo "ERROR: $CALLBACK_ENV not found - cloud-init user_data may be missing"
  exit 1
fi
# shellcheck source=/dev/null
source "$CALLBACK_ENV"
# Expected vars: API_BASE_URL, CALLBACK_SECRET, TERMINAL_TOKEN, SERVER_ID

# --- Derive API endpoints from base URL ---

CALLBACK_URL="${API_BASE_URL%/}/instances/callback"
CALLBACK_STEP_URL="${CALLBACK_URL}/step"
CONFIG_URL="${API_BASE_URL%/}/instances/config?serverId=${SERVER_ID}&secret=${CALLBACK_SECRET}"

report_step() {
  local step="$1"
  local payload
  payload=$(jq -n \
    --argjson serverId "$SERVER_ID" \
    --arg secret "$CALLBACK_SECRET" \
    --arg step "$step" \
    '{serverId: $serverId, secret: $secret, step: $step}')

  curl -sf -X POST "$CALLBACK_STEP_URL" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null || true
  echo "Reported provisioning step: $step"
}

report_step "configuring"

# --- Fetch dynamic config from backend ---

echo "Fetching config from backend..."
CONFIG_JSON=""
for i in $(seq 1 5); do
  CONFIG_JSON=$(curl -sf "$CONFIG_URL") && break
  echo "Config fetch attempt $i failed, retrying in 10s..."
  sleep 10
done
if [[ -z "$CONFIG_JSON" ]]; then
  echo "ERROR: Failed to fetch config after 5 attempts"
  exit 1
fi

INSTANCE_HOSTNAME=$(echo "$CONFIG_JSON" | jq -r '.hostname')
echo "Hostname: $INSTANCE_HOSTNAME"

# --- Write TLS certs if provided by backend ---

TLS_CERT=$(echo "$CONFIG_JSON" | jq -r '.tls.cert // empty')
TLS_KEY=$(echo "$CONFIG_JSON" | jq -r '.tls.key // empty')
if [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]]; then
  mkdir -p /etc/caddy/tls
  echo "$TLS_CERT" > /etc/caddy/tls/cert.pem
  echo "$TLS_KEY" > /etc/caddy/tls/key.pem
  chgrp caddy /etc/caddy/tls/key.pem
  chmod 640 /etc/caddy/tls/key.pem
  echo "Wildcard TLS cert written"
fi

# --- Save registration template for later use ---

echo "$CONFIG_JSON" | jq '.registrationTemplate' > /tmp/registration-template.json

# --- Verify preloaded OpenClaw ---

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw binary not found (expected npm global install)"
  exit 1
fi
echo "Using preloaded OpenClaw $(openclaw --version)"

# --- Generate gateway token and start gateway early ---
#
# Gateway cold start takes ~72s on cx23 (Node.js loading large app on shared CPU).
# Start it first so wallet/SATI/Caddy work overlaps with the cold start.
# Token is injected via systemd drop-in; the pre-baked config reads it from
# OPENCLAW_GATEWAY_TOKEN env var at startup.

GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Gateway token generated"

cat > /etc/systemd/system/openclaw-gateway.service.d/token.conf << EOF
[Service]
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
EOF
chmod 600 /etc/systemd/system/openclaw-gateway.service.d/token.conf

systemctl daemon-reload
systemctl enable openclaw-gateway
systemctl start openclaw-gateway
echo "Gateway starting (cold start ~72s on cx23)..."
report_step "openclaw_ready"

# --- Start ttyd (pre-installed and enabled in golden image) ---

systemctl start ttyd || true

# --- Create Solana wallet + SATI identity (devnet) ---
#
# Runs while gateway is cold-starting. Creates the Solana keypair and publishes
# agent identity on first boot. Registration metadata comes from the backend-
# provided template; only the wallet address is filled in at runtime.

echo "Creating Solana wallet and SATI agent identity..."
IDENTITY_DIR="/home/openclaw/agent-identity"
mkdir -p "$IDENTITY_DIR"
chown -R openclaw:openclaw "$IDENTITY_DIR"

su - openclaw -c "cd $IDENTITY_DIR && create-sati-agent init --force"

# Capture wallet address (keypair created by init above)
SOLANA_WALLET_ADDRESS=$(su - openclaw -c "solana address")

# Merge runtime wallet address into the backend-provided registration template
su - openclaw -c "cd $IDENTITY_DIR && jq \
  --arg wallet \"$SOLANA_WALLET_ADDRESS\" '
  walk(if type == \"string\" then gsub(\"__WALLET_ADDRESS__\"; \$wallet) else . end)
' /tmp/registration-template.json > agent-registration.json"

PUBLISH_JSON=$(su - openclaw -c "cd $IDENTITY_DIR && create-sati-agent publish --network devnet --json")
AGENT_ID=$(echo "$PUBLISH_JSON" | jq -r '.agentId // empty')
report_step "wallet_created"

echo "Solana wallet: $SOLANA_WALLET_ADDRESS"
echo "SATI agent id: ${AGENT_ID:-unknown}"
report_step "sati_published"

# --- Caddy reverse proxy ---
#
# Caddy routes: / -> OpenClaw gateway (:18789), /terminal/<token>/* -> ttyd (:7681)
# The terminal token in the URL path acts as authentication - only users who know
# the per-instance token can access the web terminal.
# TLS: uses wildcard cert if written above, otherwise per-VM Let's Encrypt (HTTP-01).

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
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
        Referrer-Policy strict-origin-when-cross-origin
    }
    handle_path /terminal/${TERMINAL_TOKEN}/* {
        reverse_proxy localhost:7681
    }
    redir /terminal/${TERMINAL_TOKEN} /terminal/${TERMINAL_TOKEN}/
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

report_step "services_starting"

# --- Wait for gateway to become healthy ---
#
# Gateway cold start takes ~72s on cx23. By now wallet/SATI/Caddy work has
# overlapped with most of that time. 120s timeout (60 * 2s) gives margin.

echo "Waiting for OpenClaw gateway..."
HEALTHY=false
for i in $(seq 1 60); do
  if systemctl is-active --quiet openclaw-gateway && ss -ltn '( sport = :18789 )' | grep -q 18789; then
    echo "OpenClaw gateway healthy on :18789"
    HEALTHY=true
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "WARNING: health check timed out after 120s"
  fi
  sleep 2
done

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

echo "[$(date -Iseconds)] AgentBox init complete"
