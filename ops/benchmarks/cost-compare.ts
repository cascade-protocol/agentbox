#!/usr/bin/env tsx
/**
 * x402 inference cost benchmark.
 *
 * Compares BlockRun, AIMO (x402) and OpenRouter (API key) across
 * DeepSeek V3.2, Kimi K2.5, MiniMax M2.5, and Sonnet 4.5.
 * Max 2 concurrent per platform. On-chain verification for x402.
 *
 * Usage: pnpm --filter @agentbox/benchmarks cost-compare -- <wallet.json>
 */

import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

try {
  process.loadEnvFile(`${import.meta.dirname}/.env`);
} catch {}

interface Target {
  provider: string;
  type: "x402" | "apikey";
  baseUrl: string;
  modelId: string;
  model: string;
  maxTokens?: number;
  scenarios?: string[];
}

interface Scenario {
  tag: string;
  label: string;
  messages: Array<{ role: string; content: string }>;
}

interface CallResult {
  tag: string;
  scenario: string;
  provider: string;
  model: string;
  type: string;
  modelId: string;
  maxTok: number;
  ms: number;
  txSig?: string | null;
  error?: string;
  inTok?: number;
  outTok?: number;
  rsnTok?: number;
  finish?: string;
  returnedModel?: string;
  calcCost?: number | null;
  usdc?: number | null;
  cost?: number | null;
}

const WALLET_PATH = process.argv[2] || process.env.WALLET_PATH;
if (!WALLET_PATH) {
  console.error("Missing wallet path. Pass as argument or set WALLET_PATH in ops/benchmarks/.env");
  process.exit(1);
}

const DEFAULT_MAX_TOKENS = 4096;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CONCURRENCY = 2;
const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!OR_KEY) {
  console.error("Missing OPENROUTER_API_KEY. Set it in ops/benchmarks/.env");
  process.exit(1);
}

// OpenRouter per-1M-token pricing
const OR_PRICING: Record<string, { input: number; output: number }> = {
  "deepseek/deepseek-v3.2": { input: 0.25, output: 0.4 },
  "moonshotai/kimi-k2.5": { input: 0.45, output: 2.2 },
  "minimax/minimax-m2.5": { input: 0.295, output: 1.2 },
  "anthropic/claude-sonnet-4.5": { input: 3.0, output: 15.0 },
};

// -- Scenarios ---------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    tag: "short",
    label: "Short (~30 tok)",
    messages: [{ role: "user", content: "What is x402?" }],
  },
  {
    tag: "medium",
    label: "Medium (~300 tok)",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant that explains blockchain and web3 concepts clearly and concisely.",
      },
      { role: "user", content: "Can you explain what the x402 protocol is?" },
      {
        role: "assistant",
        content:
          "x402 is a payment protocol that uses the HTTP 402 Payment Required status code to enable machine-to-machine micropayments. When a client makes a request to an x402-enabled API, the server responds with payment details, the client signs a crypto transaction, and then retries with proof of payment.",
      },
      {
        role: "user",
        content:
          "How does it compare to traditional API key billing? What are the advantages for AI inference specifically?",
      },
    ],
  },
  {
    tag: "long",
    label: "Long (~800 tok)",
    messages: [
      {
        role: "system",
        content:
          "You are a senior blockchain architect reviewing payment protocols for AI infrastructure. Give detailed, technical analysis.",
      },
      {
        role: "user",
        content:
          "I'm evaluating payment protocols for our AI inference platform. We need to support pay-per-request billing for LLM APIs. Can you compare x402 with traditional approaches?",
      },
      {
        role: "assistant",
        content:
          "Great question. Traditional API billing typically uses prepaid credits or monthly subscriptions with API keys for authentication. The x402 protocol takes a fundamentally different approach by embedding payment into the HTTP request/response cycle itself. Here's the flow: 1) Client sends a request to the API endpoint. 2) Server responds with HTTP 402 and a payment requirement specifying the amount, token, and network. 3) Client's wallet signs the payment transaction on-chain. 4) Client retries the request with the payment receipt in the header. 5) Server verifies the payment and processes the request. The key advantages for AI inference are: no accounts or API keys needed, instant settlement, permissionless access, and the ability for AI agents to autonomously pay for compute. The main trade-off is latency - each request requires an on-chain transaction.",
      },
      {
        role: "user",
        content:
          "What about the cost overhead? If each request needs a blockchain transaction, doesn't the gas fee eat into the economics, especially for cheap models like DeepSeek where inference might cost fractions of a cent?",
      },
      {
        role: "assistant",
        content:
          "You've identified the key economic tension. On Solana, transaction fees are roughly $0.00025, which is manageable even for cheap inference. On Ethereum L1, gas would kill the economics entirely. That's why x402 implementations focus on Solana and L2s like Base. For DeepSeek at $0.34/M output tokens, a 4K token response costs about $0.0014 in inference plus $0.00025 in gas - the gas overhead is about 18%. For expensive models like Claude, gas is negligible relative to the $15/M output cost.",
      },
      {
        role: "user",
        content:
          "Makes sense. Now can you give me a concrete recommendation on which x402 provider to use for a mix of DeepSeek and Kimi K2.5 workloads? Consider both cost and reliability.",
      },
    ],
  },
];

