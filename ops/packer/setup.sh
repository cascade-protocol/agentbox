#!/usr/bin/env bash
# Build-time setup for the AgentBox golden image.
# Run by Packer on a fresh Hetzner CX22 (Ubuntu 24.04), then snapshotted.
#
# OpenClaw is installed via npm under the openclaw user so it can be
# Gateway config, systemd units, and workspace are pre-baked here so boot
# only needs to: generate a token, create a Solana keypair, and start services.
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
TTYD_VERSION="1.7.7"
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) TTYD_ARCH="x86_64"; TTYD_SHA256="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55" ;;
  arm64) TTYD_ARCH="aarch64"; TTYD_SHA256="b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac
curl -sLo /usr/local/bin/ttyd \
  "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${TTYD_ARCH}"
echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -
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
echo "openclaw ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/openclaw
chmod 440 /etc/sudoers.d/openclaw

# Enable lingering so user-level systemd services persist without a login session.
# This allows `openclaw gateway restart` (which uses systemctl --user) to work.
loginctl enable-linger openclaw

# Configure npm per-user global directory (openclaw owns its packages, no root for npm)
su - openclaw -c "mkdir -p /home/openclaw/.npm-global && npm config set prefix /home/openclaw/.npm-global"
echo 'export PATH="/home/openclaw/.npm-global/bin:$PATH"' >> /home/openclaw/.profile

# Set XDG_RUNTIME_DIR so `openclaw gateway restart` (systemctl --user) works in
# all shell contexts: login shells (SSH), interactive non-login (ttyd terminal).
# .profile covers login shells; .bashrc covers ttyd (interactive non-login).
echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> /home/openclaw/.profile
echo 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"' >> /home/openclaw/.bashrc

# --- Install OpenClaw (npm, openclaw user) ---
#
# Installed under openclaw's npm prefix (~/.npm-global) so the user owns its
# packages. Symlinked to /usr/local/bin for system-wide access (systemd, init).
# Native modules (node-pty, sharp, sqlite-vec) compile here against the
# build-essential toolchain installed above.

echo ""
echo "==> Installing OpenClaw via npm"
su - openclaw -c "npm install -g openclaw@latest"
ln -sf /home/openclaw/.npm-global/bin/openclaw /usr/local/bin/openclaw
echo "    OpenClaw $(openclaw --version) at $(which openclaw)"

# --- Pre-configure OpenClaw gateway ---
#
# Write config at build time so boot skips `openclaw onboard` entirely.
# The gateway resolves OPENCLAW_GATEWAY_TOKEN from the environment at startup
# (set via systemd drop-in written by agentbox-init.sh).
# dangerouslyDisableDeviceAuth disables device pairing for Control UI - the
# gateway token is the sole auth boundary on these single-tenant VMs.

echo ""
echo "==> Pre-configuring OpenClaw gateway"
mkdir -p /home/openclaw/.openclaw/devices
cat > /home/openclaw/.openclaw/openclaw.json << 'OCEOF'
{
  "agent": {
    "skipBootstrap": true
  },
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": { "mode": "token" },
    "controlUi": { "dangerouslyDisableDeviceAuth": true }
  },
  "update": {
    "auto": { "enabled": false },
    "checkOnStart": false
  },
  "logging": {
    "maxFileBytes": 104857600
  },
  "agents": {
    "defaults": {
      "timeoutSeconds": 120,
      "compaction": {
        "mode": "default",
        "reserveTokensFloor": 20000,
        "memoryFlush": { "enabled": true }
      },
      "contextPruning": {
        "mode": "cache-ttl",
        "ttl": "10m",
        "keepLastAssistants": 3,
        "minPrunableToolChars": 20000
      }
    }
  }
}
OCEOF

# --- ClawHub CLI (skills registry) ---
#
# Used to install and update AgentBox skills from ClawHub.
# Separate npm package from OpenClaw - must be installed explicitly.

echo ""
echo "==> Installing ClawHub CLI"
su - openclaw -c "npm install -g clawhub"
ln -sf /home/openclaw/.npm-global/bin/clawhub /usr/local/bin/clawhub
echo "    ClawHub $(clawhub -V 2>/dev/null || echo installed)"

# --- x402 payment plugin ---
# Patches globalThis.fetch to handle x402 USDC payments on Solana for LLM inference.
# Published as `openclaw-x402` on npm. Installed directly into the extensions directory
# where OpenClaw auto-discovers plugins (no load.paths config needed).
echo ""
echo "==> Installing x402 payment plugin"
chown -R openclaw:openclaw /home/openclaw/.openclaw
PLUGIN_DIR=/home/openclaw/.openclaw/extensions/openclaw-x402
su - openclaw -c "
  mkdir -p $PLUGIN_DIR
  cd /tmp && npm pack openclaw-x402@latest 2>/dev/null
  tar xzf /tmp/openclaw-x402-*.tgz -C $PLUGIN_DIR --strip-components=1
  rm -f /tmp/openclaw-x402-*.tgz
  cd $PLUGIN_DIR && npm install --omit=dev
