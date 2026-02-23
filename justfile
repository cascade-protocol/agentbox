build:
  pnpm --filter frontend build
  docker compose --profile server build

start-server: build
  docker compose --profile server up -d

restart-server:
  docker compose --profile server restart

tunnel:
  cloudflared tunnel --config ~/.cloudflared/agentbox-dev.yml run agentbox-dev

tunnel-db:
  ssh -N -L 5433:localhost:5432 agentbox

start-monitoring:
  ssh agentbox 'cd /opt/agentbox/ops/lgtm && docker compose --env-file ../../.env up -d --remove-orphans'

deploy:
  ssh agentbox 'cd /opt/agentbox && git pull && pnpm install --frozen-lockfile && just start-server'

# Build a new Packer golden image, auto-bumping the version
build-image:
  #!/usr/bin/env bash
  set -euo pipefail
  HCL="ops/packer/agentbox.pkr.hcl"
  OLD=$(grep 'image_version' -A3 "$HCL" | grep 'default' | sed 's/.*"\([0-9]*\)".*/\1/')
  NEW=$((OLD + 1))
  sed -i '' "s/default = \"$OLD\"/default = \"$NEW\"/" "$HCL"
  echo "Bumped image version: v$OLD -> v$NEW"
  cd ops/packer && packer build agentbox.pkr.hcl
