# openclaw-x402

OpenClaw plugin that enables automatic x402 USDC payments on Solana for LLM inference providers. It patches `globalThis.fetch` to intercept requests to a configured provider URL, handles HTTP 402 payment challenges, and signs transactions from a local Solana keypair.

## What it does

- Intercepts outgoing fetch calls to your configured provider URL
- Automatically handles `402 Payment Required` responses using the x402 protocol
- Signs USDC SPL token payments from a Solana keypair file
- Strips `Authorization` headers before forwarding (payment is the auth)
- Exposes `/balance-x402` and `/send-x402` commands in the OpenClaw gateway

## Installation

Install as an OpenClaw plugin:

```bash
npm install openclaw-x402
```

Then add it to your OpenClaw plugin config (e.g. `~/.openclaw/plugins.json`):

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
| `keypairPath` | No | `/home/openclaw/.openclaw/agentbox/wallet-sol.json` | Path to Solana keypair JSON file |
| `rpcUrl` | No | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |

## Commands

Once the plugin is loaded, these slash commands are available in the OpenClaw gateway:

### `/balance-x402`

Shows the wallet public key and current USDC balance.

```
Wallet: 7xKXtg...
USDC balance: $1.234500

To top up, send USDC (SPL) on Solana to:
7xKXtg...
```

### `/send-x402 <amount|all> <address>`

Sends USDC from the plugin wallet to a Solana address.

```
/send-x402 0.5 7xKXtg...
/send-x402 all 7xKXtg...
```

The recipient must already have a USDC token account (have received USDC at least once).

## Funding the wallet

The wallet is a standard Solana keypair. To pay for inference:

1. Run `/balance-x402` to get your wallet address
2. Send USDC (SPL token on Solana mainnet) to that address
3. Keep a small amount of SOL (0.001+) for transaction fees

## How it works

On startup the plugin loads the keypair, creates an x402 client with the `ExactSvmScheme` for Solana mainnet, and replaces `globalThis.fetch` with a wrapper. Any request to `providerUrl` goes through x402 payment handling. All other requests pass through unmodified.

## License

Apache-2.0 - see [LICENSE](./LICENSE).
