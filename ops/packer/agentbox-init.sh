#!/usr/bin/env bash
# Runs on first boot of each AgentBox instance (triggered by cloud-init).
# Generates a gateway token, creates a Solana keypair, starts pre-configured
# services, and calls back to the AgentBox API.
#
# Gateway config, systemd units, and workspace are pre-baked in the golden image
# (setup.sh). This script only handles per-instance runtime config.
#
# The backend's Hetzner provisioning code passes cloud-init user_data that
# writes /etc/agentbox/callback.env with bootstrap credentials, then runs
# this script. Dynamic config (hostname) is fetched from the backend's config
# endpoint at boot time.
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

# --- Merge dynamic provider config into baked openclaw.json ---

PROVIDER_NAME=$(echo "$CONFIG_JSON" | jq -r '.provider.name // "aimo"')
PROVIDER_URL=$(echo "$CONFIG_JSON" | jq -r '.provider.url // "https://beta.aimo.network"')
DEFAULT_MODEL=$(echo "$CONFIG_JSON" | jq -r '.provider.defaultModel // "anthropic/claude-sonnet-4.5"')
SOLANA_RPC=$(echo "$CONFIG_JSON" | jq -r '.provider.rpcUrl // empty')
TELEGRAM_BOT_TOKEN=$(echo "$CONFIG_JSON" | jq -r '.telegramBotToken // empty')

PLUGIN_CONFIG=$(jq -n \
  --arg providerUrl "$PROVIDER_URL" \
  --arg providerName "$PROVIDER_NAME" \
  --arg rpcUrl "${SOLANA_RPC:-}" \
  '{
    providerUrl: $providerUrl,
    providerName: $providerName,
    keypairPath: "/home/openclaw/.openclaw/agentbox/wallet-sol.json"
  } + (if $rpcUrl != "" then {rpcUrl: $rpcUrl} else {} end)')

# OpenClaw's registerProvider() (plugin API) only handles auth metadata -
# models must also be in models.providers for the model resolution system.
# apiKey is a dummy value: the x402 fetch patch strips Authorization headers
# and handles payment automatically.
PROVIDER_DEF=$(jq -n \
  --arg baseUrl "${PROVIDER_URL%/}/api/v1" \
  '{
    baseUrl: $baseUrl,
    apiKey: "x402-payment",
    api: "openai-completions",
    models: [
      {id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", maxTokens: 2048},
      {id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", maxTokens: 2048},
      {id: "openai/gpt-5.2", name: "GPT-5.2", maxTokens: 2048},
      {id: "moonshot/kimi-k2.5", name: "Kimi K2.5", maxTokens: 4096},
      {id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", maxTokens: 4096}
    ]
  }')

jq --argjson pluginConfig "$PLUGIN_CONFIG" \
   --argjson providerDef "$PROVIDER_DEF" \
   --arg providerName "$PROVIDER_NAME" \
   --arg defaultModel "$DEFAULT_MODEL" \
   --arg telegramBotToken "${TELEGRAM_BOT_TOKEN:-}" \
   '
   .plugins.entries."openclaw-x402" = {
     enabled: true,
     config: $pluginConfig
   }
   | .plugins.entries.telegram.enabled = true
   | .agents.defaults.model.primary = ($providerName + "/" + $defaultModel)
   | .agents.defaults.models = (
       [$providerDef.models[] | {
         key: ($providerName + "/" + .id),
         value: {alias: .name}
       }] | from_entries
     )
   | .models.providers[$providerName] = $providerDef
   | if $telegramBotToken != "" then
       .channels.telegram = {
         enabled: true,
         botToken: $telegramBotToken,
         dmPolicy: "open",
         allowFrom: ["*"],
         groups: { "*": { requireMention: true } },
         ackReaction: "\uD83D\uDC4B"
       }
     else . end
   # NOTE: streaming config (agents.defaults.models[].streaming and .params.streaming)
   # is dead code in OpenClaw - pi-ai hardcodes stream:true in buildParams().
   # The openclaw-x402 plugin handles this in the fetch interceptor by forcing
   # stream:false in the request body and wrapping the JSON response as SSE.
   ' /home/openclaw/.openclaw/openclaw.json > /tmp/openclaw.json.tmp

mv /tmp/openclaw.json.tmp /home/openclaw/.openclaw/openclaw.json
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json
echo "Provider config merged: $PROVIDER_NAME (default model: $DEFAULT_MODEL)"

# --- Verify preloaded OpenClaw ---

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw binary not found (expected npm global install)"
  exit 1
fi
echo "Using preloaded OpenClaw $(openclaw --version)"

# --- Create Solana keypair (before gateway - x402 plugin reads it on start) ---

echo "Creating Solana keypair..."
su - openclaw -c "mkdir -p /home/openclaw/.openclaw/agentbox"
su - openclaw -c "solana-keygen new --no-bip39-passphrase --force -o /home/openclaw/.openclaw/agentbox/wallet-sol.json" 2>&1
su - openclaw -c "solana config set --keypair /home/openclaw/.openclaw/agentbox/wallet-sol.json" 2>&1
SOLANA_WALLET_ADDRESS=$(su - openclaw -c "solana address")
report_step "wallet_created"

echo "Solana wallet: $SOLANA_WALLET_ADDRESS"

# --- Generate gateway token and start gateway ---
#
# Gateway cold start takes ~72s on cx23 (Node.js loading large app on shared CPU).
# Caddy is already running and provisioning its ACME cert in parallel.
# Token is injected via systemd drop-in (for the gateway process) and written
# to openclaw.json (for CLI auth). Both must match.

GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "Gateway token generated"

cat > /etc/systemd/system/openclaw-gateway.service.d/token.conf << EOF
[Service]
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
EOF
chmod 600 /etc/systemd/system/openclaw-gateway.service.d/token.conf

# Write token into openclaw.json so the CLI can authenticate against the gateway.
# Without this, `openclaw agent` falls back to embedded mode which doesn't start
# plugin services (the x402 fetch interceptor never activates).
jq --arg token "$GATEWAY_TOKEN" \
   '.gateway.auth.token = $token | .gateway.remote.token = $token' \
   /home/openclaw/.openclaw/openclaw.json > /tmp/openclaw.json.tmp
mv /tmp/openclaw.json.tmp /home/openclaw/.openclaw/openclaw.json
chown openclaw:openclaw /home/openclaw/.openclaw/openclaw.json

# Clear any stale Telegram webhook right before gateway starts polling.
# The backend also calls deleteWebhook at provision time, but minutes pass
# between that and the gateway actually starting getUpdates long-polling.
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook" >/dev/null || true
  echo "Cleared any stale Telegram webhook"
fi

systemctl daemon-reload
systemctl enable openclaw-gateway
systemctl start openclaw-gateway
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
  --arg secret "$CALLBACK_SECRET" \
  '{serverId: $serverId, solanaWalletAddress: $solanaWalletAddress, gatewayToken: $gatewayToken, secret: $secret}')

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
