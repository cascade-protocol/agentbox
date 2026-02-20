# Contributing to AgentBox

Thanks for contributing.

## Development setup

```bash
git clone https://github.com/cascade-protocol/agentbox.git
cd agentbox
pnpm install
cp .env.example .env
pnpm dev
```

## Requirements

- Node.js 24+
- pnpm 9+
- Docker + Docker Compose (for local Postgres and production-like runs)

## Code quality

Run checks before opening a PR:

```bash
pnpm check
pnpm check:ci
```

## Commit style

Use conventional commits:

- `feat: ...`
- `fix: ...`
- `chore: ...`
- `docs: ...`

Optional scope is encouraged, for example `feat(backend): ...`.

## Pull requests

- Keep PRs focused
- Include rationale and testing notes
- Update docs for behavior or API changes
- Link related issues

By contributing, you agree your contributions are licensed under Apache-2.0.
