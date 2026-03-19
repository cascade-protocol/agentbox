# OpenClaw Model Guide

> Updated 2026-03-19. Sources: OpenClaw source, PinchBench, SWE-rebench, FoodTruck Bench, BridgeBench, Artificial Analysis Coding Index, Kilo Bench, LM Arena, x402 community, Reddit (r/openclaw, r/ClaudeCode, r/LocalLLaMA), Twitter/X.

## Model Tiers

"Brain" = can independently orchestrate multi-tool workflows, recover from errors, chain tools correctly. "Worker" = executes well-scoped tasks but breaks on complex autonomous chains.

### Brains

| Model | $/M (in/out) | Why |
|-------|-------------|-----|
| **Claude Opus 4.6** | $5/$25 | Best agentic model. 1M context (GA). Multi-layer bug tracing, best prompt-injection resistance. Found 22 Firefox vulns in Mozilla partnership |
| **GPT-5.2 (xhigh)** | $1.75/$14 | Near-Opus on decontaminated benchmarks at 65% lower cost. Most token-efficient (14-17 steps median). Slow (5-10 min/task). Being superseded by GPT-5.4 for single tasks |
| **Claude Sonnet 4.6** | $3/$15 | 1M context (GA). FoodTruck +771% ROI vs Sonnet 4.5's -31%. But 3.4x more output tokens than 4.5 - see model notes below |
| **Claude Sonnet 4.5** | $3/$15 | Best value brain for token-efficient work. Reliable instruction following. Community consensus "sweet spot for code" (r/openclaw) |

### Workers

