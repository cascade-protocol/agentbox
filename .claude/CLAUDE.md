# AgentBox

## Stack
- pnpm workspaces monorepo + Turborepo
- Backend: TypeScript, Hono on Node.js (`@hono/node-server`), runs via `tsx` (no build step)
- Database: PostgreSQL 18 + Drizzle ORM (UUIDv7 for event IDs via native `uuidv7()`)
- Frontend: Vite + React 19 + TanStack Router (SPA)
- Styling: Tailwind v4 (CSS-first) + shadcn/ui
- Zod v4 (`zod@^4`) for all request/response validation
- Hetzner Cloud API (direct fetch, no SDK)
- Biome 2.x for linting and formatting
- Node.js 24+

## Validation
- Run `pnpm check` (root) after each set of changes - runs biome + type-check via Turborepo
- Fix all errors before moving on

## Code Style
- No classes, use plain functions
- Define Zod schemas once in `packages/backend/src/lib/schemas.ts`, derive types with `z.infer<>`
- Validate all inputs at route boundaries, trust validated data internally
- Use Drizzle query builder, not raw SQL

## Environment Variables
- Backend: all env vars go in `packages/backend/src/lib/env.ts` (Zod-validated, parsed once at startup). Import `env` from there, never read `process.env` directly in app code.
- Frontend: all env vars go in `packages/frontend/src/env.ts`. Import `env` from there, never read `import.meta.env` directly in components or lib code.
- When adding a new env var, add it to the appropriate env file first, then use the typed `env.VAR_NAME` everywhere.

## Logging (Backend)
- Use the Winston logger from `packages/backend/src/logger.ts` for all backend logging. Never use `console.log`/`console.error` directly.
- Log levels: `logger.error()` for failures, `logger.warn()` for recoverable issues (retries, fallbacks), `logger.info()` for operational events (startup, requests, cleanup), `logger.debug()` for verbose dev diagnostics.
- `LOG_LEVEL` env var controls output (default: `info`). Set to `debug` for verbose output during development.

## Graceful Shutdown (Backend)
- The HTTP server handle must be stored and closed on SIGTERM/SIGINT. This is required for `tsx watch` to restart without EADDRINUSE errors.
- Any `setInterval` or long-lived resource must be cleared in the shutdown handler.
- Always follow the pattern in `index.ts`: signal handler -> clear intervals -> `server.close()` -> `process.exit(0)` with a timeout fallback to `process.exit(1)`.

## Git
- Always use conventional commits: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `ci`, `build`
- Scope is optional, use package name when relevant: `feat(backend):`, `fix(frontend):`
- Never use `git -C <path>` - run git commands without `-C` since the working directory is already the project root

## Frontend Theming (Tailwind v4 + shadcn/ui)
- This project uses Tailwind v4 CSS-first theming, NOT tailwind.config.js
- The theme source-of-truth is `packages/frontend/src/app.css` with three layers:
  1. `@theme inline {}` - maps `--color-*` Tailwind tokens to CSS variables (must include ALL tokens: background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart-1..5, sidebar-*)
  2. `:root {}` - light mode CSS variable values (OKLCH)
  3. `.dark {}` - dark mode CSS variable values (OKLCH) - MUST exist alongside `:root`
- Dark mode is activated by `class="dark"` on `<html>` in `index.html` and the custom variant `@custom-variant dark (&:is(.dark *))` in app.css
- When adding new shadcn components or modifying theme colors, update ALL three layers
- `components.json` configures shadcn generation: style "new-york", baseColor "slate", cssVariables true

## Product
- AgentBox provisions dedicated Hetzner VMs running OpenClaw AI agent gateways
- Users pay $5 USDC (Solana x402 protocol) for 7-day VM with HTTPS and web terminal
- Each VM gets: OpenClaw gateway, Caddy (TLS), ttyd (terminal), Solana wallet + SATI identity

