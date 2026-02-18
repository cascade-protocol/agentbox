#!/usr/bin/env bash
# Build-time setup for the AgentBox golden image.
# Run by Packer on a fresh Hetzner CX22 (Ubuntu 24.04), then snapshotted.
#
# Usage:
#   cd ops/packer && packer init . && packer build .
set -euo pipefail

echo "============================================"
echo "  AgentBox Golden Image Setup"
echo "============================================"

# --- System packages ---

# DEBIAN_FRONTEND=noninteractive prevents apt from blocking on interactive
# prompts (e.g. grub config, restart dialogs) which would hang Packer builds.
echo ""
echo "==> Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get upgrade -y
apt-get install -y curl git build-essential ufw jq

# --- Node.js 24 ---

echo ""
echo "==> Installing Node.js 24"
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
echo "    Node.js $(node --version), npm $(npm --version)"

# --- Caddy ---
#
# Installed from the official apt repository. Caddy runs as a TLS-terminating
# reverse proxy on each instance, providing HTTPS via Let's Encrypt (HTTP-01)
# and routing to the OpenClaw gateway (:18789) and ttyd terminal (:7681).
#
# The service is disabled here - agentbox-init.sh writes the Caddyfile with
# the instance hostname and gateway token, then enables and starts Caddy.

echo ""
echo "==> Installing Caddy"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
echo "    Caddy $(caddy version)"
systemctl stop caddy
systemctl disable caddy

# --- ttyd ---
#
# Web-based terminal (tsl0922/ttyd). Runs as a systemd service on localhost:7681,
# accessed through the Caddy reverse proxy with basic auth.

echo ""
echo "==> Installing ttyd"
TTYD_VERSION=$(curl -sf https://api.github.com/repos/tsl0922/ttyd/releases/latest | jq -r '.tag_name')
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) TTYD_ARCH="x86_64" ;;
  arm64) TTYD_ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
curl -sLo /usr/local/bin/ttyd \
  "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}"
chmod +x /usr/local/bin/ttyd
echo "    ttyd ${TTYD_VERSION} (${ARCH})"

# --- OpenClaw ---

echo ""
echo "==> Installing OpenClaw"
npm install -g openclaw@latest
echo "    OpenClaw $(openclaw --version)"

# --- openclaw user ---

echo ""
echo "==> Creating openclaw user"
if id openclaw &>/dev/null; then
  echo "    User already exists, skipping"
else
  useradd -m -s /bin/bash openclaw
fi

# --- OpenClaw onboarding (headless, no daemon) ---
#
# We DO NOT use --install-daemon here. OpenClaw's --install-daemon creates a
# systemd USER service (~/.config/systemd/user/openclaw-gateway.service) which
# has two known problems on headless VMs:
#
# 1. Requires XDG_RUNTIME_DIR and loginctl enable-linger to survive SSH logout.
#    Without linger, the user's systemd instance (and the gateway) dies the
#    moment the SSH session ends.
#    See: https://github.com/openclaw/openclaw/issues/11805
#
# 2. The token-mismatch footgun: the generated unit file hardcodes
#    OPENCLAW_GATEWAY_TOKEN in its Environment= directive. Any config change
#    (upgrades, doctor --fix, configure) rotates the token in openclaw.json
#    but NOT in the unit file. The gateway starts fine but all CLI/agent
#    commands fail silently with "unauthorized: device token mismatch".
#    See: https://github.com/openclaw/openclaw/issues/17223
#    See: https://github.com/openclaw/openclaw/issues/19409
#    See: https://github.com/openclaw/openclaw/issues/19954
#
# Instead, agentbox-init.sh creates a system-level service on each instance
# boot, with the token written to both the unit file AND openclaw.json.
#
# NOTE: The flag is --non-interactive, NOT --headless.
# --headless does not exist despite what some guides claim.

echo ""
echo "==> Running OpenClaw onboarding"
su - openclaw -c "openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice skip \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --skip-channels \
  --skip-skills \
  --skip-health"