// -- Targets -----------------------------------------------------------------

const TARGETS: Target[] = [
  // BlockRun (x402)
  {
    provider: "BlockRun",
    type: "x402",
    baseUrl: "https://sol.blockrun.ai/api/v1",
    modelId: "deepseek/deepseek-chat",
    model: "DeepSeek",
  },
  {
    provider: "BlockRun",
    type: "x402",
    baseUrl: "https://sol.blockrun.ai/api/v1",
    modelId: "moonshot/kimi-k2.5",
    model: "Kimi K2.5",
  },
  {
    provider: "BlockRun",
    type: "x402",
    baseUrl: "https://sol.blockrun.ai/api/v1",
    modelId: "minimax/minimax-m2.5",
    model: "MiniMax M2.5",
  },
  {
    provider: "BlockRun",
    type: "x402",
    baseUrl: "https://sol.blockrun.ai/api/v1",
    modelId: "anthropic/claude-sonnet-4.5",
    model: "Sonnet 4.5",
    maxTokens: 2048,
    scenarios: ["short", "long"],
  },

  // AIMO (x402)
  {
    provider: "AIMO",
    type: "x402",
    baseUrl: "https://beta.aimo.network/api/v1",
    modelId: "deepseek/deepseek-v3.2",
    model: "DeepSeek",
  },
  {
    provider: "AIMO",
    type: "x402",
    baseUrl: "https://beta.aimo.network/api/v1",
    modelId: "moonshot/kimi-k2.5",
    model: "Kimi K2.5",
  },
  {
    provider: "AIMO",
    type: "x402",
    baseUrl: "https://beta.aimo.network/api/v1",
    modelId: "minimax/minimax-m2.5",
    model: "MiniMax M2.5",
  },
  {
    provider: "AIMO",
    type: "x402",
    baseUrl: "https://beta.aimo.network/api/v1",
    modelId: "anthropic/claude-sonnet-4.5",
    model: "Sonnet 4.5",
    maxTokens: 2048,
    scenarios: ["short", "long"],
  },

  // OpenRouter (API key)
  {
    provider: "OpenRouter",
    type: "apikey",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "deepseek/deepseek-v3.2",
    model: "DeepSeek",
  },
  {
    provider: "OpenRouter",
    type: "apikey",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "moonshotai/kimi-k2.5",
    model: "Kimi K2.5",
  },
  {
    provider: "OpenRouter",
    type: "apikey",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "minimax/minimax-m2.5",
    model: "MiniMax M2.5",
  },
  {
    provider: "OpenRouter",
    type: "apikey",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "anthropic/claude-sonnet-4.5",
    model: "Sonnet 4.5",
    maxTokens: 2048,
    scenarios: ["short", "long"],
  },
];

// -- Setup x402 --------------------------------------------------------------

const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(WALLET_PATH, "utf-8"))),
);
const x402cli = new x402Client();
x402cli.register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", new ExactSvmScheme(signer));
const x402Fetch = wrapFetchWithPayment(globalThis.fetch, x402cli);

// -- Semaphore ---------------------------------------------------------------

interface SemaphoreState {
  n: number;
  q: Array<() => void>;
}

