# AgentBox

AgentBox is an operator dashboard and backend for provisioning and managing OpenClaw-based VM instances.

## Stack

- Monorepo: pnpm workspaces + Turborepo
- Backend: Hono + Node.js + Drizzle ORM + PostgreSQL
- Frontend: Vite + React 19 + TanStack Router
- Infra: Hetzner Cloud + optional Cloudflare DNS/TLS

## Repository layout

- `packages/backend` - API server, auth, provisioning, callback handling
- `packages/frontend` - dashboard UI
- `ops/packer` - golden image build and initialization scripts
- `compose.yml` - production-like local orchestration

## Quick start

```bash
git clone https://github.com/cascade-protocol/agentbox.git
cd agentbox
pnpm install
cp .env.example .env
pnpm dev
```

## Environment

Main variables:

- `DATABASE_URL`
- `HETZNER_API_TOKEN`
- `API_BASE_URL`
- `OPERATOR_TOKEN`
- `CALLBACK_SECRET`
- `JWT_SECRET`
- `PAY_TO_ADDRESS`
- `FACILITATOR_URL`
- `INSTANCE_BASE_DOMAIN`
- `CF_API_TOKEN`
- `CF_ZONE_ID`
- `VITE_HELIUS_API_KEY`

See `.env.example` for the full list.

## Scripts

At repo root:

- `pnpm dev` - run all dev services through turbo
- `pnpm build` - build all packages
- `pnpm check` - biome + type checks
- `pnpm check:ci` - CI check variant

Backend package:

- `pnpm --filter @agentbox/backend dev`
- `pnpm --filter @agentbox/backend db:generate`
- `pnpm --filter @agentbox/backend db:migrate`

Frontend package:

- `pnpm --filter @agentbox/frontend dev`
- `pnpm --filter @agentbox/frontend build`
- `pnpm --filter @agentbox/frontend preview`

## Docker compose

```bash
docker compose --profile server up --build
```

## Security

If you find a vulnerability, see `SECURITY.md`.

## License

Apache-2.0. See `LICENSE`.