# FIX: Verify gateway.mode = "local" is set in config.
#
# The gateway REFUSES to start without gateway.mode = "local" in openclaw.json.
# It exits with: "Gateway start blocked: set gateway.mode=local".
# The onboard command SHOULD set this, but --non-interactive + --auth-choice skip
# can silently skip steps or misconfigure values.
# See: https://github.com/openclaw/openclaw/issues/17191
OPENCLAW_CONFIG="/home/openclaw/.openclaw/openclaw.json"
echo "    Verifying config..."
if [[ -f "$OPENCLAW_CONFIG" ]]; then
  echo "    OK: openclaw.json created"

  CURRENT_MODE=$(jq -r '.gateway.mode // empty' "$OPENCLAW_CONFIG")
  if [[ "$CURRENT_MODE" != "local" ]]; then
    echo "    FIXING: gateway.mode was '$CURRENT_MODE', setting to 'local'"
    jq '.gateway.mode = "local"' "$OPENCLAW_CONFIG" > "${OPENCLAW_CONFIG}.tmp"
    mv "${OPENCLAW_CONFIG}.tmp" "$OPENCLAW_CONFIG"
    chown openclaw:openclaw "$OPENCLAW_CONFIG"
  else
    echo "    OK: gateway.mode = local"
  fi

  # FIX: Lock down plugin allowlist to only ClawRouter.
  #
  # The OpenClaw plugin system has no signature verification, gives plugins
  # shell access via runCommandWithTimeout, and allows supply-chain substitution
  # via unpinned installs.
  # See: https://github.com/openclaw/openclaw/issues/20116 (no signature verification)
  # See: https://github.com/openclaw/openclaw/issues/20117 (shell access via plugins)
  # See: https://github.com/openclaw/openclaw/issues/20118 (unpinned installs)
  # See: https://github.com/openclaw/openclaw/issues/20119 (auto-admit unvetted plugins)
  # See: https://github.com/openclaw/openclaw/issues/20120 (audit findings non-blocking)
  jq '.plugins.allow = ["clawrouter"]' "$OPENCLAW_CONFIG" > "${OPENCLAW_CONFIG}.tmp"
  mv "${OPENCLAW_CONFIG}.tmp" "$OPENCLAW_CONFIG"
  chown openclaw:openclaw "$OPENCLAW_CONFIG"
  echo "    OK: plugins.allow locked to [clawrouter]"
else
  echo "    ERROR: openclaw.json not found - onboarding failed"
  exit 1
fi

# --- ClawRouter ---
#
# We use the official curl install script rather than `openclaw plugins install`
# because the curl script does significantly more: injects auth profiles, refreshes
# the model catalog (30+ models), handles reinstall logic, and cleans stale config.
# The bare `plugins install` only unpacks the npm package without this setup.
# See: https://github.com/BlockRunAI/ClawRouter/blob/main/scripts/reinstall.sh

echo ""
echo "==> Installing ClawRouter"
su - openclaw -c "curl -fsSL https://blockrun.ai/ClawRouter-update | bash"

# --- Verify OpenClaw + ClawRouter ---
#
# FIX: We check ClawRouter's HTTP health at :8402 instead of the gateway's :18789.
#
# The OpenClaw gateway has NO plain HTTP /health endpoint - health is WebSocket RPC
# requiring auth. ClawRouter's proxy at :8402 has a proper HTTP endpoint:
# GET /health returns {"status":"ok","wallet":"0x..."}.
# See: https://github.com/BlockRunAI/ClawRouter (proxy /health endpoint)

echo ""
echo "==> Quick verification: starting gateway to check ClawRouter loads"
su - openclaw -c "timeout 20 openclaw gateway run --port 18789 --bind loopback" &
GW_PID=$!
sleep 10

if curl -sf http://127.0.0.1:8402/health > /dev/null 2>&1; then
  echo "    OK: ClawRouter proxy healthy on :8402"
  curl -sf http://127.0.0.1:8402/health
else
  echo "    WARNING: ClawRouter proxy health check failed"
