# OpenClaw Model Guide for AgentBox

> Research compiled 2026-02-24 from OpenClaw source code, Blockrun model catalog, GitHub discussions, Reddit community (r/openclaw, r/clawdbot, r/myclaw, r/ClaudeAI, r/ClaudeCode, r/codex, r/LocalLLaMA), and Twitter/X discourse. All claims are sourced from sustained multi-week usage reports, not first impressions.

## Model Classification: Brains vs Workers

The most important distinction for OpenClaw agentic use. "Brains" can independently orchestrate complex multi-tool workflows, take initiative, recover from errors, and chain tools correctly. "Workers" can execute well-scoped tasks but fall apart on complex multi-step chains.

### Brains (can run autonomous agentic loops)

Only three models qualify based on sustained community validation:

| Model | Availability | Cost (in/out $/M) | Strengths | Weaknesses |
|-------|-------------|-------------------|-----------|------------|
| **Claude Opus 4.6** | Blockrun | $5/$25 | Undisputed #1. Leads every agentic benchmark (SWE-rebench 52.9%, FoodTruck $49K). Multi-layer bug tracing across 3+ abstraction layers. Best prompt-injection resistance | ~$5/ticket. Quality fluctuates at peak hours. "Confident wrong loops" (CSS !important spirals). Uncontrolled filesystem exploration burns limits despite CLAUDE.md constraints |
| **Claude Sonnet 4.5** | **aimo.network only** (not on Blockrun) | $3/$15 | Best value brain. Reliable instruction following. Token-efficient. r/openclaw consensus "real sweet spot for code" | Not available on Blockrun. Older gen - may be deprecated |
| **GPT-5.2 (base, xhigh)** | Blockrun | $1.75/$14 | "Bulletproof" - zero task redos reported. Best one-pass correctness. Handles 1.5M LoC legacy codebases. Most token-efficient (14-17 steps median) | Slow (5-10 min/task). Arrogant/adversarial personality in chat mode (doesn't affect agent use). Hallucinates when given file attachments in chat mode |

### NOT Brains (despite marketing/hype)

| Model | Why Not |
|-------|---------|
| **Claude Sonnet 4.6** | Verbose token furnace. Averages 22K output tokens/day in agentic sim where other models write ~1K. Costs nearly as much as Opus in practice due to verbosity. Instruction following regressed from 4.5 (documented: ignores explicit style constraints 4.5 obeyed). "Lazy search" pattern - skips web search and hallucinates instead. FoodTruck bench: only 10% cheaper than Opus per run but delivers 3x worse results ($17.4K vs $49.5K) |
| **GPT-5.2 Codex** | Implementation worker, not a planner. "Hammer it in" fixes that break other things. "Incredibly lazy" on complex/domain-specific tasks - "does 1 out of 10 tasks then calls it a day". Good server-side compaction but shallow reasoning. Community workflow: plan with GPT-5.2 base, implement with Codex |
| **Kimi K2.5** | Ceiling is Sonnet 4.5 level - "roughly on par with Sonnet 4.5... definitely not Opus level in terms of agentic function" (136 upvotes). Uses 3x the tokens as Opus for same tasks. On reasoning-heavy tasks can be 89% MORE expensive than Opus. Absent from FoodTruck agentic benchmark entirely. Good budget default, not a brain |
| **Gemini (all variants)** | Fast readers, not autonomous thinkers. Gemini 3 Flash Thinking gets stuck in infinite decision loops (100% of runs in FoodTruck bench). Require heavy SOUL.md prompting to function. Tool integration rated below GLM-4.7 in direct comparison. Good for "look at large context" tasks, bad for "figure out what tools to chain" |
| **MiniMax M2.5** | Slow due to mandatory interleaved thinking + provider speed lottery (38-380 t/s depending on upstream). Provider speed varies 10x. FP8 on AMD is broken (known vLLM bug). "Lacks systems understanding" for deep tasks |
| **GLM-5** | Days old, zero sustained usage reports. Failed/refused to engage in FoodTruck agentic bench. NOT cheap - actually more expensive than Kimi K2.5 on OpenRouter. Z.AI had GPU starvation at launch |
| **GLM-4.7-Flash** | Tool calling works via API, but daily driver users switched to Kimi K2.5 and found it "definitely better". Local inference plagued by hallucination/repetition |

### The Brain Gap on Blockrun

This is AgentBox's key constraint:

| Brain | On Blockrun? | Notes |
|-------|-------------|-------|
| Claude Opus 4.6 | Yes | $5/$25 - expensive, burns USDC fast |
| Claude Sonnet 4.5 | **No** | Only on aimo.network ($3/$15). Best value brain unavailable on our payment rail |
| GPT-5.2 (xhigh) | Yes | $1.75/$14 - good price but slow (5-10 min/task) |

Blockrun has Sonnet 4.6 ($3/$15) but the research shows it's a worse brain than Sonnet 4.5 due to verbosity and instruction-following regression. There is no good mid-price brain on Blockrun today.

## Security Audit Tiers

OpenClaw's `security audit` command (`src/security/audit-extra.sync.ts`) defines three hard boundaries for model safety:

| Severity | Check | Threshold | What Gets Flagged |
|----------|-------|-----------|-------------------|
| **CRITICAL** | `models.small_params` | <300B params + sandbox off or web tools on | Any model with extractable param count below 300B (e.g. `70b`, `120b`) without `sandbox.mode="all"` and web tools disabled |
| **WARN** | `models.weak_tier` | Below GPT-5 or Claude 4.5, or any Haiku | GPT-4o, GPT-4.1, GPT-4 Turbo, Claude Sonnet 4, any `haiku` model |
| **WARN** | `models.legacy` | Deprecated families | GPT-3.5, Claude 2, Claude Instant, legacy GPT-4 snapshots (0314/0613) |

### Concrete Code Checks

- `isGpt5OrHigher` - model ID must match `gpt-5` prefix or above
- `isClaude45OrHigher` - model ID must match `claude-*-4-5` or higher (4.6, 5.x, etc.)
- `SMALL_MODEL_PARAM_B_MAX = 300` - anything under 300B params is flagged
- Haiku tier - any model matching `/\bhaiku\b/i` is explicitly flagged regardless of params
- Legacy patterns: `/\bgpt-3\.5\b/i`, `/\bclaude-(instant|2)\b/i`, `/\bgpt-4-(0314|0613)\b/i`

### Mitigation for Small Models

Setting `sandbox.mode="all"` AND `tools.deny=["group:web","browser"]` downgrades `models.small_params` from CRITICAL to INFO. All other checks remain as WARN.

## Blockrun Model Catalog (42 models)

Full catalog from `blockrun.ai/models` and `BlockRunAI/ClawRouter` source. Prices are per 1M tokens. See `BLOCKRUN_PRICING.md` for actual x402 per-request costs.

### OpenAI (15 models)

| Model | ID | In $/M | Out $/M | Context | Reasoning | Vision | Agentic | Audit |
|-------|----|--------|---------|---------|-----------|--------|---------|-------|
| GPT-5.2 | `openai/gpt-5.2` | $1.75 | $14.00 | 400K | Yes | Yes | Yes | Clean |
| GPT-5.2 Pro | `openai/gpt-5.2-pro` | $21.00 | $168.00 | 400K | Yes | - | - | Clean |
| GPT-5.2 Codex | `openai/gpt-5.2-codex` | $1.75 | $14.00 | 128K | - | - | Yes | Clean |
| GPT-5 Mini | `openai/gpt-5-mini` | $0.25 | $2.00 | 200K | - | - | - | Clean |
| GPT-5 Nano | `openai/gpt-5-nano` | $0.05 | $0.40 | 128K | - | - | - | Clean |
| GPT-4.1 | `openai/gpt-4.1` | $2.00 | $8.00 | 128K | - | Yes | - | **WARN** - below GPT-5 |
| GPT-4.1 Mini | `openai/gpt-4.1-mini` | $0.40 | $1.60 | 128K | - | - | - | **WARN** - below GPT-5 |
| GPT-4.1 Nano | `openai/gpt-4.1-nano` | $0.10 | $0.40 | 128K | - | - | - | **WARN** - below GPT-5 |
| GPT-4o | `openai/gpt-4o` | $2.50 | $10.00 | 128K | - | Yes | Yes | **WARN** - below GPT-5 |
| GPT-4o Mini | `openai/gpt-4o-mini` | $0.15 | $0.60 | 128K | - | - | - | **WARN** - below GPT-5 |
| o1 | `openai/o1` | $15.00 | $60.00 | 200K | Yes | - | - | Clean |
| o1-mini | `openai/o1-mini` | $1.10 | $4.40 | 128K | Yes | - | - | Clean |
| o3 | `openai/o3` | $2.00 | $8.00 | 200K | Yes | - | - | Clean |
| o3-mini | `openai/o3-mini` | $1.10 | $4.40 | 128K | Yes | - | - | Clean |
| o4-mini | `openai/o4-mini` | $1.10 | $4.40 | 128K | Yes | - | - | Clean |

### Anthropic (5 models)

| Model | ID | In $/M | Out $/M | Context | Max Out | Reasoning | Agentic | Audit |
|-------|----|--------|---------|---------|---------|-----------|---------|-------|
| Claude Opus 4.6 | `anthropic/claude-opus-4.6` | $5.00 | $25.00 | 200K | 32K | Yes | Yes | Clean |
| Claude Opus 4.5 | `anthropic/claude-opus-4.5` | $5.00 | $25.00 | 200K | 32K | Yes | Yes | Clean |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | $3.00 | $15.00 | 200K | 64K | Yes | Yes | Clean |
| Claude Sonnet 4 | `anthropic/claude-sonnet-4` | $3.00 | $15.00 | 200K | 64K | - | Yes | **WARN** - below Claude 4.5 |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | $1.00 | $5.00 | 200K | 8K | - | Yes | **WARN** - Haiku tier |

### Google (6 models)

| Model | ID | In $/M | Out $/M | Context | Reasoning | Vision | Audit |
|-------|----|--------|---------|---------|-----------|--------|-------|
| Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` | $2.00 | $12.00 | 1M+ | Yes | Yes | Clean |
| Gemini 3 Pro | `google/gemini-3-pro-preview` | $2.00 | $12.00 | 1M+ | Yes | Yes | Clean |
| Gemini 3 Flash | `google/gemini-3-flash-preview` | $0.50 | $3.00 | 1M | - | Yes | Clean |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` | $1.25 | $10.00 | 1M+ | Yes | Yes | Clean |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | $0.30 | $2.50 | 1M | - | - | Clean |
| Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | $0.10 | $0.40 | 1M | - | - | Clean |

### xAI / Grok (9 models)

| Model | ID | In $/M | Out $/M | Context | Reasoning | Audit |
|-------|----|--------|---------|---------|-----------|-------|
| Grok 3 | `xai/grok-3` | $3.00 | $15.00 | 131K | Yes | Clean |
| Grok 3 Mini | `xai/grok-3-mini` | $0.30 | $0.50 | 131K | - | Clean |
| Grok 4.1 Fast (Reasoning) | `xai/grok-4-1-fast-reasoning` | $0.20 | $0.50 | 131K | Yes | Clean |
| Grok 4.1 Fast | `xai/grok-4-1-fast-non-reasoning` | $0.20 | $0.50 | 131K | - | Clean |
| Grok 4 Fast (Reasoning) | `xai/grok-4-fast-reasoning` | $0.20 | $0.50 | 131K | Yes | Clean |
| Grok 4 Fast | `xai/grok-4-fast-non-reasoning` | $0.20 | $0.50 | 131K | - | Clean |
| Grok Code Fast | `xai/grok-code-fast-1` | $0.20 | $1.50 | 131K | - | Clean |
| Grok 4 (0709) | `xai/grok-4-0709` | $3.00 | $15.00 | 131K | Yes | Clean |
| Grok 2 Vision | `xai/grok-2-vision` | $2.00 | $10.00 | 131K | - | Clean |

### DeepSeek (2 models)

| Model | ID | In $/M | Out $/M | Context | Reasoning | Audit |
|-------|----|--------|---------|---------|-----------|-------|
| DeepSeek V3.2 Chat | `deepseek/deepseek-chat` | $0.28 | $0.42 | 128K | - | Clean |
| DeepSeek V3.2 Reasoner | `deepseek/deepseek-reasoner` | $0.28 | $0.42 | 128K | Yes | Clean |

### Moonshot (1 model)

| Model | ID | In $/M | Out $/M | Context | Reasoning | Vision | Agentic | Audit |
|-------|----|--------|---------|---------|-----------|--------|---------|-------|
| Kimi K2.5 | `moonshot/kimi-k2.5` | $0.60 | $3.00 | 262K | Yes | Yes | Yes | Clean |

### MiniMax (1 model)

| Model | ID | In $/M | Out $/M | Context | Reasoning | Agentic | Audit |
|-------|----|--------|---------|---------|-----------|---------|-------|
| MiniMax M2.5 | `minimax/minimax-m2.5` | $0.30 | $1.20 | 205K | Yes | Yes | Clean |

### NVIDIA-Hosted (2 models)

| Model | ID | In $/M | Out $/M | Context | Audit |
|-------|----|--------|---------|---------|-------|
| GPT-OSS 120B (free) | `nvidia/gpt-oss-120b` | FREE | FREE | 128K | **CRITICAL** - 120B params |
| Kimi K2.5 (NVIDIA) | `nvidia/kimi-k2.5` | $0.55 | $2.50 | 262K | Clean |

## AgentBox Baked-In Model Selection

### Current (problematic)

| Model | ID | Default? | Audit |
|-------|----|----------|-------|
| GPT-OSS 120B | `nvidia/gpt-oss-120b` | **YES** | **CRITICAL** |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | - | Clean |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | - | **WARN** - Haiku |
| MiniMax M2.5 | `minimax/minimax-m2.5` | - | Clean |
| DeepSeek V3.2 | `deepseek/deepseek-chat` | - | Clean |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | - | Stale (3.x available) |
| GPT-4.1 Mini | `openai/gpt-4.1-mini` | - | **WARN** - below GPT-5 |

3 of 7 models trigger audit warnings/criticals. Default is the worst offender.

### Recommended (0 audit flags, BS-filtered)

| Model | ID on Blockrun | Cost (in/out $/M) | Role | Why |
|-------|----------------|-------------------|------|-----|
| **Kimi K2.5** | `nvidia/kimi-k2.5` | $0.55/$2.50 | **Default** (worker) | Sonnet 4.5-level ceiling. Honest 3x savings over Opus (not 10x). Good enough for most routine tasks. NVIDIA variant cheaper than Moonshot |
| DeepSeek V3.2 | `deepseek/deepseek-chat` | $0.28/$0.42 | Ultra-cheap worker | Cheapest real model. Good for simple queries |
| Gemini 3 Flash | `google/gemini-3-flash-preview` | $0.50/$3.00 | Fast reader + long context | 1M context. Good for "look at this and answer". NOT a brain - don't use for autonomous loops |
| **Claude Opus 4.6** | `anthropic/claude-opus-4.6` | $5/$25 | **Brain** (best available on Blockrun) | Undisputed #1 for complex multi-tool chaining. Only use for tasks that justify the cost |
| **GPT-5.2** | `openai/gpt-5.2` | $1.75/$14 | **Brain** (budget alternative) | Bulletproof one-pass correctness. Slow but reliable. Best for large/legacy codebases |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | $3/$15 | Fallback (use with caution) | Available but NOT recommended as primary brain. Verbose token furnace, worse instruction following than 4.5. Include only because Sonnet 4.5 is not on Blockrun |

### Changes from Current

| Action | Model | Reason |
|--------|-------|--------|
| Remove | `nvidia/gpt-oss-120b` | CRITICAL audit, community reports wrong tool schemas |
| Remove | `anthropic/claude-haiku-4.5` | WARN audit, Haiku tier explicitly flagged |
| Remove | `openai/gpt-4.1-mini` | WARN audit, below GPT-5 threshold |
| Remove | `google/gemini-2.5-flash` | Stale gen, replaced by 3 Flash |
| Remove | `minimax/minimax-m2.5` | Slow - mandatory reasoning overhead + provider speed lottery (38-380 t/s). FP8 on AMD broken (vLLM bug). "Lacks systems understanding" |
| Add | `nvidia/kimi-k2.5` | New default worker - honest Sonnet 4.5-level capability at budget price |
| Add | `anthropic/claude-opus-4.6` | Brain tier - best available on Blockrun |
| Add | `openai/gpt-5.2` | Brain tier - bulletproof, slow but correct |
| Add | `google/gemini-3-flash-preview` | Replaces 2.5 Flash for long-context reads |
| Default | `gpt-oss-120b` -> `kimi-k2.5` | Free-but-broken -> cheap-but-works |

### Missing: The Sonnet 4.5 Gap

Claude Sonnet 4.5 is the best value brain - reliable instruction following, token-efficient, community-validated as "the real sweet spot for code." It is NOT on Blockrun. It IS on beta.aimo.network at $3/$15 (actually $2.40/$12 via atlas-cloud provider). Aimo uses a different payment model (not x402/Solana), so integrating it would require a second payment rail.

Until Blockrun adds Sonnet 4.5 or aimo integration is built, AgentBox users have a brain gap: Opus 4.6 ($5/$25, expensive) or GPT-5.2 ($1.75/$14, slow). No mid-price brain.

## Reddit Reality Check (Feb 2026)

### OpenRouter Rankings - What They Actually Mean

The "most used on OpenRouter" rankings reflect price and free-tier availability, NOT quality:

> "No surprise, OpenRouter users are more likely to lean into Free and/or cheap models." - r/LocalLLaMA, 47 upvotes

> "This reminds me of when Elon was touting how Grok Code-fast-1 was the top coding model by tokens and entirely ignoring that they were giving it away 100% for free." - r/LocalLLaMA

Rankings are a volume metric driven by economics, not a quality signal.

### Sonnet 4.5 vs 4.6: The Research

Sonnet 4.6 launched Feb 17, 2026. After one week of community use:

**Token efficiency:** 4.6 is dramatically more verbose. FoodTruck agentic bench: 4.6 averages 22K output tokens/day where other models write ~1K. Users report 1-2 features before hitting session limits vs 4-5 features with 4.5.

**Instruction following:** Documented regression. In a controlled test: 4.5 followed "no em-dashes" instruction, 4.6 ignores it (200 upvotes, 83% ratio). Multiple OpenClaw users confirm CLAUDE.md/SOUL.md compliance is worse in 4.6.

**Hallucination:** 4.6 fabricated a CLI flag then retracted it. "Lazy search" pattern documented: skips web search and hallucinates instead of spending tokens on a search call. "The hallucination rate is so much worse than 4.5" (r/ClaudeAI).

**Cost reality:** FoodTruck bench - 4.6 costs only 10% less than Opus per agentic run ($23 vs $26.50) due to verbosity, but delivers 3x worse results ($17.4K vs $49.5K).

**Where 4.6 genuinely wins:** Breadth-first code review (found more issues than Opus in one benchmark). Browser automation at 5.5x lower cost than Opus. "Sticks to the script" better than Opus for well-defined agent roles.

**Community verdict:** r/openclaw $254-in-16-days user anchors on Sonnet 4.5 as "the real sweet spot for code." r/ClaudeCode: "4.6 burned a shitton of tokens and produced objectively worse results... I switched back to 4.5 now" (57 upvotes).

### Kimi K2.5: Deflating the Hype

Top comment on the #1-on-OpenRouter hype post (372 upvotes): "If I had a nickel for every time someone claimed the newest OSS SOTA model was similar to Claude, I could generate a few prompts."

**Token reality:** Uses 3x the tokens as Opus for same tasks. On reasoning-heavy tasks: 89% MORE expensive than Opus ($0.87 vs $0.46 per chess game).

**Capability ceiling:** "Roughly on par with Sonnet 4.5... definitely not Opus level in terms of agentic function" (136 upvotes). Best positive sustained report: 150M tokens across 3 projects in a week with no issues - but from a single user.

**Honest value:** ~3x cheaper than Opus in real task cost (not 10x as marketed). Good default worker, not a brain.

### MiniMax M2.5: The Speed Problem

Slow responses are not perception - they're structural:

1. **Mandatory interleaved thinking:** Every response generates invisible reasoning tokens first. No non-thinking variant exists. Structural latency floor.
2. **Provider speed lottery:** 10x spread between fastest (SambaNova 380 t/s) and slowest (Parasail 38 t/s). No visibility into which upstream Blockrun uses.
3. **FP8 on AMD broken:** Known vLLM bug (Issue #31475, still open). FP8 is 20-50% slower than BF16 on AMD MI300X. MiniMax weights ship in FP8 by default.
4. **"37% faster" is misleading:** Refers to fewer agentic steps per task, not tokens per second.

### GLM-5: Not Ready

- Days old, zero sustained usage reports
- SWE-rebench: 42.1% (behind Kimi K2 Thinking at 43.8%, well behind Opus at 52.9%)
- Failed/refused to engage in FoodTruck agentic bench
- NOT cheap - more expensive than Kimi K2.5 on OpenRouter
- OpenRouter rankings for GLM family reflect cheaper prior-gen models, not GLM-5 itself
- Z.AI had GPU starvation at launch, pulled access from Pro subscribers

### GPT-5.2: The Quiet Powerhouse

- "Bulletproof" - users report zero task redos with xhigh reasoning effort
- Handles 1.5M LoC legacy codebases where "any model that is not Regular 5.2 xHigh struggles"
- Most token-efficient: 14-17 steps median vs much more for Claude/Gemini
- Slow (5-10 min/task) but correct
- GPT-5.2 Codex is a worker variant - faster but shallower, "hammer it in" fixes. Community workflow: plan with 5.2 base, implement with Codex, review with 5.2 base

### Claude Opus 4.6: The Real #1

- Leads every agentic benchmark: SWE-rebench 52.9%, FoodTruck $49K (GPT-5.2 made $28K, 8/12 models went bankrupt)
- Multi-layer bug tracing across 3+ abstraction layers - no other model does this
- Known issues: ~$5/ticket, peak-hour quality degradation, permission system bypass (found workarounds when denied), CSS !important loops, uncontrolled filesystem exploration
- "Codex always beats Claude on benchmarks... Somehow, when it comes down to my day to day, it always ends up being Claude" (43 upvotes, r/ClaudeAI)

## Alternative Provider: aimo.network

> beta.aimo.network - 161 models, providers: red-pill, novita-ai, atlas-cloud. NOT x402/Solana - different payment model.

### Price Comparison (Overlapping Models)

Most models are identically priced. Key differences on the models we care about:

| Model | Blockrun (in/out $/M) | Aimo (in/out $/M) | Delta |
|-------|----------------------|-------------------|-------|
| Claude Sonnet 4.6 | $3.00/$15.00 | $2.40/$12.00 | **Aimo -20%** |
| Claude Sonnet 4.5 | **Not available** | $3.00/$15.00 | **Aimo exclusive** |
| Claude Opus 4.6 | $5.00/$25.00 | $10.00/$37.50 | **Blockrun 2x cheaper** |
| DeepSeek V3.2 | $0.28/$0.42 | $0.23/$0.34 | **Aimo -19%** |
| Kimi K2.5 | $0.60/$3.00 | $0.60/$3.00 | Same |
| Gemini 3 Pro | $2.00/$12.00 | $4.00/$18.00 | **Blockrun 2x cheaper** |
| GPT-5.2 | $1.75/$14.00 | $1.75/$14.00 | Same |

Pattern: aimo gives ~20% discount on some mid-tier models but charges heavy premiums on high-end (Opus 4.6 at 2x, Gemini Pro at 2x). The critical differentiator is **Sonnet 4.5 availability** - aimo has it, Blockrun doesn't.

### Aimo-Exclusive Models Worth Considering

| Model | Cost (in/out $/M) | Context | Why |
|-------|-------------------|---------|-----|
| `anthropic/claude-sonnet-4.5` | $3.00/$15.00 | 1M | **Best value brain.** The missing middle-price brain for AgentBox. Reliable instruction following, token-efficient, community-validated |
| `zai-org/glm-5` | $1.02/$2.98 | 203K | #3 on OpenRouter by volume (price-driven, not quality). SWE-rebench 42.1%. Unproven for sustained agentic use |
| `zai-org/glm-4.7-flash` | $0.09/$0.37 | 203K | Cheapest model with reliable tool calling via API. Budget worker option. Previous daily drivers switched to Kimi K2.5 |

Sonnet 4.5 is the only aimo-exclusive model that fills a real gap in our lineup. The GLM models are interesting but not validated enough to recommend.

## Models to Avoid for OpenClaw

| Model | Why |
|-------|-----|
| Any Haiku | Explicitly flagged by audit, smaller model tier |
| GPT-4.x family | Below GPT-5 audit threshold |
| GPT-3.5 | Legacy, obsolete |
| Claude 2 / Instant | Legacy, obsolete |
| Models <300B params (unsandboxed) | CRITICAL audit finding |
| Qwen 2.5 Coder | Doesn't call tools at all in OpenClaw (returns JSON as text) |
| 7B/13B local models | Can't orchestrate more than 1-3 agents |
| Claude Sonnet 4.6 as primary brain | Verbose token furnace, worse instruction following than 4.5, costs nearly as much as Opus in practice |
| MiniMax M2.5 | Structurally slow, provider speed lottery, FP8/AMD bug |

## Security Notes

From OpenClaw's `SECURITY.md`: "The model/agent is **not** a trusted principal. Assume prompt/content injection can manipulate behavior." This means model quality (resistance to prompt injection) directly affects security. Larger, instruction-hardened models from major providers are inherently more resistant.

ZeroLeaks audit data (Twitter):
- Default OpenClaw setup: scored 2/100 (84% extraction rate, 91% injection success)
- With Kimi K2.5: scored 5/100 (100% extraction rate, 70% injection success)
- Security depends on both model AND system prompt/skills configuration
