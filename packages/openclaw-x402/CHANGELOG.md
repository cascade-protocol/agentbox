# Changelog

All notable changes to `openclaw-x402` are documented here.

## [0.8.2] - 2026-03-04

### Added

- Standalone CLI binary (`openclaw-x402 generate --output <dir>`) for wallet generation without OpenClaw runtime
- Decouples wallet creation from OpenClaw config validation - VM boot no longer fails if config has issues

## [0.8.1] - 2026-03-04

### Changed

- Transaction records in `/x_balance` now display inline (single line) instead of two lines
- `/x_models` shows copyable `/model provider/id` code blocks per model for tap-to-copy in Telegram
- `/x_help` includes `/model` reference and copyable agent prompt for plugin updates

## [0.8.0] - 2026-03-04

### Added

- Transaction history logging to `history.jsonl` (JSONL, append-only, auto-rotation at 1000 entries)
- Logs all transaction types: inference (LLM calls), x402 service payments, USDC sends, pump.fun trades
- Failed transactions logged with `ok: false` for debugging
- `/x_help` command with wallet commands and agent tools cheat sheet
- `/x_models` command showing available models with pricing and context window
- Token holdings display in `/x_balance` - shows SPL tokens with resolved symbols via DexScreener
- "Spent today" summary line in wallet balance
- Tx signature extraction from x402 `PAYMENT-RESPONSE` header (Solscan links)
- Dashboard URL support in plugin config (linked from `/x_balance`)

### Changed

- Redesigned `/x_balance` command: wallet dashboard with balance, tokens, recent txs, and pagination
- `/x_balance` now accepts args: page number (`/x_balance 2`) and `full` flag for verbose model paths
- Enhanced `x_balance` agent tool with spend summary and token holdings
- Spend amounts in recent txs are clickable Solscan links
- Multi-provider support: plugin config now takes a `providers` object with full model metadata (cost, reasoning, contextWindow) instead of single `providerUrl`/`providerName`
- Model catalog read from config providers instead of hardcoded `CURATED_MODELS` array
- PumpPortal trades now wait for on-chain confirmation via WebSocket (15s timeout) instead of fire-and-forget

### Removed

- `providerUrl`, `providerName` plugin config fields (replaced by `providers` object)

## [0.7.1] - 2026-03-04

### Fixed

- Remove `providerUrl` from configSchema `required` - prevents `openclaw plugins install` from failing when providerUrl is not yet configured (set at boot time by init script)

## [0.7.0] - 2026-03-04

### Added

- `x_trade` tool - buy/sell pump.fun tokens via PumpPortal Local Transaction API
- `x_token_info` tool - look up token price, market cap, volume, liquidity via DexScreener (with pump.fun fallback for pre-graduation tokens)
- SOL balance display in `x_balance` command and tool (alongside USDC)
- SOL balance pre-check before pump.fun buy trades
- CLI wallet generation: `openclaw x402 generate --output <dir>` generates a single BIP-39 mnemonic and derives both Solana and EVM keypairs from it
- Solana key: SLIP-10 Ed25519 at m/44'/501'/0'/0' (Phantom-compatible), saved as `wallet-sol.json`
- EVM key: BIP-32 secp256k1 at m/44'/60'/0'/0/0, saved as `wallet-evm.key`
- Mnemonic saved as `mnemonic` (24 words) - the single root secret for both chains

### Changed

- Renamed all commands and tools from `x402_` prefix to `x_` prefix (`x_balance`, `x_send`, `x_payment`, `x_discover`)
- Refactored Solana operations into dedicated `solana.ts` module

### Removed

- `models` plugin config field - model catalog comes from `models.providers` in openclaw.json, not plugin config

## [0.5.0] - 2026-02-24

### Added

- Dynamic model catalog: plugin reads models from `pluginConfig.models` (served by backend config endpoint) instead of hardcoded list. Falls back to built-in CURATED_MODELS for backwards compatibility.
- Upstream error handling: non-402 failures (404, 500, 503) from the LLM provider now return a clean "LLM provider temporarily unavailable" message instead of leaking internal URLs to the user.

### Changed

- Default `providerName` fallback changed from `aimo` to `blockrun`
- Plugin config type widened from `Record<string, string>` to `Record<string, unknown>` to support `models` array

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
