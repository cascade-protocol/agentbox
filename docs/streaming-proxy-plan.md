# Streaming Proxy for Cheap Sonnet 4.6

## Context

BlockRun charges based on `max_tokens` ceiling, not actual usage: `max($0.001, (input_tokens * input_price/1M + max_tokens * output_price/1M) * 1.05)`. With Sonnet 4.6 at max_tokens=16384, every request costs ~$0.26 regardless of actual output. Streaming is also broken because x402 requires synchronous payment settlement.

Solution: AgentBox backend proxies Sonnet 4.6 requests directly to Anthropic, streams responses to VMs, and settles actual token costs post-facto from Squads Smart Account vaults (same pattern as Cascade Tabs).

## Architecture

```
VM (OpenClaw) --OpenAI format--> AgentBox Backend Proxy --Anthropic format--> Anthropic API
                                        |
                                  logs actual usage
                                        |
                              settlement cron (every 5min)
                                        |
                              Squads useSpendingLimit tx
                                        |
                              VM's vault USDC --> AgentBox treasury
```

VMs get two providers configured:
- **BlockRun** (x402) - cheap models (nvidia/gpt-oss-120b, etc.)
- **AgentBox proxy** - Sonnet 4.6 with streaming, billed on actual usage

## Implementation Steps

### 1. Database: Add vaults and usage_logs tables

**File: `packages/backend/src/db/schema/vaults.ts`** (new)

```ts
// vaults table
- id: uuid (uuidv7, PK)
- instanceId: uuid (FK -> instances.id, unique)
- smartAccount: text (Squads smart account pubkey)
- spendingLimit: text (spending limit PDA pubkey)
- dailyLimitMicroUsdc: integer (default 5_000_000 = $5)
- createdAt: timestamp

// usage_logs table
- id: uuid (uuidv7, PK)
- instanceId: uuid (FK -> instances.id)
- model: text
- inputTokens: integer
- outputTokens: integer
- costMicroUsdc: integer (actual cost in micro USDC)
- settled: boolean (default false)
- settledAt: timestamp (nullable)
- createdAt: timestamp
```

Register in `packages/backend/src/db/schema/index.ts`.

### 2. Environment: Add new env vars

**File: `packages/backend/src/lib/env.ts`** - add:
- `ANTHROPIC_API_KEY` (required)
- `EXECUTOR_PRIVATE_KEY` (required, base58 Solana keypair for Squads settlement)
- `TREASURY_WALLET` (required, pubkey where settled USDC goes)
- `ANTHROPIC_MARKUP_PERCENT` (optional, default 10 - markup over Anthropic cost)

**File: `.env.example`** - add corresponding entries.

### 3. Schemas: Add vault and proxy request schemas

**File: `packages/backend/src/lib/schemas.ts`** - add:
- `proxyRequestSchema` - OpenAI chat completion format (messages, model, stream, max_tokens, temperature)
- `vaultCreateResponseSchema` - transaction bytes for frontend to sign
- `vaultResponseSchema` - vault info (smartAccount, balance, dailyLimit, usedToday)

### 4. Backend Proxy: Anthropic translation + streaming

**File: `packages/backend/src/routes/proxy.ts`** (new)

`POST /api/proxy/chat/completions` - authenticated by instance's `gatewayToken` (same auth as callback):
1. Validate request (OpenAI chat completion format)
2. Look up instance by gatewayToken, verify vault exists with sufficient balance
3. Translate OpenAI messages format to Anthropic Messages API format:
   - Extract `system` messages into top-level `system` param
   - Map `model` field (e.g. "anthropic/claude-sonnet-4-6" -> "claude-sonnet-4-6")
   - Map `max_tokens` -> `max_tokens`
4. Call `https://api.anthropic.com/v1/messages` with `x-api-key` header
5. **Non-streaming**: translate Anthropic response to OpenAI format, return JSON
6. **Streaming**: translate Anthropic SSE events to OpenAI SSE format:
   - `message_start` -> emit OpenAI `chat.completion.chunk` with role
   - `content_block_delta` -> emit chunk with content delta
   - `message_delta` -> extract stop_reason, usage
   - `message_stop` -> emit `[DONE]`
7. After response completes, insert `usage_logs` row with actual input/output tokens from Anthropic's `usage` field

**Key translations:**
- Anthropic SSE: `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}`
- OpenAI SSE: `data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}`

**Cost calculation** (micro USDC):
- Sonnet 4.6: $3/M input, $15/M output
- `costMicroUsdc = Math.ceil((inputTokens * 3 + outputTokens * 15) / 1_000_000 * (1 + markup/100) * 1_000_000)`

### 5. Backend: Squads settlement

**File: `packages/backend/src/lib/squads.ts`** (new)

Port from `cascade-splits/apps/tabs/src/worker/index.ts` and `cascade-splits/packages/tabs-sdk/src/`:
- PDA derivation functions (deriveSettings, deriveSmartAccount, deriveSpendingLimit)
- `buildSettlementTransaction(vaultPubkey, spendingLimitPda, amountMicroUsdc)` - builds useSpendingLimit instruction transferring USDC from vault to treasury
- Uses `@solana/web3.js` v1 (already in AgentBox deps) and `@sqds-protocol/multisig` or inline the instruction building

**Constants** (from tabs-sdk):
- Squads program: `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`
- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Executor pubkey: matches EXECUTOR_PRIVATE_KEY

**Settlement cron** in `packages/backend/src/index.ts`:
- Run every 5 minutes via `setInterval` (register in shutdown handler)
- Query unsettled usage_logs grouped by instanceId
- For each instance: sum costs, build useSpendingLimit tx, sign with executor, send to Solana
- Mark logs as settled on success
- Log failures, retry next cycle

### 6. Backend: Vault management endpoints

