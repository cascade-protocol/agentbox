# BlockRun Pricing: Advertised vs Actual

> Data collected 2026-02-24 from `https://sol.blockrun.ai` (Solana mainnet endpoint).

## TL;DR

- The `/models` endpoint advertises **per-million-token** rates (input/output).
- The actual x402 payment is a **flat upfront charge** based on `max_tokens` you set in the request, regardless of how many tokens the model actually generates.
- Formula: `max($0.001, (input_tokens * input_price/1M + max_tokens * output_price/1M) * 1.05)`
- The 1.05x is BlockRun's **5% platform fee**.
- There is a **$0.001 minimum** per request.
- **You pay for the ceiling, not the floor.** If you set `max_tokens: 16384` and the model outputs 50 tokens, you still pay for 16384.

## Why Your Sonnet 4.6 Requests Cost ~$0.20-0.26

OpenClaw's curated model config sets `maxTokens: 16384` for Sonnet 4.6. Every request through OpenClaw sends `max_tokens: 16384` to BlockRun, so:

```
(18 input * $3/M) + (16384 output * $15/M) = $0.000054 + $0.245760 = $0.245814
With 5% fee: $0.245814 * 1.05 = $0.258105 per request
```

This is charged upfront via x402 even if the model only outputs 10 tokens.

## Complete Model Catalog (41 models)

### Advertised Pricing (from `/api/v1/models`)

Prices are per 1M tokens.

| Model | Provider | Input $/M | Output $/M | Billing |
|-------|----------|-----------|------------|---------|
| `openai/gpt-5.2` | OpenAI | $1.75 | $14.00 | paid |
| `openai/gpt-5-mini` | OpenAI | $0.25 | $2.00 | paid |
| `openai/gpt-5-nano` | OpenAI | $0.05 | $0.40 | paid |
| `openai/gpt-5.2-pro` | OpenAI | $21.00 | $168.00 | paid |
| `openai/gpt-5.2-codex` | OpenAI | $1.75 | $14.00 | paid |
| `openai/gpt-4.1` | OpenAI | $2.00 | $8.00 | paid |
| `openai/gpt-4.1-mini` | OpenAI | $0.40 | $1.60 | paid |
| `openai/gpt-4.1-nano` | OpenAI | $0.10 | $0.40 | paid |
| `openai/gpt-4o` | OpenAI | $2.50 | $10.00 | paid |
| `openai/gpt-4o-mini` | OpenAI | $0.15 | $0.60 | paid |
| `openai/o1` | OpenAI | $15.00 | $60.00 | paid |
| `openai/o1-mini` | OpenAI | $1.10 | $4.40 | paid |
| `openai/o3` | OpenAI | $2.00 | $8.00 | paid |
| `openai/o3-mini` | OpenAI | $1.10 | $4.40 | paid |
| `openai/o4-mini` | OpenAI | $1.10 | $4.40 | paid |
| `anthropic/claude-haiku-4.5` | Anthropic | $1.00 | $5.00 | paid |
| `anthropic/claude-sonnet-4.6` | Anthropic | $3.00 | $15.00 | paid |
| `anthropic/claude-sonnet-4` | Anthropic | $3.00 | $15.00 | paid |
| `anthropic/claude-opus-4.5` | Anthropic | $5.00 | $25.00 | paid |
| `anthropic/claude-opus-4.6` | Anthropic | $5.00 | $25.00 | paid |
| `google/gemini-3.1-pro-preview` | Google | $2.00 | $12.00 | paid |
| `google/gemini-3-pro-preview` | Google | $2.00 | $12.00 | paid |
| `google/gemini-3-flash-preview` | Google | $0.50 | $3.00 | paid |
| `google/gemini-2.5-pro` | Google | $1.25 | $10.00 | paid |
| `google/gemini-2.5-flash` | Google | $0.30 | $2.50 | paid |
| `google/gemini-2.5-flash-lite` | Google | $0.10 | $0.40 | paid |
| `deepseek/deepseek-chat` | DeepSeek | $0.28 | $0.42 | paid |
| `deepseek/deepseek-reasoner` | DeepSeek | $0.28 | $0.42 | paid |
| `xai/grok-3` | xAI | $3.00 | $15.00 | paid |
| `xai/grok-3-mini` | xAI | $0.30 | $0.50 | paid |
| `xai/grok-4-1-fast-reasoning` | xAI | $0.20 | $0.50 | paid |
| `xai/grok-4-1-fast-non-reasoning` | xAI | $0.20 | $0.50 | paid |
| `xai/grok-4-fast-reasoning` | xAI | $0.20 | $0.50 | paid |
| `xai/grok-4-fast-non-reasoning` | xAI | $0.20 | $0.50 | paid |
| `xai/grok-code-fast-1` | xAI | $0.20 | $1.50 | paid |
| `xai/grok-4-0709` | xAI | $3.00 | $15.00 | paid |
| `xai/grok-2-vision` | xAI | $2.00 | $10.00 | paid |
| `moonshot/kimi-k2.5` | Moonshot | $0.60 | $3.00 | paid |
| `minimax/minimax-m2.5` | MiniMax | $0.30 | $1.20 | paid |
| `nvidia/gpt-oss-120b` | NVIDIA | $0.00 | $0.00 | **free** |
| `nvidia/kimi-k2.5` | NVIDIA | $0.60 | $3.00 | paid |

