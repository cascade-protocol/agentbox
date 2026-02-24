# openclaw-x402

OpenClaw plugin for x402 USDC payments on Solana. Handles LLM inference billing automatically, and gives the agent tools to discover and pay for external x402 services.

## What it does

**Fetch interception (automatic):**
- Intercepts outgoing fetch calls to your configured provider URL
- Handles `402 Payment Required` responses using the x402 protocol
- Signs USDC SPL token payments from a local Solana keypair

**Agent tools (AI-callable):**
- `x402_balance` - check wallet balance with available/reserved breakdown
- `x402_payment` - call any x402-enabled paid API with automatic USDC payment
- `x402_discover` - search the zauth verified provider directory for paid services

**User commands (slash commands):**
- `/x402_balance` - show wallet address and USDC balance
- `/x402_send` - send USDC to a Solana address

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
| `models` | No | built-in list | Array of model objects from backend config. When provided, overrides the hardcoded model catalog. |

## Inference reserve

$0.30 USDC is reserved for LLM inference and cannot be spent by agent tools. This prevents the agent from spending all funds on external APIs and losing the ability to respond.

## Funding the wallet

1. Run `/x402_balance` to get your wallet address
2. Send USDC (SPL token on Solana mainnet) to that address
3. Keep a small amount of SOL (0.001+) for transaction fees

## How it works

On startup the plugin loads the keypair, creates an x402 client with `ExactSvmScheme` for Solana mainnet, and replaces `globalThis.fetch` with a wrapper. Any request to `providerUrl` goes through x402 payment handling. All other requests pass through unmodified. Agent tools use the same x402 fetch wrapper to pay for external endpoints.

## License

Apache-2.0 - see [LICENSE](./LICENSE).
