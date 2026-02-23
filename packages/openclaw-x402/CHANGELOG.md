# Changelog

All notable changes to `openclaw-x402` are documented here.

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