**File: `packages/backend/src/routes/vaults.ts`** (new)

All endpoints authenticated by owner wallet (SIWx or existing auth pattern):

- `GET /api/instances/:id/vault` - return vault info (smart account, on-chain USDC balance via RPC, daily limit, today's usage from usage_logs)
- `POST /api/instances/:id/vault` - build unsigned transaction for vault creation:
  1. createSmartAccount instruction (owner = user wallet)
  2. addSpendingLimitAsAuthority instruction (executor as authority, USDC mint, daily limit)
  3. Return serialized unsigned tx for frontend to sign + send
  4. After frontend confirms tx succeeded, store vault record in DB
- `POST /api/instances/:id/vault/confirm` - frontend calls after signing vault creation tx, backend verifies on-chain and stores vault record
- `GET /api/instances/:id/vault/usage` - return usage_logs for this instance

Mount in `packages/backend/src/index.ts`.

### 7. Frontend: VaultCard component

**File: `packages/frontend/src/components/vault-card.tsx`** (new)

Displays on instance detail page (`instances.$id.tsx`), shows:
- Vault status (not created / active)
- Smart account address
- USDC balance (from GET /vault endpoint)
- Daily spending limit and today's usage
- Actions:
  - **Create Vault** button (calls POST /vault, signs returned tx with wallet)
  - **Deposit** button (standard SPL USDC transfer from user wallet to smart account ATA)
  - **Withdraw** button (builds executeTransactionSync tx to pull USDC back - same pattern as tabs)

### 8. Frontend: API client updates

**File: `packages/frontend/src/lib/api.ts`** - add:
- `api.vaults.get(instanceId)` - GET /api/instances/:id/vault
- `api.vaults.create(instanceId)` - POST /api/instances/:id/vault (returns unsigned tx)
- `api.vaults.confirmCreation(instanceId, txSignature)` - POST /api/instances/:id/vault/confirm
- `api.vaults.usage(instanceId)` - GET /api/instances/:id/vault/usage

### 9. Frontend: Instance detail page integration

**File: `packages/frontend/src/routes/instances.$id.tsx`** - add VaultCard below existing instance info section.

### 10. VM Configuration: Two providers

**File: `packages/backend/src/routes/instances.ts`** - modify `GET /api/instances/config`:
- Return two provider configs instead of one:
  ```json
  {
    "providers": [
      { "name": "blockrun", "url": "https://sol.blockrun.ai", "models": ["nvidia/gpt-oss-120b", ...] },
      { "name": "agentbox", "url": "https://<API_BASE_URL>", "models": ["anthropic/claude-sonnet-4-6"], "apiKey": "<gatewayToken>" }
    ],
    "defaultModel": "anthropic/claude-sonnet-4-6"
  }
  ```

**File: `ops/packer/agentbox-init.sh`** - modify to configure OpenClaw with two providers:
- BlockRun provider for x402 models (wallet-based payment)
- AgentBox proxy provider for Sonnet 4.6 (gatewayToken as API key, no x402)

**File: `packages/openclaw-x402/src/index.ts`** - ensure x402 plugin only intercepts BlockRun requests, not AgentBox proxy requests (check URL match).

### 11. DB Migration

After adding schema, generate and apply:
```
cd packages/backend && pnpm db:generate && pnpm db:migrate
```

## File Summary

**New files (5):**
- `packages/backend/src/db/schema/vaults.ts` - vaults + usage_logs tables
- `packages/backend/src/routes/proxy.ts` - Anthropic proxy with streaming
- `packages/backend/src/routes/vaults.ts` - vault management endpoints
- `packages/backend/src/lib/squads.ts` - Squads PDA derivation + settlement tx builder
- `packages/frontend/src/components/vault-card.tsx` - vault UI component

**Modified files (8):**
- `packages/backend/src/lib/env.ts` - add ANTHROPIC_API_KEY, EXECUTOR_PRIVATE_KEY, TREASURY_WALLET
- `packages/backend/src/lib/schemas.ts` - add proxy/vault schemas
- `packages/backend/src/db/schema/index.ts` - register new tables
- `packages/backend/src/index.ts` - mount proxy + vault routes, add settlement interval
- `packages/backend/src/routes/instances.ts` - two-provider config response
- `packages/frontend/src/lib/api.ts` - vault API methods
- `packages/frontend/src/routes/instances.$id.tsx` - add VaultCard
- `ops/packer/agentbox-init.sh` - two-provider OpenClaw config
- `.env.example` - new env vars

## Implementation Order

1. DB schema (vaults.ts) + migration
2. env.ts + schemas.ts updates
3. squads.ts (settlement logic)
4. proxy.ts (Anthropic proxy with streaming)
5. vaults.ts (vault endpoints)
6. index.ts (mount routes + settlement cron)
7. Frontend: api.ts + vault-card.tsx + instances.$id.tsx
8. instances.ts config + agentbox-init.sh (two providers)
9. Packer image rebuild (`just build-image`)

## Verification

1. **Unit test proxy translation**: Send OpenAI-format request to proxy endpoint, verify Anthropic API receives correct format
2. **Streaming test**: `curl -N` to proxy endpoint with `stream: true`, verify SSE chunks arrive in OpenAI format
3. **Vault creation**: Create vault from frontend, verify Squads smart account exists on-chain with correct spending limit
4. **Deposit**: Transfer USDC to vault, verify balance shows in frontend
5. **Settlement**: Make proxy requests, wait for settlement cron, verify USDC moved from vault to treasury on-chain
6. **End-to-end**: Provision VM with `just tunnel`, verify OpenClaw can use both BlockRun (cheap models) and AgentBox proxy (Sonnet 4.6 with streaming)
7. **Cost verification**: Compare actual Anthropic usage header tokens with logged usage_logs entries