### Actual x402 Payment per Request

Tested with a minimal prompt (~18 input tokens). Amount is the USDC charged upfront via x402.

| Model | max_tokens=1024 | max_tokens=4096 | max_tokens=16384 |
|-------|-----------------|-----------------|------------------|
| `openai/gpt-5.2` | $0.0151 | $0.0602 | $0.2409 |
| `openai/gpt-5-mini` | $0.0022 | $0.0086 | $0.0344 |
| `openai/gpt-5-nano` | $0.0010* | $0.0017 | $0.0069 |
| `openai/gpt-5.2-pro` | $0.1810 | $0.7229 | $2.8918 |
| `openai/gpt-5.2-codex` | $0.0151 | $0.0602 | $0.2409 |
| `openai/gpt-4.1` | $0.0086 | $0.0344 | $0.1378 |
| `openai/gpt-4.1-mini` | $0.0017 | $0.0069 | $0.0275 |
| `openai/gpt-4.1-nano` | $0.0010* | $0.0017 | $0.0069 |
| `openai/gpt-4o` | $0.0108 | $0.0431 | $0.1722 |
| `openai/gpt-4o-mini` | $0.0010* | $0.0026 | $0.0103 |
| `openai/o1` | $0.0648 | $0.2583 | $1.0325 |
| `openai/o1-mini` | $0.0048 | $0.0189 | $0.0757 |
| `openai/o3` | $0.0086 | $0.0344 | $0.1378 |
| `openai/o3-mini` | $0.0048 | $0.0189 | $0.0757 |
| `openai/o4-mini` | $0.0048 | $0.0189 | $0.0757 |
| `anthropic/claude-haiku-4.5` | $0.0054 | $0.0215 | $0.0860 |
| `anthropic/claude-sonnet-4.6` | **$0.0162** | **$0.0646** | **$0.2581** |
| `anthropic/claude-sonnet-4` | $0.0162 | $0.0646 | $0.2581 |
| `anthropic/claude-opus-4.5` | $0.0270 | $0.1076 | $0.4302 |
| `anthropic/claude-opus-4.6` | $0.0270 | $0.1076 | $0.4302 |
| `google/gemini-3.1-pro-preview` | $0.0129 | $0.0516 | $0.2066 |
| `google/gemini-3-pro-preview` | $0.0129 | $0.0516 | $0.2066 |
| `google/gemini-3-flash-preview` | $0.0032 | $0.0129 | $0.0516 |
| `google/gemini-2.5-pro` | $0.0108 | $0.0430 | $0.1722 |
| `google/gemini-2.5-flash` | $0.0027 | $0.0108 | $0.0430 |
| `google/gemini-2.5-flash-lite` | $0.0010* | $0.0017 | $0.0069 |
| `deepseek/deepseek-chat` | $0.0010* | $0.0018 | $0.0072 |
| `deepseek/deepseek-reasoner` | $0.0010* | $0.0018 | $0.0072 |
| `xai/grok-3` | $0.0162 | $0.0646 | $0.2581 |
| `xai/grok-3-mini` | $0.0010* | $0.0022 | $0.0086 |
| `xai/grok-4-1-fast-reasoning` | $0.0010* | $0.0022 | $0.0086 |
| `xai/grok-4-1-fast-non-reasoning` | $0.0010* | $0.0022 | $0.0086 |
| `xai/grok-4-fast-reasoning` | $0.0010* | $0.0022 | $0.0086 |
| `xai/grok-4-fast-non-reasoning` | $0.0010* | $0.0022 | $0.0086 |
| `xai/grok-code-fast-1` | $0.0016 | $0.0065 | $0.0258 |
| `xai/grok-4-0709` | $0.0162 | $0.0646 | $0.2581 |
| `xai/grok-2-vision` | $0.0108 | $0.0430 | $0.1722 |
| `moonshot/kimi-k2.5` | $0.0032 | $0.0129 | $0.0516 |
| `minimax/minimax-m2.5` | $0.0013 | $0.0052 | $0.0207 |
| `nvidia/gpt-oss-120b` | **$0.0000** | **$0.0000** | **$0.0000** |
| `nvidia/kimi-k2.5` | $0.0032 | $0.0129 | $0.0516 |

