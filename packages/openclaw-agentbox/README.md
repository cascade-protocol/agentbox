# openclaw-agentbox

OpenClaw plugin for pay-per-use LLM inference via [x402](https://www.x402.org/) USDC payments on Solana. No API keys needed - your wallet pays per request.

Includes Solana wallet management, token swaps (Jupiter/Bags.fm/PumpPortal), token launching (pump.fun/Bags.fm), and transaction history.

## Quick start with inference.surf

[inference.surf.cascade.fyi](https://inference.surf.cascade.fyi) is a pay-per-use LLM API powered by x402. This guide sets up OpenClaw to use it as the inference backend.

### 1. Install

```bash
openclaw plugins install openclaw-agentbox@latest
```

### 2. Generate a wallet

Skip if you already have a Solana keypair.

```bash
openclaw agentbox generate --output ~/.openclaw/agentbox
```

Outputs `wallet-sol.json` (Solana keypair), `wallet-evm.key` (EVM private key), and `mnemonic` (24-word BIP-39 seed). Fund the Solana address with USDC and a small amount of SOL for fees.

### 3. Configure `~/.openclaw/openclaw.json`

```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "surf": {
        "baseUrl": "http://127.0.0.1:18789/x402/v1",
        "apiKey": "x402-payment",
        "api": "openai-completions",
        "models": [
          { "id": "anthropic/claude-opus-4.6", "name": "Claude Opus 4.6", "maxTokens": 8192 },
          { "id": "anthropic/claude-opus-4.5", "name": "Claude Opus 4.5", "maxTokens": 8192 },
          { "id": "anthropic/claude-sonnet-4.6", "name": "Claude Sonnet 4.6", "maxTokens": 8192 },
          { "id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "maxTokens": 8192 },
          { "id": "moonshotai/kimi-k2.5", "name": "Kimi K2.5", "maxTokens": 4096 },
          { "id": "minimax/minimax-m2.5", "name": "MiniMax M2.5", "maxTokens": 4096 },
          { "id": "qwen/qwen-2.5-7b-instruct", "name": "Qwen 2.5 7B", "maxTokens": 4096 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "surf/anthropic/claude-sonnet-4.5" }
    }
  },
  "plugins": {
    "entries": {
      "openclaw-agentbox": {
        "enabled": true,
        "config": {
          "keypairPath": "~/.openclaw/agentbox/wallet-sol.json",
          "rpcUrl": "https://api.mainnet-beta.solana.com",
          "providers": {
            "surf": {
              "baseUrl": "http://127.0.0.1:18789/x402/v1",
              "upstreamUrl": "https://inference.surf.cascade.fyi",
              "models": [
                {
                  "id": "anthropic/claude-opus-4.6",
                  "name": "Claude Opus 4.6",
                  "maxTokens": 8192,
                  "reasoning": true,
                  "input": ["text", "image"],
                  "contextWindow": 200000
                },
                {
                  "id": "anthropic/claude-opus-4.5",
                  "name": "Claude Opus 4.5",
                  "maxTokens": 8192,
                  "reasoning": true,
                  "input": ["text", "image"],
                  "contextWindow": 200000
                },
                {
                  "id": "anthropic/claude-sonnet-4.6",
                  "name": "Claude Sonnet 4.6",
                  "maxTokens": 8192,
                  "reasoning": false,
                  "input": ["text", "image"],
                  "contextWindow": 200000
                },
                {
                  "id": "anthropic/claude-sonnet-4.5",
                  "name": "Claude Sonnet 4.5",
                  "maxTokens": 8192,
                  "reasoning": false,
                  "input": ["text", "image"],
                  "contextWindow": 200000
                },
                {
                  "id": "moonshotai/kimi-k2.5",
                  "name": "Kimi K2.5",
                  "maxTokens": 4096,
                  "reasoning": true,
                  "input": ["text"],
                  "contextWindow": 262144
                },
                {
                  "id": "minimax/minimax-m2.5",
                  "name": "MiniMax M2.5",
                  "maxTokens": 4096,
                  "reasoning": true,
                  "input": ["text"],
                  "contextWindow": 131072
                },
                {
                  "id": "qwen/qwen-2.5-7b-instruct",
                  "name": "Qwen 2.5 7B",
                  "maxTokens": 4096,
                  "reasoning": false,
                  "input": ["text"],
                  "contextWindow": 32768
                }
              ]
            }
          }
        }
      }
    }
  }
}
```

**Key details:**

- `models.providers.surf.baseUrl` must point to the local x402 proxy (`http://127.0.0.1:{gateway_port}/x402/v1`), not the upstream URL. The plugin handles x402 payment and proxying to the upstream.
- `plugins.entries.openclaw-agentbox.config.providers.surf.upstreamUrl` is the actual inference endpoint that receives requests after x402 payment.
- `models.mode: "replace"` hides built-in providers so only your configured models appear.
- The provider name (e.g. `surf`) must match in both `models.providers` and `plugins.entries.openclaw-agentbox.config.providers`.
- Adjust `agents.defaults.model.primary` to your preferred default model (format: `{provider}/{model_id}`).

### How pricing works

Pricing is input-aware via x402 - scales with prompt size and max_tokens. The 402 response tells your wallet the exact price before paying. No API keys, no accounts.

Example prices (short prompt, default max_tokens):

| Model | ~Price/request |
|---|---|
| Kimi K2.5 | $0.004 |
| MiniMax M2.5 | $0.004 |
| Qwen 2.5 7B | $0.001 |
| Claude Sonnet 4.5 | $0.16 |
| Claude Opus 4.6 | $0.27 |

Larger prompts cost more. Streaming works (`stream: true`).

## Plugin reference

### Commands

| Command | Description |
|---|---|
| `/x_wallet` | Wallet dashboard: balance, token holdings, send USDC, transaction history |
| `/x_status` | System overview: plugin version, current model, pricing, wallet balance, spend today |
| `/x_update` | One-tap update: checks npm for plugin updates, updates skills from GitHub, restarts gateway |

`/x_wallet send <amount|all> <address>` transfers USDC. `/x_wallet history [page]` shows paginated transaction history.

### Agent tools

| Tool | Description |
|---|---|
| `x_balance` | Check wallet SOL/USDC balances, token holdings, daily and total spend |
| `x_payment` | Call any x402-enabled paid API with automatic USDC payment |
| `x_swap` | Swap tokens via Jupiter (primary), Bags.fm (Meteora DLMM fallback), PumpPortal (pre-graduation pump.fun) |
| `x_launch_token` | Launch tokens on pump.fun (default) or Bags.fm (Meteora DLMM, 1% creator volume share) |
| `x_token_info` | Token price, market cap, volume, liquidity via DexScreener. Omit mint for trending tokens |

### Wallet generation CLI

```bash
openclaw-agentbox generate --output <dir>
```

Generates a 24-word BIP-39 mnemonic and derives:

- `wallet-sol.json` - Solana keypair (64-byte JSON array, solana-keygen compatible). Path: `m/44'/501'/0'/0'` (Phantom/Backpack compatible)
- `wallet-evm.key` - EVM private key (0x hex). Path: `m/44'/60'/0'/0/0`
- `mnemonic` - 24-word seed (the root secret)

### Configuration reference

All fields in `plugins.entries.openclaw-agentbox.config`:

| Field | Default | Description |
|---|---|---|
| `keypairPath` | `~/.openclaw/agentbox/wallet-sol.json` | Path to Solana keypair JSON |
| `rpcUrl` | `https://api.mainnet-beta.solana.com` | Solana RPC URL |
| `providers` | required | Provider catalog (see quick start) |
| `dashboardUrl` | - | URL linked from `/x_wallet` |
| `bagsApiKey` | - | Bags.fm API key for token launching/trading |

### Transaction history

All x402 payments, swaps, launches, and transfers are logged to `history.jsonl` alongside the wallet keypair. Append-only JSONL format.

## License

Apache-2.0
