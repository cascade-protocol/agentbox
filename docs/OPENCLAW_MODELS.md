# OpenClaw Model Guide for AgentBox

> Updated 2026-03-04. Sources: OpenClaw source (`src/security/audit-extra.sync.ts`), ClawRouter model catalog, SWE-rebench, FoodTruck Bench, BridgeBench, LM Arena, x402 community, Reddit (r/openclaw, r/ClaudeCode, r/ClaudeAI, r/LocalLLaMA), Twitter/X.

## What's Live

Source of truth: `packages/backend/src/lib/constants.ts`

| Provider | Model | ID | Max Out | Per-Call Cost | Role |
|----------|-------|----|---------|---------------|------|
| Blockrun | **Claude Opus 4.6** | `anthropic/claude-opus-4.6` | 2048 | ~$0.051 | Brain |
| Blockrun | **GPT-5.2** | `openai/gpt-5.2` | 2048 | ~$0.029 | Brain (budget) |
| Blockrun | **Kimi K2.5** | `moonshot/kimi-k2.5` | 4096 | ~$0.012 | **Default** worker |
| Blockrun | DeepSeek V3.2 | `deepseek/deepseek-chat` | 4096 | ~$0.002 | Ultra-cheap worker |
| Aimo | **Claude Sonnet 4.5** | `anthropic/claude-sonnet-4.5` | 2048 | ~$0.031 | Mid-price brain |
| Aimo | Claude Opus 4.6 | `anthropic/claude-opus-4.6` | 2048 | ~$0.051 | Brain (2x Blockrun price) |
| Aimo | GPT-5.2 | `openai/gpt-5.2` | 2048 | ~$0.029 | Brain |
| Aimo | Kimi K2.5 | `moonshot/kimi-k2.5` | 4096 | ~$0.012 | Worker |
| Aimo | DeepSeek V3.2 | `deepseek/deepseek-v3.2` | 4096 | ~$0.002 | Ultra-cheap worker |
| Aimo | GLM-5 | `zai-org/glm-5` | 4096 | ~$0.012 | Experimental |
| Aimo | GLM-4.7 Flash | `zai-org/glm-4.7-flash` | 4096 | ~$0.002 | Experimental |

Per-call costs are approximate (input context varies). Sonnet 4.6 is available on Blockrun but intentionally disabled - see Sonnet 4.6 notes below.

## Model Tiers

"Brain" = can independently orchestrate multi-tool workflows, recover from errors, chain tools correctly. "Worker" = executes well-scoped tasks but breaks on complex autonomous chains.

### Brains

