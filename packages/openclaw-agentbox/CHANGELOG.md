# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2026-03-17

### Changed

- Updated package description and keywords for npm discoverability

### Added

- README with inference.surf quick start guide and plugin reference
- CHANGELOG following keepachangelog format

## [1.0.6] - 2026-03-11

### Fixed

- Swap success reporting now verifies on-chain transaction confirmation instead of silently swallowing timeouts
- SOL balance pre-check before swaps involving native SOL (need ~0.0025 SOL for wSOL ATA rent + fees)
- Surface `TransactionNotConfirmedError` with Solscan link instead of false success

## [1.0.5] - 2026-03-11

### Fixed

- Skills update uses `--copy` mode to avoid symlink rejection by OpenClaw (managed skills path requires real files, not symlinks)

## [1.0.4] - 2026-03-11

### Added

- Real SSE streaming pass-through from upstream (replaces fake streaming that forced `stream: false` and wrapped JSON as SSE)
- Usage extraction from final SSE data chunk for history logging
- Injects `stream_options.include_usage` to ensure upstream includes usage in streaming responses

## [1.0.3] - 2026-03-11

### Fixed

- Replace `@solana-program/token-2022` dependency with `@solana/kit` primitives to resolve peer dependency conflict (`@solana/sysvars@^5` vs `@solana/kit@6`)

## [1.0.2] - 2026-03-10

### Fixed

- Strip `upstreamUrl` from gateway provider config (OpenClaw rejects unknown keys)
- Switch from removed `registerHttpHandler` to `registerHttpRoute` with `match: "prefix"`
- Strip hop-by-hop headers (`content-length`, `transfer-encoding`) before proxying to upstream
- Update OpenClaw dev dependency to `>=2026.3.8`

## [1.0.0] - 2026-03-10

### Added

- Initial release - split from `openclaw-x402` into `x402-proxy` (generic library) + `openclaw-agentbox` (OpenClaw plugin)
- x402 payment proxy via `registerHttpRoute` on `/x402/*` prefix
- Provider `baseUrl` uses loopback; `upstreamUrl` points to external x402 endpoint
- Wallet generation CLI: `openclaw agentbox generate --output <dir>` (BIP-39 mnemonic, Solana + EVM keypairs)
- Slash commands: `/x_wallet`, `/x_status`, `/x_update`
- Agent tools: `x_balance`, `x_payment`, `x_swap`, `x_launch_token`, `x_token_info`
- Transaction history logging to `history.jsonl`
- Token swaps via Jupiter, Bags.fm (Meteora DLMM fallback), PumpPortal (pre-graduation pump.fun)
- Token launching on pump.fun and Bags.fm

[1.0.7]: https://github.com/cascade-protocol/agentbox/compare/v1.0.6-agentbox...v1.0.7-agentbox
[1.0.6]: https://github.com/cascade-protocol/agentbox/compare/v1.0.5-agentbox...v1.0.6-agentbox
[1.0.5]: https://github.com/cascade-protocol/agentbox/compare/v1.0.4-agentbox...v1.0.5-agentbox
[1.0.4]: https://github.com/cascade-protocol/agentbox/compare/v1.0.3-agentbox...v1.0.4-agentbox
[1.0.3]: https://github.com/cascade-protocol/agentbox/compare/v1.0.2-agentbox...v1.0.3-agentbox
[1.0.2]: https://github.com/cascade-protocol/agentbox/compare/v1.0.0-agentbox...v1.0.2-agentbox
[1.0.0]: https://github.com/cascade-protocol/agentbox/releases/tag/v1.0.0-agentbox
