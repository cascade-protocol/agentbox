#!/usr/bin/env bash
# Build-time setup for the AgentBox golden image.
# Run by Packer on a fresh Hetzner CX22 (Ubuntu 24.04), then snapshotted.
#
# OpenClaw is installed globally via npm so the binary is ready at boot.
# Instance boot runs onboarding, installs ClawRouter, and performs a
# lightweight background `npm i -g openclaw@latest` without blocking access.
#
# Usage:
#   cd ops/packer && packer init . && packer build .
set -euo pipefail

echo "============================================"
echo "  AgentBox Golden Image Setup"
echo "============================================"

# --- System packages ---
#
# DEBIAN_FRONTEND=noninteractive prevents apt from blocking on interactive
# prompts (e.g. grub config, restart dialogs) which would hang Packer builds.

echo ""
echo "==> Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get upgrade -y

# build-essential, python3, cmake: required by node-gyp for native npm modules
# (node-pty, sharp, sqlite-vec). Pre-baked so boot-time openclaw install is fast.
# git: required by npm even for non-git packages (avoids 'spawn git ENOENT').
# ufw: firewall (configured at end of this script).
# jq: used by agentbox-init.sh for JSON manipulation.
apt-get install -y curl git build-essential python3 cmake ufw jq

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
# the instance hostname, then enables and starts Caddy.

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
# accessed through the Caddy reverse proxy.

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

# --- openclaw user ---

echo ""
echo "==> Creating openclaw user"
if id openclaw &>/dev/null; then
  echo "    User already exists, skipping"
else
  useradd -m -s /bin/bash openclaw
fi

# --- Install OpenClaw (npm global) ---
#
# Pre-baked via npm so the binary is immediately available at boot.
# Native modules (node-pty, sharp, sqlite-vec) compile here against the
# build-essential toolchain installed above, so boot-time updates skip rebuilds.
# See: https://openclaw.ai/docs/install

echo ""
echo "==> Installing OpenClaw via npm"
npm install -g openclaw@latest
echo "    OpenClaw $(openclaw --version) at $(which openclaw)"

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

echo ""
echo "==> Golden image ready"
