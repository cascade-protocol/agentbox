# openclaw-x402

OpenClaw plugin for x402 USDC payments and pump.fun trading on Solana. Handles LLM inference billing automatically, and gives the agent tools to trade tokens, call paid APIs, and manage its wallet.

## What it does

**Fetch interception (automatic):**
- Intercepts outgoing fetch calls to configured provider URLs
- Handles `402 Payment Required` responses using the x402 protocol
- Signs USDC SPL token payments from a local Solana keypair

**Agent tools (AI-callable):**
- `x_balance` - check wallet SOL and USDC balances
- `x_payment` - call any x402-enabled paid API with automatic USDC payment
- `x_swap` - swap any Solana token for another (Jupiter + PumpPortal fallback)
- `x_launch_token` - launch a new token on pump.fun
- `x_token_info` - look up token price, market cap, volume, liquidity

**User commands (slash commands):**
- `/x_wallet` - wallet dashboard with balance, token holdings, send USDC, transaction history
- `/x_status` - system overview with version, model info, pricing, wallet summary
- `/x_update` - update plugin and skills, restart gateway

## Installation

```bash
pnpm add openclaw-x402
# or
npm install openclaw-x402
```

Add to your OpenClaw plugin config:

```json
{
  "plugins": [
    {
      "package": "openclaw-x402",
      "config": {
        "keypairPath": "/path/to/solana/id.json",
        "providers": {
          "blockrun": {
            "baseUrl": "https://sol.blockrun.ai/api/v1",
            "models": [
              {
                "id": "moonshot/kimi-k2.5",
                "name": "Kimi K2.5",
                "maxTokens": 4096,
                "cost": { "input": 0.6, "output": 3, "cacheRead": 0.3, "cacheWrite": 0.6 },
                "contextWindow": 262144
              }
            ]
          }
        }
      }
    }
  ]
}
```

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `providers` | Yes | - | Provider catalog object keyed by provider name, each with `baseUrl` and `models` array |
| `keypairPath` | No | `~/.openclaw/agentbox/wallet-sol.json` | Path to Solana keypair JSON |
| `rpcUrl` | No | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `dashboardUrl` | No | - | URL to link from `/x_wallet` dashboard |

Each model in `providers.*.models` supports: `id`, `name`, `maxTokens`, `cost` (per 1M tokens: `input`, `output`, `cacheRead`, `cacheWrite`), `contextWindow`, `reasoning`, `input` (modalities).

## Token swaps

The `x_swap` tool lets agents swap any Solana token for another using mint addresses. Routing:

1. **Jupiter** (via `lite-api.jup.ag`) - handles all DEX-listed tokens (SOL, USDC, any SPL token)
2. **PumpPortal fallback** - for pre-graduation pump.fun tokens still on the bonding curve (SOL pairs only)

Amount is in human-readable input token units (e.g. 0.5 for 0.5 SOL). Default slippage: 250 bps (2.5%). Transactions are signed locally and confirmed via WebSocket.

The `x_launch_token` tool launches new tokens on pump.fun with an initial dev buy (default: 0.05 SOL, slippage: 10%).

Use `x_token_info` to look up token data and mint addresses. It checks DexScreener first, then falls back to pump.fun's API for pre-graduation tokens.

## Wallet generation

The plugin includes a CLI for generating wallets from a BIP-39 mnemonic:

```bash
openclaw x402 generate --output ~/.openclaw/agentbox
```

This creates three files:
- `wallet-sol.json` - Solana keypair (64-byte JSON array, solana-keygen compatible)
- `wallet-evm.key` - EVM private key (raw `0x...` hex)
- `mnemonic` - 24-word BIP-39 mnemonic (both keys derive from this)

Solana uses SLIP-10 Ed25519 at `m/44'/501'/0'/0'` (Phantom/Backpack compatible). EVM uses BIP-32 secp256k1 at `m/44'/60'/0'/0/0`.

## Inference reserve

$0.30 USDC is reserved for LLM inference and cannot be spent by agent tools. This prevents the agent from spending all funds on external APIs and losing the ability to respond.

## Transaction history

All transactions are logged to `history.jsonl` alongside the wallet keypair (append-only JSONL, auto-rotates at 1000 entries). Logged types: inference (LLM calls), x402 service payments, USDC sends, pump.fun trades. Failed transactions are logged with `ok: false`.

The `/x_wallet` command shows balance, token holdings, and recent transactions with clickable Solscan time links. Use `/x_wallet history` for paginated history and `/x_wallet send <amount|all> <address>` to send USDC.

## Funding the wallet

1. Run `/x_wallet` to get your wallet address
2. Send SOL (for trading and tx fees) and USDC (for paid APIs) to that address
3. Keep a small amount of SOL (0.01+) for transaction fees

## How it works

On startup the plugin loads the keypair, creates an x402 client with `ExactSvmScheme` for Solana mainnet, and replaces `globalThis.fetch` with a wrapper. Requests to any configured provider URL go through x402 payment handling. All other requests pass through unmodified. Agent tools use the same x402 fetch wrapper to pay for external endpoints. Token swaps use Jupiter's Metis API for routing, with PumpPortal fallback for bonding curve tokens. Both return raw transaction bytes that are signed locally and confirmed via WebSocket.

## License

Apache-2.0 - see [LICENSE](./LICENSE).
