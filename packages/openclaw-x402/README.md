# openclaw-x402

OpenClaw plugin for x402 USDC payments and pump.fun trading on Solana. Handles LLM inference billing automatically, and gives the agent tools to trade tokens, discover paid services, and manage its wallet.

## What it does

**Fetch interception (automatic):**
- Intercepts outgoing fetch calls to your configured provider URL
- Handles `402 Payment Required` responses using the x402 protocol
- Signs USDC SPL token payments from a local Solana keypair

**Agent tools (AI-callable):**
- `x_balance` - check wallet SOL and USDC balances
- `x_payment` - call any x402-enabled paid API with automatic USDC payment
- `x_discover` - search the zauth verified provider directory for paid services
- `x_trade` - buy/sell pump.fun tokens via PumpPortal
- `x_token_info` - look up token price, market cap, volume, liquidity

**User commands (slash commands):**
- `/x_balance` - show wallet address and balances
- `/x_send` - send USDC to a Solana address

## Installation

```bash
npm install openclaw-x402
```

Add to your OpenClaw plugin config:

```json
{
  "plugins": [
    {
      "package": "openclaw-x402",
      "config": {
        "providerUrl": "https://your-x402-provider.example.com",
        "keypairPath": "/path/to/solana/id.json"
      }
    }
  ]
}
```

## Configuration

| Field | Required | Default | Description |
|---|---|---|---|
| `providerUrl` | Yes | - | Base URL of the x402-enabled provider to intercept |
| `keypairPath` | No | `~/.openclaw/agentbox/wallet-sol.json` | Path to Solana keypair JSON |
| `providerName` | No | `blockrun` | Provider ID for OpenClaw registration |
| `rpcUrl` | No | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |

## Pump.fun trading

The `x_trade` tool lets agents buy and sell tokens on pump.fun via PumpPortal's Local Transaction API.

- **Buy**: specify SOL amount to spend (e.g. 0.1 SOL)
- **Sell**: specify percentage of holdings to sell (e.g. 50 for half, 100 for all)
- Default slippage: 25%, configurable per trade
- PumpPortal fee: 0.5%
- Transactions are signed locally and submitted without confirmation wait

Use `x_token_info` to look up token data before trading. It checks DexScreener first, then falls back to pump.fun's API for pre-graduation tokens still on the bonding curve.

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

## Funding the wallet

1. Run `/x_balance` to get your wallet address
2. Send SOL (for trading and tx fees) and USDC (for paid APIs) to that address
3. Keep a small amount of SOL (0.01+) for transaction fees

## How it works

On startup the plugin loads the keypair, creates an x402 client with `ExactSvmScheme` for Solana mainnet, and replaces `globalThis.fetch` with a wrapper. Any request to `providerUrl` goes through x402 payment handling. All other requests pass through unmodified. Agent tools use the same x402 fetch wrapper to pay for external endpoints. Trading uses PumpPortal's Local Transaction API - the plugin receives raw transaction bytes, signs them locally, and submits to the Solana network.

## License

Apache-2.0 - see [LICENSE](./LICENSE).