| Model | Provider | $/M (in/out) | SWE-rebench | FoodTruck | Why |
|-------|----------|-------------|-------------|-----------|-----|
| **Claude Opus 4.6** | Blockrun | $5/$25 | 52.9% (#1) | $49.5K (#1) | Best agentic model. Multi-layer bug tracing, zero truncation issues, best prompt-injection resistance |
| **GPT-5.2 (xhigh)** | Blockrun | $1.75/$14 | 51.7% (#2) | $28K (#2) | Near-Opus on decontaminated benchmarks at 65% lower cost. Most token-efficient (14-17 steps median). Slow (5-10 min/task) |
| **Claude Sonnet 4.5** | Aimo only | $3/$15 | 47.1% (#6) | ~$1.4K | Best value brain. Token-efficient, reliable instruction following. Community consensus "sweet spot for code" (r/openclaw). Not on Blockrun |

### Workers

| Model | Provider | $/M (in/out) | SWE-rebench | Best For |
|-------|----------|-------------|-------------|----------|
| **Kimi K2.5** | Both | $0.60/$3.00 | 37.9% | Default worker. ~3x cheaper than Opus per task. #1 most-used on OpenClaw (26.6B tokens). Ceiling is Sonnet 4.5 level |
| **DeepSeek V3.2** | Both | $0.28/$0.42 | n/a | Cheapest real model. Simple queries, non-critical tasks |
| **GPT-5.2 Codex** | Blockrun | $1.75/$14 | 45.0% | Implementation worker. Faster than base GPT-5.2 but shallower. Good for executing plans made by a brain |
| **Gemini 3 Pro** | Blockrun | $2.00/$12 | 46.7% | Long-context reads (1M). Equivalent to Sonnet 4.6 on FoodTruck at 5.2x lower cost. NOT a brain - fails on autonomous loops |

### Not Recommended as Brains

| Model | Issue |
|-------|-------|
| **Sonnet 4.6** | Verbose: 3.4x more tokens than 4.5 on equivalent tasks. FoodTruck: costs 3x Opus/run, delivers 3x worse results. See detailed notes below |
| **GPT-5.2 Codex** | Implementation worker, not planner. Shallow reasoning on complex tasks |
| **Kimi K2.5** | Ceiling is Sonnet 4.5, not Opus. Uses 3x tokens as Opus on same tasks |
| **Gemini (all)** | Fast readers, not autonomous thinkers. Gemini 3 Flash loops infinitely on FoodTruck (100% of runs) |
| **MiniMax M2.5** | Structurally slow (mandatory thinking tokens + provider speed lottery 38-380 t/s). 10% on HumanEval+ when quantized |
| **GLM-5** | FoodTruck: went bankrupt Day 28. Wrote 123 memory entries, acted on none. SWE-rebench 42.1% |

## Benchmarks

### SWE-rebench (decontaminated, Jan 2026 tasks)

The most credible coding benchmark - uses continuously refreshed tasks from the prior month to prevent training contamination.

| Model | Resolved | Pass@5 | Cost/Problem |
|-------|----------|--------|-------------|
| Claude Code (Opus 4.6) | **52.9%** | **70.8%** | $3.50 |
| Claude Opus 4.6 | 51.7% | 58.3% | $0.93 |
| GPT-5.2 xhigh | 51.7% | 58.3% | $1.28 |
| GPT-5.2 medium | 51.0% | 60.4% | $0.76 |
| Claude Sonnet 4.5 | 47.1% | 60.4% | $0.94 |
| Gemini 3 Pro | 46.7% | 58.3% | $0.59 |
| Gemini 3 Flash | 46.7% | 54.2% | $0.32 |
| GPT-5.2 Codex | 45.0% | 54.2% | $0.46 |
| Kimi K2 Thinking | 43.8% | 58.3% | $0.42 |
| GLM-5 | 42.1% | 50.0% | $0.45 |
| Qwen3-Coder-Next (3B active) | 40.0% | 64.6% | $0.49 |
| MiniMax M2.5 | 39.6% | 56.3% | $0.09 |
| Kimi K2.5 | 37.9% | 50.0% | $0.18 |

Note: Sonnet 4.6, GPT-5.3 Codex, and Gemini 3.1 Pro are NOT yet evaluated on SWE-rebench.

### FoodTruck Bench (agentic business simulation)

Multi-step agentic benchmark over 30 simulated days. Tests demand forecasting, resource optimization, and long-horizon planning. 12 models tested, 8 went bankrupt.

| Model | Revenue | API Cost/Run | Notes |
|-------|---------|-------------|-------|
| Claude Opus 4.6 | $49,519 | $26.50 | Clear #1. Observe-learn-adapt loop |
| GPT-5.2 | $28,000 | - | Solid #2. Reliable |
| Claude Sonnet 4.6 | $17,426 | $22.99 | 85% of Opus cost, 35% of Opus results |
| Gemini 3 Pro | $17,236 | $4.38 | Same results as Sonnet 4.6 at 5.2x lower cost |
| Claude Sonnet 4.5 | ~$1,400 | $7.75 | Barely survived |
| GLM-5 | Bankrupt | - | Day 28. Zero adaptation despite self-awareness |
| DeepSeek V3.2 | Bankrupt | - | Day 22 |

### BridgeBench (vibe coding, Feb 2026)

| Model | Score |
|-------|-------|
| Claude Opus 4.6 | 60.1 |
| MiniMax M2.5 | 59.7 |
| GPT-5.2 Codex | 58.3 |
| Kimi K2.5 | 50.1 |
| GLM-5 | 41.5 (only 57% task completion) |

### LM Arena Coding ELO (Feb 2026)

| Rank | Model | ELO |
|------|-------|-----|
| 1 | Claude Opus 4.6 (thinking) | 1562 |
| 2 | Claude Opus 4.6 | 1538 |
| 3 | Claude Opus 4.5 (thinking) | 1537 |
| 4 | Kimi K2.5 Instant | 1523 |
| 5 | Gemini 3 Pro | 1518 |

### SWE-bench Verified (contamination-prone, use with caution)

OpenAI officially stopped evaluating on SWE-bench Verified due to flawed tests (59.4% reject correct solutions). Numbers for reference only:

| Model | Score |
|-------|-------|
| Claude Opus 4.6 | 80.8% |
| Gemini 3.1 Pro | 80.6% |
| GPT-5.2 | 80.0% |
| Claude Sonnet 4.6 | 79.6% |
| Claude Sonnet 4.5 | 77.2% |

## Sonnet 4.6 vs 4.5: Updated Assessment

Sonnet 4.6 launched Feb 17, 2026. After two weeks of community use, the verdict is split:

**Where 4.6 wins:**
- SWE-bench Verified: 79.6% vs 77.2% (+2.4pp)
- Hallucination rate: 29.7% vs 37.2% (improved, per @maksym_andr)
- ARC-AGI: 58.3% vs 13.6% (4.3x jump - reasoning breakthrough)
- FoodTruck: +771% ROI vs -31% (generational leap in agentic business reasoning)
- Large refactoring: successfully redistributed 3,200 lines of Rust across 7 files
- 1M context window (beta) vs 200K

**Where 4.6 loses:**
- Token consumption: 3.4x more output tokens on equivalent tasks (685K vs 203K on FoodTruck)
- Per-run cost: $22.99 vs $7.75 on FoodTruck (3x more expensive for same tasks)
- Instruction following: documented regression (ignores explicit style constraints 4.5 obeyed, 200 upvotes)
- Truncation: 4/5 FoodTruck runs hit max_tokens - spent 22K chars on internal deliberation with zero tool calls
- Brownfield coding: "burned a shitton of tokens and produced objectively worse results" (r/ClaudeCode, 57 upvotes)

**Our decision:** Sonnet 4.6 disabled in AgentBox. For agentic work at the same price point ($3/$15), it costs nearly as much as Opus per-run but delivers 3x worse results. Sonnet 4.5 on Aimo is the better value at that price tier.

## Provider Catalogs

### Blockrun (x402 on Solana + Base)

30+ models. USDC pay-per-request, no API keys or accounts.

**Models we use:**

| Model | ID | $/M (in/out) | Context | Audit |
|-------|----|-------------|---------|-------|
| Claude Opus 4.6 | `anthropic/claude-opus-4.6` | $5/$25 | 200K | Clean |
| GPT-5.2 | `openai/gpt-5.2` | $1.75/$14 | 400K | Clean |
| GPT-5.2 Codex | `openai/gpt-5.2-codex` | $1.75/$14 | 128K | Clean |
| Kimi K2.5 | `moonshot/kimi-k2.5` | $0.60/$3.00 | 262K | Clean |
| DeepSeek V3.2 | `deepseek/deepseek-chat` | $0.28/$0.42 | 128K | Clean |
| Gemini 3 Pro | `google/gemini-3-pro-preview` | $2.00/$12 | 1M | Clean |

**Available but not enabled:**

| Model | ID | $/M (in/out) | Why Not |
|-------|----|-------------|---------|
| Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | $3/$15 | Verbose, worse value than Sonnet 4.5 on Aimo |
| Opus 4.5 | `anthropic/claude-opus-4.5` | $5/$25 | Superseded by 4.6 at same price |
| Sonnet 4 | `anthropic/claude-sonnet-4` | $3/$15 | WARN audit (below Claude 4.5) |
| Haiku 4.5 | `anthropic/claude-haiku-4.5` | $1/$5 | WARN audit (Haiku tier) |
| GPT-OSS 120B | `nvidia/gpt-oss-120b` | FREE | CRITICAL audit (120B params), wrong tool schemas |
| MiniMax M2.5 | `minimax/minimax-m2.5` | $0.30/$1.20 | Structurally slow, 10% coding when quantized |

### Aimo (x402 on Solana)

161 models via beta.aimo.network. Providers: red-pill, novita-ai, atlas-cloud.

**Key differentiators from Blockrun:**

| Model | Blockrun | Aimo | Notes |
|-------|---------|------|-------|
| Claude Sonnet 4.5 | Not available | $3/$15 | **Aimo exclusive** - fills the mid-price brain gap |
| Claude Opus 4.6 | $5/$25 | $10/$37.50 | Blockrun 2x cheaper |
| Claude Sonnet 4.6 | $3/$15 | $2.40/$12 | Aimo 20% cheaper |
| DeepSeek V3.2 | $0.28/$0.42 | $0.23/$0.34 | Aimo ~19% cheaper |
| GLM-5 | Not available | $1.02/$2.98 | Aimo exclusive. SWE-rebench 42.1%. Unproven |
| GLM-4.7 Flash | Not available | $0.09/$0.37 | Aimo exclusive. Budget tool-calling worker |

Pattern: Aimo gives 20% discounts on mid-tier models but charges 2x premiums on high-end (Opus 4.6, Gemini Pro). The critical differentiator is **Sonnet 4.5 availability**.

## OpenClaw Security Audit

From `src/security/audit-extra.sync.ts` - three model checks:

| Severity | Check | Rule | Flagged Models |
|----------|-------|------|----------------|
| **CRITICAL** | `models.small_params` | <300B params + sandbox off or web tools on | GPT-OSS 120B, GPT-OSS 20B, any `Nb` model where N<300 |
| **WARN** | `models.weak_tier` | Below GPT-5 or below Claude 4.5, or Haiku | GPT-4.x, GPT-4o, Claude Sonnet 4, Claude Haiku 4.5 |
| **WARN** | `models.legacy` | Deprecated families | GPT-3.5, Claude 2/Instant, GPT-4-0314/0613 |

**Code checks:**
- `isGpt5OrHigher`: `/\bgpt-5(?:\b|[.-])/i`
- `isClaude45OrHigher`: `/\bclaude-[^\s/]*?(?:-4-?(?:[5-9]|[1-9]\d)\b|4\.(?:[5-9]|[1-9]\d)\b|-[5-9](?:\b|[.-]))/i`
- `SMALL_MODEL_PARAM_B_MAX = 300`
- Haiku: `/\bhaiku\b/i` (flagged regardless of params)

**Mitigation for small models:** `sandbox.mode="all"` AND `tools.deny=["group:web","browser"]` downgrades `models.small_params` from CRITICAL to INFO.

**Current AgentBox lineup: 0 audit flags.** All models in constants.ts pass all three checks.

## Operational Notes

### ClawRouter Routing Bug (Mar 4, 2026)

If users install ClawRouter (`blockrun/auto`), simple prompts get routed to cheap models that can't handle OpenClaw's always-agentic tool calling. A file creation request like "create memory.md" gets classified as SIMPLE and routed to a model that refuses to use tools. Fix is in progress (force agentic tiers when API request contains tools). Workaround: `/model anthropic/claude-opus-4.6` to lock to a specific model.

### Known Model Issues

| Model | Issue |
|-------|-------|
| Opus 4.6 | ~$5/complex-ticket. Peak-hour quality degradation (elevated errors observed Mar 4). CSS !important spiral loops. Uncontrolled filesystem exploration burns context |
| GPT-5.2 | Slow (5-10 min/task on xhigh). Arrogant personality in chat mode (not relevant for agent use) |
| Kimi K2.5 | Tool calling unreliable when routed through ClawRouter. Works fine when used directly |
| Sonnet 4.5 | Only on Aimo - if Aimo has downtime, no fallback for this model |
| GLM-5 | Performance varies by time of day on cloud API. Zero sustained agentic usage reports |
| DeepSeek V3.2 | Went bankrupt Day 22 on FoodTruck. Don't use for autonomous multi-step tasks |

### Dropout Pattern (r/openclaw, 97 upvotes)

The #1 reason for OpenClaw user dropout is cost spiraling from leaving Opus as default. Recommended: use a cheap default (Kimi K2.5) and escalate to Opus only for complex tasks. This is how AgentBox is currently configured.

## Models to Avoid

| Model | Why |
|-------|-----|
| GPT-OSS 120B | CRITICAL audit (120B params). Wrong tool schemas in OpenClaw |
| Any Haiku | WARN audit. Explicitly flagged regardless of params |
| GPT-4.x family | WARN audit (below GPT-5) |
| GPT-3.5 / Claude 2 / Instant | Legacy, obsolete |
| Qwen 2.5 Coder | Returns tool calls as JSON text, doesn't actually call tools in OpenClaw |
| 7B/13B local models | Can't orchestrate multi-agent workflows |
| Sonnet 4.6 as primary brain | Verbose (3.4x tokens), near-Opus cost/run, 3x worse agentic results |
| MiniMax M2.5 | Structurally slow, 10% coding accuracy when quantized, provider speed lottery |

## What to Consider Next

### High-value additions

| Model | Provider | $/M (in/out) | Why |
|-------|----------|-------------|-----|
| **GPT-5.3 Codex** | Blockrun (if available) | TBD | Purpose-built for agentic coding. 77.3% Terminal-Bench (#1). 25% faster than GPT-5.2 Codex. GA rollout paused for reliability - monitor |
| **Gemini 3 Pro** | Blockrun | $2/$12 | Already available. Same FoodTruck results as Sonnet 4.6 at 5.2x lower cost. 1M context. Good for long-context reads. Would replace the Gemini gap in our lineup |
| **Gemini 3.1 Pro** | Blockrun (if available) | $2/$12 | 80.6% SWE-bench Verified. 7.5x cheaper input than Opus. Monitor availability |

### Key insight: scaffolding > model

Meta/Harvard research (SWE-Bench Pro, Feb 2026): Sonnet 4.5 with good scaffolding (52.7%) outperformed Opus 4.5 under worse scaffolding (52%). Agent framework quality matters as much as raw model capability. Invest in better prompts, tool configs, and agent workflows before upgrading models.

### Pricing disruption: Alibaba Coding Plan

Alibaba Cloud launched a $3/month coding plan with 18,000 requests bundling Qwen 3.5+, Kimi K2.5, GLM-5, and MiniMax M2.5 (2,840 likes on announcement). Not directly usable via x402 but signals downward price pressure on open-source model APIs.
