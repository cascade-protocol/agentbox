# AgentBox

## Stack
- pnpm workspaces monorepo + Turborepo
- Backend: TypeScript, Hono on Node.js (`@hono/node-server`), runs via `tsx` (no build step)
- Database: PostgreSQL 17 + Drizzle ORM
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

## Context
- `PLAN.md` contains the full product context, architecture, and implementation plan - read it first
