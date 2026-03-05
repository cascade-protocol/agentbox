#!/usr/bin/env bash
# Runs on first boot of each AgentBox instance (triggered by cloud-init).
# Creates a Solana keypair, writes the backend-served config, starts
# pre-configured services, and calls back to the AgentBox API.
#
# Gateway config, systemd units, and workspace are pre-baked in the golden image
# (setup.sh). This script only handles per-instance runtime config.
#
# The backend's config endpoint serves a complete openclaw.json (gateway auth,
# models, providers, plugins, telegram, agent defaults) so no jq merges are
# needed here - just write it to disk.
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

# --- Helper: run systemctl --user as the openclaw user ---
#
# The gateway is a user-level systemd service (installed to ~/.config/systemd/user/).
# This script runs as root (cloud-init), so we need XDG_RUNTIME_DIR and
# DBUS_SESSION_BUS_ADDRESS to reach the openclaw user's systemd manager.
# Linger is enabled in the golden image, so the user session starts at boot.

OPENCLAW_UID=$(id -u openclaw)
OPENCLAW_RUNTIME_DIR="/run/user/$OPENCLAW_UID"

oc_systemctl() {
  sudo -u openclaw \
    XDG_RUNTIME_DIR="$OPENCLAW_RUNTIME_DIR" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$OPENCLAW_RUNTIME_DIR/bus" \
    systemctl --user "$@"
}

# Wait for the user systemd manager (started by linger) to be fully ready.
# Cloud-init and user@.service have no guaranteed ordering, so we wait for
# the private socket that systemctl --user actually connects to.
echo "Waiting for openclaw user session..."
for i in $(seq 1 30); do
  [[ -S "$OPENCLAW_RUNTIME_DIR/systemd/private" ]] && break
  if [[ "$i" -eq 30 ]]; then
    echo "ERROR: openclaw user systemd manager not ready after 30s"
    exit 1
  fi
  sleep 1
done
echo "User session ready"

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

# Extract per-instance values from backend response
INSTANCE_HOSTNAME=$(echo "$CONFIG_JSON" | jq -r '.hostname')
GATEWAY_TOKEN=$(echo "$CONFIG_JSON" | jq -r '.gatewayToken')
TELEGRAM_BOT_TOKEN=$(echo "$CONFIG_JSON" | jq -r '.telegramBotToken // empty')
echo "Hostname: $INSTANCE_HOSTNAME"

# --- Start Caddy early (ACME cert provisioning runs in parallel with gateway cold start) ---
#
# Caddy routes: / -> OpenClaw gateway (:18789), /terminal/<token>/* -> ttyd (:7681)
# The terminal token in the URL path acts as authentication - only users who know
# the per-instance token can access the web terminal.
# TLS: automatic per-VM Let's Encrypt (HTTP-01) with ZeroSSL fallback.
# ACME provisioning takes ~5-15s and overlaps with the gateway cold start (~72s).

if [[ -n "${INSTANCE_HOSTNAME:-}" ]]; then
  echo "Configuring Caddy for ${INSTANCE_HOSTNAME}..."

  cat > /etc/caddy/Caddyfile << CADDYEOF
${INSTANCE_HOSTNAME} {
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

# --- Write OpenClaw config (served complete from backend, no merges needed) ---

echo "$CONFIG_JSON" | jq '.openclawConfig' > /home/openclaw/.openclaw/openclaw.json
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
echo "OpenClaw config written from backend"

# --- Write any workspace files provided by the backend ---

WORKSPACE_DIR="/home/openclaw/.openclaw/agentbox"
mkdir -p "$WORKSPACE_DIR"
echo "$CONFIG_JSON" | jq -r '.workspaceFiles // {} | to_entries[] | @base64' | while read entry; do
  FILENAME=$(echo "$entry" | base64 -d | jq -r '.key')
  CONTENT=$(echo "$entry" | base64 -d | jq -r '.value')
  echo "$CONTENT" > "$WORKSPACE_DIR/$FILENAME"
  echo "Wrote workspace file: $FILENAME"
done
chown -R openclaw:openclaw "$WORKSPACE_DIR"

# --- Verify preloaded OpenClaw ---

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw binary not found (expected npm global install)"
  exit 1
fi
echo "Using preloaded OpenClaw $(openclaw --version)"

# --- Create wallet keypairs (before gateway - x402 plugin reads them on start) ---

echo "Creating wallet keypairs..."
WALLET_DIR=/home/openclaw/.openclaw/agentbox
SOLANA_WALLET_ADDRESS=$(openclaw-x402 generate --output "$WALLET_DIR")
chown -R openclaw:openclaw "$WALLET_DIR"
su - openclaw -c "solana config set --keypair $WALLET_DIR/wallet-sol.json" 2>&1
report_step "wallet_created"

echo "Solana wallet: $SOLANA_WALLET_ADDRESS"

# --- Write gateway token to systemd drop-in and start gateway ---
#
# Gateway cold start takes ~72s on cx23 (Node.js loading large app on shared CPU).
# Caddy is already running and provisioning its ACME cert in parallel.
# Token is pre-generated by the backend and included in both openclaw.json
# (for CLI auth) and the systemd drop-in (for the gateway process env).

GATEWAY_DROPIN_DIR=/home/openclaw/.config/systemd/user/openclaw-gateway.service.d
cat > "$GATEWAY_DROPIN_DIR/token.conf" << EOF
[Service]
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
EOF
chown openclaw:openclaw "$GATEWAY_DROPIN_DIR/token.conf"
echo "Gateway token written"

# Clear any stale Telegram webhook right before gateway starts polling.
# The backend also calls deleteWebhook at provision time, but minutes pass
# between that and the gateway actually starting getUpdates long-polling.
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" >/dev/null || true
  echo "Cleared any stale Telegram webhook"
fi

oc_systemctl daemon-reload
oc_systemctl enable openclaw-gateway
oc_systemctl start openclaw-gateway
echo "Gateway starting (cold start ~72s on cx23)..."
report_step "openclaw_ready"

# --- Start ttyd (pre-installed and enabled in golden image) ---

systemctl start ttyd || true

report_step "services_starting"

# --- Wait for gateway to become healthy ---
#
# Gateway cold start takes ~72s on cx23. By now Caddy ACME + wallet + config
# work has overlapped with most of that time. 120s timeout (60 * 2s) gives margin.

echo "Waiting for OpenClaw gateway..."
HEALTHY=false
for i in $(seq 1 60); do
  if oc_systemctl is-active --quiet openclaw-gateway && ss -ltn '( sport = :18789 )' | grep -q 18789; then
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
  --arg secret "$CALLBACK_SECRET" \
  '{serverId: $serverId, solanaWalletAddress: $solanaWalletAddress, secret: $secret}')

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