## VM Golden Image (Packer)
- Config: `ops/packer/` - `agentbox.pkr.hcl`, `setup.sh` (build-time), `agentbox-init.sh` (boot-time)
- Build: `just build-image` - auto-bumps version in `agentbox.pkr.hcl`, runs packer build, outputs new snapshot ID
- After build: update `HETZNER_SNAPSHOT_ID` default in `packages/backend/src/lib/env.ts` with the new snapshot ID
- Base: `ubuntu-24.04`, built on cpx42 (fast compile), snapshotted for cx33 (80GB disk)
- Pre-installed: Node.js 24, OpenClaw (npm global + native modules), Caddy, ttyd, Solana CLI, create-sati-agent, openclaw-x402 plugin, build-essential/cmake/python3 (for node-gyp)
- Plugin install: `openclaw-x402` is extracted via `npm pack` + `tar` into `~/.openclaw/extensions/openclaw-x402/` (auto-discovered, no `plugins.load.paths` needed)
- Boot flow: cloud-init writes `/etc/agentbox/callback.env` -> runs `agentbox-init.sh` -> onboards OpenClaw, creates wallet/SATI identity, starts services, callbacks to API
- Services on VM: `openclaw-gateway` (:18789), `ttyd` (:7681), `caddy` (HTTPS :443)

## Backend Provisioning
- `POST /api/instances` -> Hetzner server from snapshot + Cloudflare DNS A record
- Cloud-init user_data triggers `agentbox-init.sh` on first boot
- VM calls back `POST /api/instances/callback` with wallet, token, agentId (authenticated by per-instance `callbackToken`)
- Each instance gets unique `callbackToken` (for VM-to-API auth) and `terminalToken` (for ttyd URL auth) - both generated at provision time
- Hourly cleanup deletes expired instances (Hetzner + Cloudflare)
- `buildUserData()` in `instances.ts` and `agentbox-init.sh` MUST stay in sync - the env vars written by cloud-init user_data must match what the init script sources from `/etc/agentbox/callback.env`

## Init Script (`agentbox-init.sh`)
- Uses `set -euo pipefail` - any command that fails kills the entire script and the VM never calls back
- New commands that can fail non-critically MUST use `|| true` or explicit error handling
- Shell variables (`$foo`) inside double-quoted heredocs/strings are expanded by bash - use `\$foo` when the variable is meant for jq, awk, or other tools

## Security - Public Repository
- NEVER commit IPs, hostnames, SSH configs, server credentials, or any private infrastructure details into the codebase
- NEVER write developer machine paths, internal network info, or deployment targets into checked-in files (including CLAUDE.md)
- This is a public repo - treat all committed content as publicly visible

## Database Migrations
- NEVER run manual SQL (CREATE TABLE, ALTER TABLE, INSERT, UPDATE, DELETE, DROP) directly against the database
- ALL schema changes go through Drizzle: define in `src/db/schema/`, generate with `pnpm db:generate`, apply with `pnpm db:migrate`
- Run migrations via `docker compose exec backend pnpm db:migrate` on remote - never pipe raw SQL to psql
- Drizzle tracks applied migrations in its own `__drizzle_migrations` table - do not manually insert into or modify it

## Local Testing
- `just tunnel` starts a Cloudflare tunnel exposing the local backend at the URL configured in `API_BASE_URL` (.env)
- Full end-to-end VM testing works locally: `pnpm dev` + `just tunnel` + `just build-image` + provision a VM
- The VM calls back to the local backend through the tunnel - no need to deploy to test provisioning flow

## Release & Deploy
- **When ops/packer files are changed** (setup.sh, agentbox-init.sh, agentbox.pkr.hcl), the image MUST be built BEFORE committing:
  1. `just build-image` - builds new snapshot with current ops scripts
  2. Update `HETZNER_SNAPSHOT_ID` in `packages/backend/src/lib/env.ts` with the new snapshot ID
  3. `pnpm check` - verify everything passes
  4. Commit & push (now the committed snapshot ID matches the built image)
  5. `just deploy`
- **Why this order matters:** The backend provisions VMs from the snapshot ID in env.ts. If we commit/deploy first with a stale snapshot ID, new VMs get an old image missing the ops changes. The image must exist and be referenced correctly at deploy time.
- **When only backend/frontend code changes** (no ops files): commit, push, `just deploy` is sufficient
- Validate: `pnpm check` (biome + type-check)
- Commit: conventional commit on `main`
- Push: `git push`
- Deploy: `just deploy` (see `justfile` for details)

## Hetzner Operations
- Use `hcloud server ssh <server-name> '<command>'` to SSH into instances - never raw `ssh root@<ip>` (avoids known_hosts conflicts when IPs get reused across VMs)
- Use `hcloud server list` to find instance names