const sems = new Map<string, SemaphoreState>();

function acquire(key: string): Promise<void> {
  if (!sems.has(key)) sems.set(key, { n: 0, q: [] });
  const s = sems.get(key) as SemaphoreState;
  if (s.n < CONCURRENCY) {
    s.n++;
    return Promise.resolve();
  }
  return new Promise((r) => s.q.push(r));
}

function release(key: string): void {
  const s = sems.get(key) as SemaphoreState;
  s.q.length ? s.q.shift()?.() : s.n--;
}

// -- Single call -------------------------------------------------------------

async function runCall(target: Target, scenario: Scenario): Promise<CallResult> {
  const maxTok = target.maxTokens || DEFAULT_MAX_TOKENS;
  const tag = `${target.model}@${target.provider}/${scenario.tag}`;
  const url = `${target.baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model: target.modelId,
    messages: scenario.messages,
    max_tokens: maxTok,
    stream: false,
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.type === "apikey") headers.Authorization = `Bearer ${OR_KEY}`;
  const fetcher = target.type === "x402" ? x402Fetch : globalThis.fetch;

  await acquire(target.provider);
  const start = Date.now();
  try {
    const res = await fetcher(url, { method: "POST", headers, body });
    const ms = Date.now() - start;

    let txSig: string | null = null;
    if (target.type === "x402") {
      const ph = res.headers.get("payment-response");
      if (ph)
        try {
          txSig = JSON.parse(Buffer.from(ph, "base64").toString()).transaction;
        } catch {}
    }

    if (!res.ok) {
      console.log(`  [${tag}] ERROR ${res.status} (${ms}ms)`);
      await res.text();
      return {
        tag,
        scenario: scenario.label,
        provider: target.provider,
        model: target.model,
        type: target.type,
        modelId: target.modelId,
        maxTok,
        ms,
        txSig,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();
    const u = data.usage || {};
    const inTok = u.prompt_tokens || 0;
    const outTok = u.completion_tokens || 0;
    const rsnTok = u.reasoning_tokens || 0;
    const finish = data.choices?.[0]?.finish_reason || "?";
    const returnedModel = data.model || "?";

    let calcCost: number | null = null;
    const pricing = OR_PRICING[target.modelId];
    if (pricing) calcCost = (inTok * pricing.input + outTok * pricing.output) / 1_000_000;

    console.log(
      `  [${tag}] ${inTok}in/${outTok}out${rsnTok ? `/${rsnTok}rsn` : ""} finish=${finish} (${ms}ms)`,
    );
    return {
      tag,
      scenario: scenario.label,
      provider: target.provider,
      model: target.model,
      type: target.type,
      modelId: target.modelId,
      maxTok,
      ms,
      txSig,
      inTok,
      outTok,
      rsnTok,
      finish,
      returnedModel,
      calcCost,
    };
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`  [${tag}] FAIL (${ms}ms): ${String(err).substring(0, 80)}`);
    return {
      tag,
      scenario: scenario.label,
      provider: target.provider,
      model: target.model,
      type: target.type,
      modelId: target.modelId,
      maxTok,
      ms,
      error: String(err).substring(0, 120),
    };
  } finally {
    release(target.provider);
  }
}

// -- On-chain lookup ---------------------------------------------------------

async function lookupUsdc(sig: string): Promise<number | null> {
  const res = await fetch("https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        sig,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ],
    }),
  });
  const { result: tx } = await res.json();
  if (!tx) return null;
  const ixs = [...(tx.transaction?.message?.instructions || [])];
  for (const g of tx.meta?.innerInstructions || []) ixs.push(...g.instructions);
  for (const ix of ixs) {
    if (ix.parsed?.type === "transferChecked" && ix.parsed.info.mint === USDC_MINT)
      return parseFloat(ix.parsed.info.tokenAmount.uiAmountString);
  }
  return null;
}

// -- Build jobs --------------------------------------------------------------

const jobs: Array<{ target: Target; scenario: Scenario }> = [];
for (const s of SCENARIOS) {
  for (const t of TARGETS) {
    if (t.scenarios && !t.scenarios.includes(s.tag)) continue;
    jobs.push({ target: t, scenario: s });
  }
}

console.log(`Wallet      : ${signer.address}`);
console.log(`Calls       : ${jobs.length}`);
console.log(`max_tokens  : ${DEFAULT_MAX_TOKENS} (Sonnet 4.5: 2048)`);
console.log(`Concurrency : ${CONCURRENCY} per platform\n`);

// -- Run ---------------------------------------------------------------------

const t0 = Date.now();
const results = await Promise.all(jobs.map((j) => runCall(j.target, j.scenario)));
const wall = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\nDone in ${wall}s. Verifying on-chain...\n`);

