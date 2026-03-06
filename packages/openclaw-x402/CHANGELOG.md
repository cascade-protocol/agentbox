# Changelog

All notable changes to `openclaw-x402` are documented here.

## [0.11.1] - 2026-03-06

### Fixed

- `/x_wallet` in status footer is now plain text (tappable in Telegram), not a codeblock
- Today's spend in `/x_status` shows 3 decimal places for small amounts

## [0.11.0] - 2026-03-06

### Changed

- Redesigned `/x_status`: compact layout, no wallet duplication, inline update CTA with ⬆ indicator
- `/x_wallet` header "Wallet" links to Solscan account page
- Transaction history shows model name instead of generic "inference"
- Removed blockrun and aimo providers (agentbox only)
- Simplified `/x_wallet` footer to just `/x_wallet history`

## [0.10.5] - 2026-03-06

### Added

- `/x_status` shows "Updated vX -> vY" confirmation after a plugin update and gateway restart

### Fixed

- `PLUGIN_VERSION` was hardcoded and never updated across releases, causing `/x_status` to always report `v0.10.0`. Now reads version from `package.json` at runtime.

## [0.10.3] - 2026-03-06

### Changed

- `x_status` now includes skills update check via `npx skills check`
- `x_update` uses native `npx skills check` / `npx skills update` instead of force-reinstalling via `skills add` (respects lockfile)
- `x_update` passes `INSTALL_INTERNAL_SKILLS=1` so internal skills (e.g. agentbox-bootstrap) can be updated
- Improved restart message with cold start timing guidance

## [0.10.2] - 2026-03-05

### Fixed

- `x_swap` and PumpPortal swaps crash: missing `await` on async `getTransactionLifetimeConstraintFromCompiledTransactionMessage` (became async in @solana/kit 5.x, see anza-xyz/kit#1011). The unawaited Promise caused `assertIsTransactionWithBlockhashLifetime` to fail. Also spread signed transaction instead of `Object.assign` on frozen object.

## [0.10.0] - 2026-03-05

### Added

- `x_swap` tool - universal token swap using mint addresses. Routes through Jupiter aggregator for all DEX-listed tokens, falls back to PumpPortal for pre-graduation pump.fun bonding curve tokens. Amount in human-readable input token units, default slippage 250 bps (2.5%).
- `x_launch_token` tool - launch new tokens on pump.fun with initial dev buy (default 0.05 SOL, 10% slippage)
- `JupiterNoRouteError` class for clean fallback detection from Jupiter to PumpPortal
- `getTokenDecimals()` helper with hardcoded values for SOL/USDC and RPC lookup for unknown mints
- `swapViaJupiter()` - full Jupiter Metis API flow (quote + swap tx + local signing + WebSocket confirmation)
- Comprehensive test suite for Jupiter swap HTTP interactions and token decimal resolution

### Changed

- Token swaps use `lite-api.jup.ag` (no API key required) - scales independently per VM

### Fixed

- x402 payment amount was in base units (micro-USDC), now correctly divided by 10^6 for human-readable USDC

### Removed

- `x_trade` tool (replaced by `x_swap` for swaps and `x_launch_token` for token creation)

## [0.9.4] - 2026-03-05

### Added

- Transaction audit log: unified `TxRecord` format with CAIP-2 network IDs, `from`/`to` addresses, multi-chain explorer links
- Inference records now capture `provider`, `cacheRead`, `cacheWrite`, `reasoningTokens`, `thinking` mode
- Payment amount captured from x402 client hooks (no RPC lookup needed)
- Sell trades display percentage in history instead of misleading SOL amount
- Transfer records show shortened destination address in history

### Fixed

- Payment queue leak: failed x402 payments (402, upstream error, fetch throw) now drain the hook queue, preventing wrong amounts on subsequent payments
- x_update: skills refresh runs unconditionally (was skipped when plugin version matched)
- Command references use backtick code spans instead of escaped underscores

### Removed

- Dead `getTransactionUsdcCostWithRetry` function (superseded by x402 client hooks)
- `/model` reference from x_status footer (built-in command, not ours)

## [0.9.3] - 2026-03-05

### Fixed

- x_update: delete + reinstall plugin instead of broken `openclaw plugins update` (install records wiped by init config write)
- x_update: use process.exit for restart (systemd Restart=always) instead of broken systemctl --user (no DBUS in gateway env)

## [0.9.2] - 2026-03-05

### Changed

- x_status shows only agentbox + blockrun models as tappable `/model provider/id` codeblocks
- Inference costs fetched from on-chain transaction (real USDC delta) instead of token-based estimates
- Adaptive USDC precision in history display (0.003 no longer rounds to 0.000)
- Init script merges telegram config preserving `linkPreview: false` from base config

## [0.9.1] - 2026-03-05

### Fixed

- Republish with correct build artifacts (0.9.0 was published from stale build)

## [0.9.0] - 2026-03-05

### Added

- `/x_wallet` command - unified wallet view with balance, token holdings, inline history, send USDC, and paginated history subcommand
- `/x_status` command - system overview with version check, model info, pricing table, wallet summary, and recent transactions
- `/x_update` command - one-tap plugin + skills update with automatic gateway restart
- `x_trade` tool - merged buy/sell/create into single tool for pump.fun token operations

### Changed

- Extracted history utilities into `history.ts` - pure functions with no plugin state dependency
- Batch DexScreener API for token symbol resolution (single request instead of N)
- Shared `getWalletSnapshot()` eliminates duplicate balance fetching across commands/tools
- `toolResult()` helper reduces tool return boilerplate
- Simplified `formatTxLine` - unified format with middle-dot separators and Solscan time links
- Token symbols (USDC, SOL) instead of $ prefix everywhere
- Full wallet address in backticks (copyable in Telegram)
- Transaction times rendered as clickable Solscan links
- Adaptive wallet layout: inline history when tokens <= 3, link-only when more

### Removed

- `/x_help` command (replaced by `/x_status`)
- `/x_models` command (pricing table merged into `/x_status`)
- `/x_send` command (merged into `/x_wallet send`)
- `/x_balance` command (replaced by `/x_wallet`)
- `x_create_token` tool (merged into `x_trade` with `action: "create"`)
- `x_discover` tool

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
