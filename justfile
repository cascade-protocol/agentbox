build:
  pnpm --filter frontend build
  docker compose --profile server build

start-server: build
  docker compose --profile server up -d

restart-server:
  docker compose --profile server restart

deploy:
  ssh agentbox 'cd /opt/agentbox && git pull && just start-server'
