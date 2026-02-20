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
- Reference implementation: `~/pj/sati/apps/dashboard/src/react-app/index.css` - keep token parity with it
- `components.json` configures shadcn generation: style "new-york", baseColor "slate", cssVariables true

## Hetzner Operations
- Use `hcloud server ssh <server-name> '<command>'` to SSH into instances - never raw `ssh root@<ip>` (avoids known_hosts conflicts when IPs get reused across VMs)
- Use `hcloud server list` to find instance names