const usdcAmounts = await Promise.all(results.map((r) => (r.txSig ? lookupUsdc(r.txSig) : null)));
for (const [i, r] of results.entries()) {
  r.usdc = usdcAmounts[i];
}

// Unified cost: on-chain for x402, calculated for apikey
for (const r of results) {
  if (r.usdc != null) r.cost = r.usdc;
  else if (r.calcCost != null) r.cost = r.calcCost;
}

// -- Full table --------------------------------------------------------------

const SEP = "=".repeat(140);
console.log(SEP);
console.log(`BENCHMARK RESULTS  |  cost: on-chain USDC (x402) / usage-based (OpenRouter)`);
console.log(SEP);

const hdr =
  "Scenario".padEnd(18) +
  "Model".padEnd(14) +
  "Provider".padEnd(12) +
  "MaxTok".padStart(7) +
  "In".padStart(6) +
  "Out".padStart(6) +
  "Rsn".padStart(6) +
  "Finish".padStart(8) +
  "Cost($)".padStart(12) +
  "Latency".padStart(10) +
  "  Returned Model";
console.log(hdr);
console.log("-".repeat(hdr.length));

for (const r of results) {
  const base =
    r.scenario.padEnd(18) +
    r.model.padEnd(14) +
    r.provider.padEnd(12) +
    String(r.maxTok).padStart(7);
  if (r.error) {
    const paidNote = r.usdc != null ? ` [paid $${r.usdc.toFixed(6)}!]` : "";
    console.log(`${base}  ERR: ${r.error}${paidNote} (${r.ms}ms)`);
  } else {
    const cost = r.cost != null ? `$${r.cost.toFixed(6)}` : "?";
    console.log(
      base +
        String(r.inTok).padStart(6) +
        String(r.outTok).padStart(6) +
        String(r.rsnTok).padStart(6) +
        (r.finish ?? "").padStart(8) +
        cost.padStart(12) +
        `${r.ms}ms`.padStart(10) +
        `  ${r.returnedModel}`,
    );
  }
}

// -- Pivot -------------------------------------------------------------------

const allProviders = ["BlockRun", "AIMO", "OpenRouter"];
const allModels = [...new Set(TARGETS.map((t) => t.model))];

const fmtCell = (r: CallResult | undefined) => {
  if (!r) return "-".padStart(22);
  if (r.error) return `ERR (${(r.ms / 1000).toFixed(1)}s)`.padStart(22);
  const p = r.cost != null ? `$${r.cost.toFixed(6)}` : "$?";
  return `${p} (${(r.ms / 1000).toFixed(1)}s)`.padStart(22);
};

console.log(`\n${SEP}`);
console.log("PIVOT: Cost + latency per call");
console.log(SEP);

for (const s of SCENARIOS) {
  const sr = results.filter((r) => r.scenario === s.label);
  const get = (m: string, p: string) => sr.find((r) => r.model === m && r.provider === p);

  console.log(`\n  ${s.label}:`);
  console.log(`${"".padEnd(16)}${allProviders.map((p) => p.padStart(22)).join("")}`);
  for (const m of allModels) {
    const cells = allProviders.map((p) => fmtCell(get(m, p)));
    if (cells.every((c) => c.trim() === "-")) continue;
    console.log(`  ${m}`.padEnd(16) + cells.join(""));
  }
}

// -- Totals ------------------------------------------------------------------

const totalCost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
const ok = results.filter((r) => !r.error).length;
console.log(`\nTotal cost  : $${totalCost.toFixed(6)}`);
console.log(`Calls       : ${ok}/${results.length} succeeded`);
console.log(`Wall time   : ${wall}s`);
