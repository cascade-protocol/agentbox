#!/bin/bash
# PreToolUse hook: auto-cleans stale SSH host keys before connecting to agentbox VMs.
# Hetzner reuses IPs across ephemeral VMs, causing "Host key verification failed".
# This hook detects SSH commands, resolves the target IP, and removes the old key.
set -uo pipefail

COMMAND=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0

# Match: hcloud server ssh <name> ...
if [[ "$COMMAND" =~ hcloud[[:space:]]+server[[:space:]]+ssh[[:space:]]+([^[:space:]\'\"]+) ]]; then
  SERVER_NAME="${BASH_REMATCH[1]}"
  # Skip flags like --help
  [[ "$SERVER_NAME" == -* ]] && exit 0
  IP=$(hcloud server ip "$SERVER_NAME" 2>/dev/null)
  if [ -n "$IP" ]; then
    ssh-keygen -R "$IP" 2>/dev/null
  fi
fi

# Match: ssh ... root@<ip> ... (raw SSH fallback)
if [[ "$COMMAND" =~ root@([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+) ]]; then
  IP="${BASH_REMATCH[1]}"
  ssh-keygen -R "$IP" 2>/dev/null
fi

exit 0
