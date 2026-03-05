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
- `packages/openclaw-x402` - OpenClaw plugin for x402 payments and pump.fun trading
- `skills/` - OpenClaw skills (provisioning, bootstrap)
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
- `JWT_SECRET`
- `CF_API_TOKEN`
- `VITE_HELIUS_API_KEY`

See `.env.example` for the full list.

## Scripts

At repo root:

- `pnpm dev` - run all dev services through turbo
- `pnpm build` - build all packages
- `pnpm check` - build + type-check + biome (with auto-fixes)
- `pnpm check:all` - same + Docker image builds

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