| Model | $/M (in/out) | Why |
|-------|-------------|-----|
| **GPT-5.4** | $2.50/$15 | Frontier benchmarks but unreliable as autonomous brain in OpenClaw. Best as executor paired with Opus as orchestrator. See model notes below |
| **Kimi K2.5** | $0.60/$3.00 | Default worker. #1 most-used on OpenClaw (26.6B tokens). DHH's daily driver at 200 tps. 1T params, 32B active. Ceiling is Sonnet 4.5, not Opus |
| **MiniMax M2.7** | $0.30/$1.20 | Self-evolving RL model (Mar 18). SWE-Pro 56.22%. Near-frontier at 1/10th frontier price. Replacing M2.5 upstream (OpenClaw PR #50355) |
| **GLM-5** | $1.02/$2.98 | 744B/40B active (MoE). MIT license. Strong on scoped tasks but zero sustained agentic adaptation (FoodTruck bankrupt Day 28) |
| **Grok 4.1 Fast** | ~$0.20/$1.50 | Best-in-class tool calling, 2M context window. Good for agentic workflows needing many tool calls |
| **DeepSeek V3.2** | $0.28/$0.42 | Cheapest real model. Simple queries, non-critical tasks. 671B/37B active |
| **Gemini 3.1 Pro** | $2.00/$12 | Long-context reads (1M). ARC-AGI-2 77.1% (#1). GPQA Diamond 94.3% (#1). But FoodTruck regression vs Gemini 3 Pro |
| **Qwen3-Coder-Next** | $0.12/$0.75 | Only 3B active params (80B total MoE). Runs on consumer hardware. Apache 2.0 |

## Benchmarks

### Scorecard

Four benchmarks that each test something different: SWE-rebench (decontaminated coding, gold standard), PinchBench (scoped OpenClaw agent tasks, shown at NVIDIA GTC), FoodTruck (30-day agentic business simulation, 8/12 models went bankrupt), SWE-bench Verified (being retired due to contamination - reference only).

| Model | $/M (in/out) | SWE-rebench | PinchBench | FoodTruck | SWE-V† |
|-------|-------------|-------------|------------|-----------|--------|
| Claude Opus 4.6 | $5/$25 | **51.7%** | 90.6% | **$49.5K** | 80.8% |
| GPT-5.4 | $2.50/$15 | - | 86.4% | - | - |
| GPT-5.2 (xhigh) | $1.75/$14 | 51.7% | - | $28K | 80.0% |
| Claude Sonnet 4.6 | $3/$15 | - | - | $17.4K | 79.6% |
| Claude Sonnet 4.5 | $3/$15 | 47.1% | **92.7%** | ~$1.4K | 77.2% |
| Gemini 3.1 Pro | $2/$12 | - | 91.7% | $12.7K | 80.6% |
| Gemini 3 Pro | $2/$12 | 46.7% | - | $17.2K | - |
| GLM-5 | $1.02/$2.98 | 42.1% | 86.4% | Bankrupt D28 | 77.8% |
| Kimi K2.5 | $0.60/$3 | 37.9% | **93.4%** | - | 76.8% |
| MiniMax M2.7 | $0.30/$1.20 | - | 86.2% | - | - |
| MiniMax M2.5 | $0.30/$1.20 | 39.6% | - | - | 80.2%† |
| Qwen3-Coder-Next | $0.12/$0.75 | 40.0% | - | - | 70.6% |
| DeepSeek V3.2 | $0.28/$0.42 | - | - | Bankrupt D22 | - |

† SWE-bench Verified is being retired (59.4% reject correct solutions). M2.5 scores 80.2% on SWE-V but only 39.6% on SWE-rebench - a 40pp gap highlighting contamination.

**Not yet evaluated on SWE-rebench:** Sonnet 4.6, GPT-5.4, GPT-5.3 Codex, Gemini 3.1 Pro, MiniMax M2.7. SWE-rebench V2 launched Feb 27 (Nebius AI) with 32K+ tasks across 20 languages.

**PinchBench note:** Results are inverted from SWE-rebench - cheaper/faster models (Kimi 93.4%, Sonnet 4.5 92.7%) outscore expensive "brains" (Opus 90.6%, GPT-5.4 86.4%). PinchBench measures scoped task execution, not deep autonomous reasoning. Additional PinchBench scores: Gemini 3 Flash Preview 95.1%, Nemotron 3 Super 85.6%.

**FoodTruck note:** Sonnet 4.6 at $17.4K (+771% ROI) is a generational leap over Sonnet 4.5's ~$1.4K (-31% ROI), but costs $22.99/run vs $7.75. Gemini 3.1 Pro ($12.7K) regressed 26% vs Gemini 3 Pro ($17.2K) - diagnosed food waste 30 times, never changed behavior.

### Other Benchmarks

- **AA Coding Index (Mar 2026):** GPT-5.4 57, Gemini 3.1 Pro 56, Claude Opus 4.6 48, Grok 4.20 Beta 42
- **LM Arena Coding ELO:** Opus 4.6 (thinking) 1562, Opus 4.6 1538, Opus 4.5 (thinking) 1537, Kimi K2.5 1523, Gemini 3.1 Pro 1518. GPT-5.4 took #1 overall ELO (Mar 6) but Claude 4.6 leads coding-specific
- **BridgeBench (vibe coding):** Opus 4.6 60.1, M2.5 59.7, GPT-5.2 Codex 58.3, Kimi K2.5 50.1, GLM-5 41.5
- **Kilo Bench (89 autonomous tasks):** Qwen3.5-plus 49%, M2.7 47%. Oracle picking best model per task solves 67% vs 49% single-best. "No model is interchangeable - they're complementary"
- **SWE-rebench scaffolded:** Claude Code (Opus 4.6) 52.9%/70.8% Pass@5 at $3.50/problem - scaffolding adds +1.2pp over raw Opus

## Operational Notes

### Known Model Issues

| Model | Issue |
|-------|-------|
| Opus 4.6 | ~$5/complex-ticket. 529 errors reported Mar 18-19 (widespread r/ClaudeCode reports). CSS !important spiral loops. Uncontrolled filesystem exploration burns context |
| GPT-5.2 | Slow (5-10 min/task on xhigh) |
| Kimi K2.5 | Tool calling unreliable through some routers. Works fine when used directly |
| GLM-5 | Performance varies by time of day on cloud API |
| MiniMax M2.7 | Just released (Mar 18) - limited production data |
| DeepSeek V3.2 | Tool call errors on some providers (OpenClaw issue #50401) |

### Cost Management

The #1 reason for OpenClaw user dropout is cost spiraling from leaving Opus as default (r/openclaw, 97 upvotes). Recommended: use a cheap default (Kimi K2.5) and escalate to Opus only for complex tasks. Popular workflow from r/ClaudeCode (43 upvotes): Opus for planning, Sonnet for implementation.

### OpenClaw Release Cadence

Shipping near-daily: 7 releases in March alone (v2026.3.2 through v2026.3.13). Passed React on GitHub stars (324K+). Key recent additions: GPT-5.4 support (with WebSocket phase parameter fix), pluggable context engines, per-model cooldown with stepped backoff.

## Models to Avoid

| Model | Why |
|-------|-----|
| GPT-OSS 120B | CRITICAL audit (<300B params). Wrong tool schemas in OpenClaw |
| Any Haiku | WARN audit. Explicitly flagged regardless of params |
| GPT-4.x family | WARN audit (below GPT-5) |
| GPT-3.5 / Claude 2 / Instant | Legacy, obsolete |
| Qwen 2.5 Coder | Returns tool calls as JSON text, doesn't actually call tools in OpenClaw |
| 7B/13B local models | Can't orchestrate multi-agent workflows (r/openclaw: llama3:8b, deepseek-r1:7b/14b/32b don't support tool calling) |
| MiniMax M2.5 as primary | Being replaced by M2.7. Training data controversy. 88% hallucination rate on AA-Omniscience |

## Model Notes

### Sonnet 4.6 vs 4.5

Sonnet 4.6 launched Feb 17, 2026. After a month of community use, the picture is clearer than the initial two-week verdict:

**Where 4.6 wins:** FoodTruck +771% ROI vs -31% (generational leap). 1M context GA (March 13). ARC-AGI 58.3% vs 13.6% (4.3x). SWE-V 79.6% vs 77.2%. Hallucination rate 29.7% vs 37.2%. Document Arena #2 (top 3 all Anthropic).

**Where 4.6 loses:** 3.4x more output tokens (685K vs 203K on FoodTruck). $22.99/run vs $7.75 (3x more expensive). Instruction following regression (200 upvotes). 4/5 FoodTruck runs hit max_tokens. r/ClaudeCode still split on which is "smarter."

**Verdict:** Genuine upgrade for complex agentic tasks, but ~3x cost per-run due to verbosity. For token-efficient scoped work, 4.5 remains better value.

### GPT-5.4: Strong Model, Broken Agentic Experience

On paper it's frontier: SWE-Bench Pro 57.7%, OSWorld 75.0% (above human baseline), AA Coding Index #1 (57), Toolathlon 54.6%. Native computer use, 1M context, sub-agent architecture with Mini/Nano.

In practice, it does NOT work reliably as an autonomous brain in OpenClaw (as of March 19):

**Critical OpenClaw bugs (all OPEN):** `max_tokens` vs `max_completion_tokens` param mismatch (#49173). OAuth scope missing for subagents (#49138). Context stuck at 272K instead of 1M (#42225). Silent session termination on long tool calls (#48213). Subagent model override ignored (#43768). Compaction fails for gpt-5.4-pro (#38120).

**Behavioral issues (model-level):** Fabricated completion (claims done when not). Excessive irrelevant tool calls (30M tokens of logs, r/openclaw). Over-interprets system prompt restrictions vs Claude (#43256). Scope creep (adds unrequested features). Context degradation beyond ~256K. Prompt leaking.

**Where it excels:** Single-shot coding, code review (catches bugs Opus misses), physics/3D work, cost efficiency (4-5x cheaper than Opus), computer use (75% OSWorld).

**Emerging pattern:** Opus 4.6 as brain + GPT-5.4 as executor (r/ClaudeCode, 130 upvotes). Re-evaluate once OpenClaw stabilizes support - many bugs are harness-level, not model-level.

## What to Consider Next

| Model | $/M (in/out) | Why |
|-------|-------------|-----|
| **DeepSeek V4** | ~$0.14/$0.28 (expected) | Expected any day (FT reported "first week of March" but still not released). ~1T params, ~32B active, 1M context, native multimodal. Optimized for Huawei Ascend |
| **MiMo-V2-Pro (Xiaomi)** | ~$1.00/M | Revealed as "Hunter Alpha" mystery model topping OpenRouter. SWE-bench 78.0%, 1M context. Open-source release teased (85 upvotes on r/LocalLLaMA) |
| **NVIDIA Nemotron 3 Super** | Open | 120B/12B active (MoE). PinchBench 85.6% (best open model per NVIDIA GTC). 1M context. Runs on ~64GB RAM |
| **Kimi K2.7** | TBD | Mentioned in early access. "K2.5 is the current holy grail. K2.7 may be better, but I'm still waiting on private access" |
| **Qwen3.5-27B** | cheap | Dense model. r/LocalLLaMA: "almost good enough to replace a subscription for day-to-day coding." Strong local option |

### Key insight: scaffolding > model

Meta/Harvard research (SWE-Bench Pro, Feb 2026): Sonnet 4.5 with good scaffolding (52.7%) outperformed Opus 4.5 under worse scaffolding (52%). Kilo Bench confirms: oracle model selection solves 67% vs 49% for best single model. Agent framework quality matters as much as raw model capability.