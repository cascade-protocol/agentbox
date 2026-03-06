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
  ssh agentbox 'cd /opt/agentbox && git pull && pnpm install --frozen-lockfile && just start-server && docker compose exec backend pnpm db:migrate'

# Build a new Packer golden image (timestamp-named, no version to bump)
build-image:
  cd ops/packer && packer build agentbox.pkr.hcl
