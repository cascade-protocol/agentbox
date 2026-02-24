# Changelog

All notable changes to `openclaw-x402` are documented here.

## [0.4.3] - 2026-02-24

### Fixed

- Fixed contextWindow for Claude models (200K, was incorrectly set to 1M)
- Fixed configSchema providerName default description (aimo, was blockrun)

## [0.4.2] - 2026-02-24

### Changed

- Renamed commands from hyphens to underscores (`/x402_balance`, `/x402_send`) for Telegram compatibility

## [0.4.1] - 2026-02-24

### Changed

- Updated README with tools documentation, inference reserve section, and corrected command names
- Updated package description to reflect new capabilities

## [0.4.0] - 2026-02-24

### Added

- `x402_payment` agent tool - calls any x402-enabled paid API with automatic USDC payment
- `x402_balance` agent tool - checks wallet balance with available/reserved split
- `x402_discover` agent tool - searches zauth's verified provider directory for paid services
- $0.30 USDC inference reserve - tools cannot spend below this threshold to keep LLM running
- Response truncation at 50KB to protect agent context window

### Changed

- Renamed `/balance-x402` to `/x402_balance` and `/send-x402` to `/x402_send` (x402 prefix)
- Removed `/pricing-x402` command (agent gets pricing from discover results)

### Dependencies

- Added `@sinclair/typebox` for tool parameter schemas

## [0.3.2] - 2026-02-23

### Changed

- Renamed `/models-x402` to `/pricing-x402` for consistency with other plugin commands
- Scoped stream-to-SSE conversion to `/chat/completions` only (fixes `/pricing-x402` JSON parse error)
- Fixed pricing display to use BlockRun's `pricing.input`/`pricing.output` fields
- Added `billing_mode: "free"` handling in pricing output

## [0.3.0] - 2026-02-23

### Added

- Provider registration via `api.registerProvider()` with 7 curated models
- `/pricing-x402` command to browse full BlockRun model catalog with pricing
- Stream compatibility fix: forces `stream: false` and wraps JSON response as SSE for pi-ai compatibility
- Non-streaming response conversion (`choices[].message` to `choices[].delta`)

## [0.2.1] - 2026-02-22

### Changed

- Fix repository URL in package metadata (org rename)
- Add README, CHANGELOG, and package-level LICENSE for npm

## [0.2.0] - 2026-02-22

### Changed

- Renamed `/balance` command to `/balance-x402` to avoid conflicts with other plugins
- Renamed `/send` command to `/send-x402` for the same reason
- Updated `@solana-program/token-2022` peer dependency to `^0.6.1`

## [0.1.0] - 2026-02-22

### Added

- Initial release
- Patches `globalThis.fetch` to handle x402 USDC payments on Solana
- `ExactSvmScheme` integration via `@x402/svm` and `@x402/fetch`
- `/balance` command - shows wallet address and USDC balance
- `/send` command - sends USDC to a Solana address (supports `all` keyword)
- Friendly error messages for insufficient funds, missing USDC accounts, and simulation failures