fi

if ss -tlnp | grep -q ":18789"; then
  echo "    OK: gateway listening on :18789"
else
  echo "    WARNING: gateway not detected on :18789"
fi

kill $GW_PID 2>/dev/null || true
wait $GW_PID 2>/dev/null || true

# --- Wallet generation helper (viem) ---
#
# We install viem in a local directory because Node.js does not resolve imports
# from global node_modules in a plain `node` context. agentbox-init.sh runs
# inline JS from this directory to generate wallets at boot time.
#
# ClawRouter also auto-generates a wallet on first gateway start, but we
# pre-generate so we know the address immediately for the API callback.
# See: https://github.com/BlockRunAI/ClawRouter (src/auth.ts)

echo ""
echo "==> Setting up viem for wallet generation"
mkdir -p /usr/local/lib/agentbox
cat > /usr/local/lib/agentbox/package.json << 'EOF'
{
  "name": "agentbox-wallet-gen",
  "private": true,
  "type": "module",
  "dependencies": { "viem": "^2.46.0" }
}
EOF
cd /usr/local/lib/agentbox && npm install --omit=dev --silent
cd /

echo "    Testing wallet generation..."
WALLET_TEST_ADDR=$(cd /usr/local/lib/agentbox && node --input-type=module -e "
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
console.log(privateKeyToAccount(generatePrivateKey()).address);
")
if [[ "$WALLET_TEST_ADDR" == 0x* ]]; then
  echo "    OK: generated test wallet $WALLET_TEST_ADDR"
else
  echo "    ERROR: wallet generation failed"
  exit 1
fi

# --- Install agentbox-init.sh ---
# Uploaded by Packer's file provisioner to /tmp/

echo ""
echo "==> Installing agentbox-init.sh"
install -m 755 /tmp/agentbox-init.sh /usr/local/bin/agentbox-init.sh

# --- Firewall ---

echo ""
echo "==> Configuring firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # ACME HTTP-01 challenge (Let's Encrypt)
ufw allow 443/tcp   # HTTPS (Caddy reverse proxy)
ufw --force enable

# --- Cleanup for snapshot ---
#
# Thorough cleanup so the snapshot is small and each cloned instance gets a
# fresh identity. Based on the official hcloud Packer plugin example:
# https://github.com/hetznercloud/packer-plugin-hcloud/blob/main/example/docker/cleanup.sh

echo ""
echo "==> Cleaning up for snapshot"

# Remove wallet files generated during verification
rm -f /home/openclaw/.openclaw/blockrun/wallet.key
rm -f /home/openclaw/.openclaw/blockrun/wallet-info.txt

# Ensure all openclaw files are owned correctly - the gateway process runs as
# User=openclaw and cannot read its own config without correct ownership.
chown -R openclaw:openclaw /home/openclaw/.openclaw

# Clear SSH host keys - each instance must have unique keys (regenerated on boot)
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub

# Clear machine-id - shared ID across clones causes DHCP conflicts
truncate -s 0 /etc/machine-id

apt-get -y autopurge
apt-get -y clean
rm -rf /var/lib/apt/lists/*

# Reset cloud-init completely so it runs fresh on next boot from snapshot.
# Without this, cloud-init skips our user_data (which triggers agentbox-init.sh).
cloud-init clean --logs --machine-id --seed --configs all
rm -rf /run/cloud-init/* /var/lib/cloud/*

# Truncate logs - prevents build-time logs leaking into customer instances
journalctl --flush
journalctl --rotate --vacuum-time=0 2>/dev/null || true
find /var/log -type f -exec truncate --size 0 {} \;
find /var/log -type f -name '*.[1-9]' -delete
find /var/log -type f -name '*.gz' -delete

unset HISTFILE
rm -rf /root/.cache /root/.npm
rm -f /root/.bash_history /root/.lesshst /root/.viminfo

# fstrim discards unused blocks so Hetzner's snapshot skips empty space
fstrim --all || true
sync

echo ""
echo "==> Golden image ready"
