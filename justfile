build:
  pnpm --filter frontend build
  docker compose --profile server build

start-server: build
  docker compose --profile server up -d

restart-server:
  docker compose --profile server restart

tunnel:
  cloudflared tunnel --config ~/.cloudflared/agentbox-dev.yml run agentbox-dev

start-monitoring:
  ssh agentbox 'cd /opt/agentbox/ops/lgtm && docker compose --env-file ../../.env up -d'

deploy:
  ssh agentbox 'cd /opt/agentbox && git pull && pnpm install --frozen-lockfile && just start-server'