"
echo "    x402 plugin installed"

# --- Seed workspace + install skills from ClawHub ---
#
# OpenClaw defaults workspace to ~/.openclaw/workspace (no override needed).
# AGENTS.md is uploaded by Packer file provisioner to /tmp/agentbox-AGENTS.md.
# Skills are pulled from ClawHub so they can be updated without image rebuild.

echo ""
echo "==> Seeding workspace and installing skills"
WORKSPACE=/home/openclaw/.openclaw/workspace
su - openclaw -c "mkdir -p $WORKSPACE/skills"
cp /tmp/agentbox-AGENTS.md $WORKSPACE/AGENTS.md
chown openclaw:openclaw $WORKSPACE/AGENTS.md

su - openclaw -c "cd $WORKSPACE && clawhub install agentbox --force"
su - openclaw -c "cd $WORKSPACE && clawhub install agentbox-openrouter --force"
su - openclaw -c "cd $WORKSPACE && clawhub install agentbox-twitter --force"
echo "    Workspace seeded, skills installed"

# --- Solana CLI + SATI identity CLI ---
#
# Solana CLI: used by agentbox-init.sh to create a per-instance keypair on boot.
# create-sati-agent: kept in the image for operator use (manual agent management,
# debugging) even though automated SATI registration is handled server-side.

echo ""
echo "==> Installing Solana CLI"
SOLANA_VERSION="v2.3.8"
sh -c "$(curl -sSfL https://release.anza.xyz/${SOLANA_VERSION}/install)"
cp /root/.local/share/solana/install/active_release/bin/solana /usr/local/bin/solana
cp /root/.local/share/solana/install/active_release/bin/solana-keygen /usr/local/bin/solana-keygen
cp /root/.local/share/solana/install/active_release/bin/spl-token /usr/local/bin/spl-token
chmod +x /usr/local/bin/solana /usr/local/bin/solana-keygen /usr/local/bin/spl-token
rm -rf /root/.local/share/solana
echo "    Solana $(solana --version)"

echo ""
echo "==> Installing create-sati-agent CLI"
su - openclaw -c "npm install -g create-sati-agent@latest"
ln -sf /home/openclaw/.npm-global/bin/create-sati-agent /usr/local/bin/create-sati-agent
echo "    create-sati-agent $(create-sati-agent --version 2>/dev/null || echo installed)"

# --- Pre-install systemd services ---
#
# Gateway is a USER-LEVEL systemd service (~/.config/systemd/user/) so that
# OpenClaw's built-in `openclaw gateway restart` (which uses systemctl --user)
# works on the VM. Requires loginctl enable-linger (set above when creating user).
#
# ttyd stays system-level (not managed by OpenClaw CLI).
# Gateway is NOT pre-enabled - agentbox-init.sh enables it after writing the token.

echo ""
echo "==> Installing systemd services"

OPENCLAW_BIN=$(which openclaw)

# Gateway (user-level): token injected at boot via drop-in Environment= directive.
# KillMode=process prevents child processes from blocking systemd shutdown.
# OPENCLAW_GATEWAY_PORT env is needed because gateway.port config is IGNORED
# at runtime - only the env var or CLI flag takes effect.
# See: https://github.com/openclaw/openclaw/issues/7626
GATEWAY_UNIT_DIR=/home/openclaw/.config/systemd/user
mkdir -p "$GATEWAY_UNIT_DIR"
cat > "$GATEWAY_UNIT_DIR/openclaw-gateway.service" << EOF
[Unit]
Description=OpenClaw Gateway (AgentBox)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/openclaw
ExecStart=${OPENCLAW_BIN} gateway run --port 18789 --bind loopback
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=/home/openclaw
Environment=OPENCLAW_GATEWAY_PORT=18789
Environment=NODE_OPTIONS=--max-old-space-size=2048

[Install]
WantedBy=default.target
EOF

mkdir -p "$GATEWAY_UNIT_DIR/openclaw-gateway.service.d"
chown -R openclaw:openclaw /home/openclaw/.config

# ttyd web terminal (system-level) - pre-enabled, no runtime config needed
cat > /etc/systemd/system/ttyd.service << 'EOF'
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
EOF

systemctl daemon-reload
systemctl enable ttyd

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
echo "==> Zeroing free space for smaller snapshot"
dd if=/dev/zero of=/zerofile bs=1M 2>/dev/null || true
rm -f /zerofile
fstrim -av

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