`*` = $0.001 minimum per request applies (formula result was lower)

### Scaling: Sonnet 4.6 Cost by max_tokens

To show exactly how `max_tokens` drives cost:

| max_tokens | Actual x402 Cost | Notes |
|------------|-----------------|-------|
| 10 | $0.001 | minimum floor |
| 100 | $0.0016 | |
| 1,000 | $0.0158 | |
| 4,096 | $0.0646 | |
| 8,192 | $0.1291 | |
| 16,384 | $0.2581 | OpenClaw default for this model |

## Pricing Formula

```
cost = max($0.001, (input_tokens * input_price_per_M / 1,000,000
                   + max_tokens * output_price_per_M / 1,000,000) * 1.05)
```

Where:
- `input_tokens` = estimated from your prompt (BlockRun counts ~18 tokens for "Say hi" with message formatting)
- `max_tokens` = the `max_tokens` field in your request (NOT actual output)
- `input_price_per_M` / `output_price_per_M` = from the `/models` endpoint
- `1.05` = BlockRun's 5% platform fee
- `$0.001` = minimum charge per request

## Key Implications

1. **Set `max_tokens` as low as practical.** If you only need a short answer, use `max_tokens: 256` instead of letting it default to 16384.

2. **When `max_tokens` is omitted**, BlockRun defaults to 1024 output tokens. But OpenClaw overrides this with the model's configured `maxTokens` from CURATED_MODELS.

3. **No refund for unused tokens.** You pay the full `max_tokens` price even if the model stops at 3 tokens.

4. **The advertised $/M rates are technically correct** but deeply misleading when the billing is prepaid on max capacity rather than actual consumption.

5. **Cheapest options** for when cost matters:
   - `nvidia/gpt-oss-120b` - free, 131K context
   - `deepseek/deepseek-chat` - $0.001 minimum at low max_tokens
   - `xai/grok-4-1-fast-*` - $0.001 minimum, very cheap at scale
   - `openai/gpt-5-nano` - $0.001 minimum

6. **Most expensive per request** (at max_tokens=16384):
   - `openai/gpt-5.2-pro` - $2.89
   - `openai/o1` - $1.03
   - `anthropic/claude-opus-4.6` - $0.43
   - `anthropic/claude-sonnet-4.6` - $0.26

## How to Verify

```bash
# Get the 402 response for any model
curl -s -D - -o /dev/null https://sol.blockrun.ai/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4.6","messages":[{"role":"user","content":"test"}],"max_tokens":4096}'

# Decode the payment-required header (base64 JSON)
echo "<base64-from-payment-required-header>" | base64 -d | python3 -m json.tool

# The "amount" field is in USDC base units (6 decimals)
# amount=64569 means $0.064569 USDC
```
