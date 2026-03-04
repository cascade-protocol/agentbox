import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { Type } from "@sinclair/typebox";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  checkAtaExists,
  getSolBalance,
  getTokenAccounts,
  getUsdcBalance,
  signAndSendPumpPortalTx,
  transferUsdc,
} from "./solana.js";
import { deriveEvmKeypair, deriveSolanaKeypair } from "./wallet.js";

const INFERENCE_RESERVE = 0.3;
const MAX_RESPONSE_CHARS = 50_000;

// Model metadata type - matches the shape in X402_PROVIDERS (constants.ts)
type ModelEntry = {
  provider: string;
  id: string;
  name: string;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
};

type ProviderConfig = {
  baseUrl: string;
  models: Array<Omit<ModelEntry, "provider">>;
};

function parseProviders(config: Record<string, unknown>): {
  models: ModelEntry[];
  x402Urls: string[];
} {
  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  const models: ModelEntry[] = [];
  const x402Urls: string[] = [];
  for (const [name, prov] of Object.entries(raw)) {
    x402Urls.push(new URL(prov.baseUrl).origin);
    for (const m of prov.models) {
      models.push({ ...m, provider: name });
    }
  }
  return { models, x402Urls };
}

// --- Transaction history ---

const HISTORY_MAX_LINES = 1000;
const HISTORY_KEEP_LINES = 500;
const HISTORY_PAGE_SIZE = 5;

type HistoryRecord = {
  t: number; // epoch ms
  k: "inference" | "x402" | "send" | "trade";
  ok: boolean;
  tx?: string; // solana signature
  ms?: number; // duration
  m?: string; // model (inference)
  in?: number; // input tokens
  out?: number; // output tokens
  c?: number; // estimated cost USD
  u?: string; // url (x402)
  s?: number; // http status
  to?: string; // recipient (send)
  amt?: number; // amount
  cur?: string; // currency
  act?: string; // buy/sell (trade)
  token?: string; // mint (trade)
  sol?: number; // SOL amount (trade)
};

function estimateCost(
  allModels: ModelEntry[],
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const model = allModels.find(
    (m) => modelId.endsWith(m.id) || modelId === m.id || modelId === `${m.provider}/${m.id}`,
  );
  if (!model) return 0;
  return (inputTokens * model.cost.input + outputTokens * model.cost.output) / 1_000_000;
}

function appendHistory(historyPath: string, record: HistoryRecord): void {
  try {
    appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
    if (existsSync(historyPath)) {
      const stat = statSync(historyPath);
      if (stat.size > HISTORY_MAX_LINES * 120) {
        const lines = readFileSync(historyPath, "utf-8").trimEnd().split("\n");
        if (lines.length > HISTORY_MAX_LINES) {
          writeFileSync(historyPath, `${lines.slice(-HISTORY_KEEP_LINES).join("\n")}\n`);
        }
      }
    }
  } catch {
    // History is non-critical - never break the plugin
  }
}

function readHistory(historyPath: string): HistoryRecord[] {
  try {
    if (!existsSync(historyPath)) return [];
    const content = readFileSync(historyPath, "utf-8").trimEnd();
    if (!content) return [];
    return content.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function calcSpend(records: HistoryRecord[]): { today: number; total: number; count: number } {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  let today = 0;
  let total = 0;
  let count = 0;
  for (const r of records) {
    if (!r.ok) continue;
    const cost = r.c ?? 0;
    total += cost;
    count++;
    if (r.t >= todayMs) today += cost;
  }
  return { today, total, count };
}

function formatTxLine(r: HistoryRecord, full: boolean): string {
  const time = new Date(r.t).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const txLink = (label: string) => (r.tx ? `[${label}](https://solscan.io/tx/${r.tx})` : label);
  const fail = r.ok ? "" : " (failed)";

  switch (r.k) {
    case "inference": {
      const model = r.m ? (full ? r.m : (r.m.split("/").pop() ?? r.m)) : "unknown";
      const cost = r.c != null ? `$${r.c.toFixed(3)} USDC` : "";
      return `\`${time}\` ${model}${fail} ${txLink(cost)}`;
    }
    case "x402": {
      let host = r.u ?? "unknown";
      try {
        if (r.u) host = new URL(r.u).hostname;
      } catch {
        // keep raw value
      }
      const cost = r.c != null ? `$${r.c.toFixed(3)} USDC` : `HTTP ${r.s ?? "?"}`;
      return `\`${time}\` \`x402\` ${host}${fail} ${txLink(cost)}`;
    }
    case "send": {
      const dest = r.to ? `\`${r.to.slice(0, 4)}...${r.to.slice(-4)}\`` : "unknown";
      const amount = r.amt != null ? `$${r.amt.toFixed(2)} USDC` : "";
      return `\`${time}\` send ${dest}${fail} ${txLink(amount)}`;
    }
    case "trade": {
      const action = r.act ?? "trade";
      const tokenShort = r.token ? r.token.slice(0, 8) : "token";
      const amount = r.sol != null ? `${r.sol} SOL` : "";
      return `\`${time}\` ${action} ${tokenShort} - pump.fun${fail} ${txLink(amount)}`;
    }
    default:
      return `\`${time}\` unknown tx`;
  }
}

// Module-level cache for token symbol resolution
const tokenSymbolCache = new Map<string, string>();

async function resolveTokenSymbols(mints: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toResolve = mints.filter((m) => {
    const cached = tokenSymbolCache.get(m);
    if (cached) {
      result.set(m, cached);
      return false;
    }
    return true;
  });
  if (toResolve.length === 0) return result;

  const settled = await Promise.allSettled(
    toResolve.map(async (mint) => {
      const res = await globalThis.fetch(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { mint, symbol: null };
      const pairs = (await res.json()) as Array<{
        baseToken?: { symbol?: string };
      }>;
      return { mint, symbol: pairs[0]?.baseToken?.symbol ?? null };
    }),
  );

  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.symbol) {
      tokenSymbolCache.set(s.value.mint, s.value.symbol);
      result.set(s.value.mint, s.value.symbol);
    }
  }
  return result;
}

function extractTxSignature(response: Response): string | undefined {
  const header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!header) return undefined;
  try {
    const decoded = decodePaymentResponseHeader(header);
    return (decoded as { transaction?: string }).transaction ?? undefined;
  } catch {
    return undefined;
  }
}

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const rawKeypairPath = (config.keypairPath as string) || "~/.openclaw/agentbox/wallet-sol.json";
  const keypairPath = rawKeypairPath.startsWith("~/")
    ? join(homedir(), rawKeypairPath.slice(2))
    : rawKeypairPath;
  const rpcUrl = (config.rpcUrl as string) || "https://api.mainnet-beta.solana.com";
  const dashboardUrl = (config.dashboardUrl as string) || "";
  const { models: allModels, x402Urls } = parseProviders(config);
  const historyPath = join(dirname(keypairPath), "history.jsonl");

  if (allModels.length === 0) {
    api.logger.error("openclaw-x402: no providers configured");
    return;
  }

  // registerProvider() only handles auth flows (OAuth, API key, device code).
  // The actual model catalog comes from models.providers in openclaw.json.
  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  for (const [name, prov] of Object.entries(raw)) {
    api.registerProvider({
      id: name,
      label: `${name} (x402)`,
      auth: [],
      models: {
        baseUrl: prov.baseUrl,
        api: "openai-completions",
        authHeader: false,
        models: prov.models as Array<
          Omit<ModelEntry, "provider"> & { input: Array<"text" | "image"> }
        >,
      },
    });
  }

  api.logger.info(
    `openclaw-x402: ${Object.keys(raw).join(", ")} - ${allModels.length} models, ${x402Urls.length} x402 endpoints`,
  );

  let walletAddress: string | null = null;
  let signerRef: KeyPairSigner | null = null;
  let x402FetchRef:
    | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | null = null;

  // --- Slash commands ---

  api.registerCommand({
    name: "x_balance",
    description: "Wallet balance, tokens, and transaction history",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!walletAddress) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }

      const args = ctx.args?.trim() ?? "";
      const parts = args.split(/\s+/).filter(Boolean);
      const full = parts.includes("full");
      const pageArg = parts.find((p) => /^\d+$/.test(p));
      const page = pageArg ? Math.max(1, Number.parseInt(pageArg, 10)) : 1;

      const records = readHistory(historyPath);
      const reversed = [...records].reverse();
      const totalTxs = reversed.length;
      const start = (page - 1) * HISTORY_PAGE_SIZE;
      const pageRecords = reversed.slice(start, start + HISTORY_PAGE_SIZE);

      if (page === 1) {
        try {
          const [{ ui }, sol, tokens] = await Promise.all([
            getUsdcBalance(rpcUrl, walletAddress),
            getSolBalance(rpcUrl, walletAddress),
            getTokenAccounts(rpcUrl, walletAddress).catch(() => []),
          ]);
          const spend = calcSpend(records);
          const lines: string[] = [
            "**Wallet**",
            `\`${walletAddress}\``,
            `SOL: ${sol} - USDC: $${ui}`,
          ];
          if (spend.today > 0) {
            lines.push(`Spent today: ~$${spend.today.toFixed(2)}`);
          }

          // Token holdings
          if (tokens.length > 0) {
            const displayTokens = tokens.slice(0, 5);
            const symbols = await resolveTokenSymbols(displayTokens.map((t) => t.mint));
            lines.push("", "**Tokens**");
            for (const t of displayTokens) {
              const sym = symbols.get(t.mint);
              const label = sym ? `$${sym}` : `\`${t.mint.slice(0, 4)}...${t.mint.slice(-4)}\``;
              const amt = Number.parseFloat(t.amount).toLocaleString("en-US", {
                maximumFractionDigits: 0,
              });
              lines.push(`${amt} ${label}`);
            }
            if (tokens.length > 5) {
              lines.push(`...and ${tokens.length - 5} more`);
            }
          }

          if (pageRecords.length > 0) {
            lines.push("", "**Recent**");
            for (const r of pageRecords) {
              lines.push(formatTxLine(r, full), "");
            }
          }

          lines.push(
            "Top up: send SOL or USDC (SPL) to the address above",
            `[View on Solscan](https://solscan.io/account/${walletAddress})`,
          );
          if (dashboardUrl) {
            lines.push(`[Open Dashboard](${dashboardUrl})`);
          }

          if (totalTxs > HISTORY_PAGE_SIZE) {
            lines.push("", `/x_balance 2 - More transactions`);
          }

          return { text: lines.join("\n") };
        } catch (err) {
          return { text: `Failed to check balance: ${String(err)}` };
        }
      }

      // Page 2+: just transactions
      if (pageRecords.length === 0) {
        return { text: "No more transactions." };
      }

      const rangeStart = start + 1;
      const rangeEnd = start + pageRecords.length;
      const lines: string[] = [`**Transactions** (${rangeStart}-${rangeEnd})`, ""];
      for (const r of pageRecords) {
        lines.push(formatTxLine(r, full), "");
      }
      if (start + HISTORY_PAGE_SIZE < totalTxs) {
        lines.push(`/x_balance ${page + 1} - More transactions`);
      }

      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "x_send",
    description: "Send USDC to a Solana address. Usage: /x_send <amount|all> <address>",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!walletAddress || !signerRef) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }

      const args = ctx.args?.trim() ?? "";
      const parts = args.split(/\s+/);
      if (parts.length !== 2) {
        return {
          text: "Usage: /x_send <amount|all> <address>\nExamples:\n  /x_send 0.5 7xKXtg...\n  /x_send all 7xKXtg...",
        };
      }

      const [amountStr, destAddr] = parts;
      if (destAddr.length < 32 || destAddr.length > 44) {
        return { text: `Invalid Solana address: ${destAddr}` };
      }

      try {
        const recipientHasAta = await checkAtaExists(rpcUrl, destAddr);
        if (!recipientHasAta) {
          return {
            text:
              "Recipient " +
              destAddr +
              " does not have a USDC token account.\n" +
              "They need to have received USDC at least once to have an account.\n" +
              "Ask them to create a USDC account first (e.g. by receiving any amount of USDC).",
          };
        }

        let amountRaw: bigint;
        let amountUi: string;
        if (amountStr.toLowerCase() === "all") {
          const balance = await getUsdcBalance(rpcUrl, walletAddress);
          if (balance.raw === 0n) {
            return { text: "Wallet has no USDC to send." };
          }
          amountRaw = balance.raw;
          amountUi = balance.ui;
        } else {
          const amount = Number.parseFloat(amountStr);
          if (Number.isNaN(amount) || amount <= 0) {
            return { text: `Invalid amount: ${amountStr}` };
          }
          amountRaw = BigInt(Math.round(amount * 1e6));
          amountUi = amount.toString();
        }

        const sig = await transferUsdc(signerRef, rpcUrl, destAddr, amountRaw);
        appendHistory(historyPath, {
          t: Date.now(),
          k: "send",
          ok: true,
          tx: sig,
          to: destAddr,
          amt: Number.parseFloat(amountUi),
          cur: "USDC",
        });
        return { text: `Sent ${amountUi} USDC to ${destAddr}\nhttps://solscan.io/tx/${sig}` };
      } catch (err) {
        appendHistory(historyPath, {
          t: Date.now(),
          k: "send",
          ok: false,
          to: destAddr,
          cur: "USDC",
        });
        const msg = String(err);
        const cause = (err as { cause?: { message?: string } }).cause?.message || "";
        const detail = cause || msg;
        if (detail.includes("insufficient") || detail.includes("lamports")) {
          return {
            text:
              "Insufficient SOL for transaction fees. Send a tiny amount of SOL to " +
              walletAddress,
          };
        }
        return { text: `Failed to send USDC: ${detail}` };
      }
    },
  });

  api.registerCommand({
    name: "x_help",
    description: "Show wallet commands and agent tools reference",
    acceptsArgs: false,
    handler: async () => ({
      text: [
        "**AgentBox Wallet**",
        "",
        "/x_balance - Balance, tokens, and recent transactions",
        "/x_balance 2 - Page 2 of transactions",
        "/x_balance full - Show full model provider paths",
        "/x_send <amount|all> <address> - Send USDC",
        "/x_models - Models and pricing",
        "/model - Browse and switch AI models",
        "/x_help - This help",
        "",
        "**Agent Tools** (used by your AI agent)",
        "x_balance - Check wallet balance",
        "x_payment - Call x402 paid APIs",
        "x_discover - Find x402 services",
        "x_trade - Buy/sell pump.fun tokens",
        "x_token_info - Token price lookup",
        "",
        "**How payments work**",
        "Your agent pays per LLM call via x402 (USDC on Solana).",
        `$${INFERENCE_RESERVE.toFixed(2)} USDC is reserved for inference and can't be spent by tools.`,
        "Top up by sending USDC or SOL to your wallet address.",
        "",
        "To update the x402 plugin, copy and send this to your agent:",
        "```Run 'openclaw plugins install openclaw-x402@latest' and restart the gateway```",
      ].join("\n"),
    }),
  });

  api.registerCommand({
    name: "x_models",
    description: "Available AI models and pricing",
    acceptsArgs: false,
    handler: async () => {
      const byProvider = new Map<string, ModelEntry[]>();
      for (const m of allModels) {
        let list = byProvider.get(m.provider);
        if (!list) {
          list = [];
          byProvider.set(m.provider, list);
        }
        list.push(m);
      }
      const lines: string[] = ["**Available Models**"];
      for (const [prov, models] of byProvider) {
        lines.push(`\n_${prov}_`);
        for (const m of models) {
          const inp = m.cost.input < 1 ? `$${m.cost.input}` : `$${m.cost.input.toFixed(0)}`;
          const out = m.cost.output < 1 ? `$${m.cost.output}` : `$${m.cost.output.toFixed(0)}`;
          const ctx = `${(m.contextWindow / 1000).toFixed(0)}K`;
          lines.push(
            `• **${m.name}** - ${inp}/${out} per 1M | ${ctx} ctx`,
            `\`/model ${prov}/${m.id}\``,
          );
        }
      }
      return { text: lines.join("\n") };
    },
  });

  // --- Agent tools ---

  api.registerTool({
    name: "x_balance",
    label: "Wallet Balance",
    description:
      "Check wallet SOL and USDC balances. Use before making payments or trades to verify sufficient funds.",
    parameters: Type.Object({}),
    async execute() {
      if (!walletAddress) {
        return {
          content: [
            { type: "text" as const, text: "Wallet not loaded yet. Wait for gateway startup." },
          ],
          details: {},
        };
      }
      try {
        const [{ ui }, sol, tokens] = await Promise.all([
          getUsdcBalance(rpcUrl, walletAddress),
          getSolBalance(rpcUrl, walletAddress),
          getTokenAccounts(rpcUrl, walletAddress).catch(() => []),
        ]);
        const total = Number.parseFloat(ui);
        const available = Math.max(0, total - INFERENCE_RESERVE);
        const records = readHistory(historyPath);
        const spend = calcSpend(records);
        const tokenLines = tokens.slice(0, 5).map((t) => {
          const short = `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
          return `${Number.parseFloat(t.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${short})`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Wallet: ${walletAddress}`,
                `SOL: ${sol} SOL`,
                `USDC: $${ui}`,
                `Available for tools: $${available.toFixed(2)}`,
                `Reserved for inference: $${INFERENCE_RESERVE.toFixed(2)}`,
                `Spent today: $${spend.today.toFixed(4)}`,
                `Total spent: $${spend.total.toFixed(4)} (${spend.count} txs)`,
                ...(tokenLines.length > 0 ? [`Tokens held: ${tokenLines.join(", ")}`] : []),
              ].join("\n"),
            },
          ],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to check balance: ${String(err)}` }],
          details: {},
        };
      }
    },
  });

  api.registerTool({
    name: "x_payment",
    label: "x402 Payment",
    description:
      "Call an x402-enabled paid API endpoint with automatic USDC payment on Solana. " +
      "Use this when you need to call a paid service discovered via x_discover or given by the user. " +
      `Note: $${INFERENCE_RESERVE.toFixed(2)} USDC is reserved for LLM inference and cannot be spent by this tool.`,
    parameters: Type.Object({
      url: Type.String({ description: "The x402-enabled endpoint URL" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default: GET)" })),
      params: Type.Optional(
        Type.String({
          description:
            "For GET: query params as JSON object. For POST/PUT/PATCH: JSON request body.",
        }),
      ),
      headers: Type.Optional(Type.String({ description: "Custom HTTP headers as JSON object" })),
    }),
    async execute(_id, params) {
      if (!walletAddress || !x402FetchRef) {
        return {
          content: [
            { type: "text" as const, text: "Wallet not loaded yet. Wait for gateway startup." },
          ],
          details: {},
        };
      }

      try {
        const { ui } = await getUsdcBalance(rpcUrl, walletAddress);
        if (Number.parseFloat(ui) <= INFERENCE_RESERVE) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Insufficient funds. Balance: $${ui}, reserved for inference: $${INFERENCE_RESERVE.toFixed(2)}. Top up wallet: ${walletAddress}`,
              },
            ],
            details: {},
          };
        }
      } catch {
        // If balance check fails, proceed anyway
      }

      const method = (params.method || "GET").toUpperCase();
      let url = params.url;
      const reqInit: RequestInit = { method };

      if (params.headers) {
        try {
          reqInit.headers = JSON.parse(params.headers) as Record<string, string>;
        } catch {
          return {
            content: [{ type: "text" as const, text: "Invalid headers JSON." }],
            details: {},
          };
        }
      }

      if (params.params) {
        if (method === "GET" || method === "HEAD") {
          try {
            const qp = JSON.parse(params.params) as Record<string, string>;
            const qs = new URLSearchParams(qp).toString();
            url = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
          } catch {
            return {
              content: [{ type: "text" as const, text: "Invalid params JSON for GET request." }],
              details: {},
            };
          }
        } else {
          reqInit.body = params.params;
          reqInit.headers = {
            "Content-Type": "application/json",
            ...(reqInit.headers as Record<string, string> | undefined),
          };
        }
      }

      const toolStartMs = Date.now();
      try {
        const response = await x402FetchRef(url, reqInit);
        const body = await response.text();

        if (response.status === 402) {
          appendHistory(historyPath, {
            t: Date.now(),
            k: "x402",
            ok: false,
            u: url,
            s: 402,
            ms: Date.now() - toolStartMs,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Payment failed (402): ${body.substring(0, 500)}. Wallet: ${walletAddress}`,
              },
            ],
            details: {},
          };
        }

        appendHistory(historyPath, {
          t: Date.now(),
          k: "x402",
          ok: true,
          u: url,
          s: response.status,
          ms: Date.now() - toolStartMs,
          tx: extractTxSignature(response),
        });

        const truncated =
          body.length > MAX_RESPONSE_CHARS
            ? `${body.substring(0, MAX_RESPONSE_CHARS)}\n\n[Truncated - response was ${body.length} chars]`
            : body;

        return {
          content: [{ type: "text" as const, text: `HTTP ${response.status}\n\n${truncated}` }],
          details: {},
        };
      } catch (err) {
        appendHistory(historyPath, {
          t: Date.now(),
          k: "x402",
          ok: false,
          u: params.url,
        });
        const msg = String(err);
        const text =
          msg.includes("Simulation failed") || msg.includes("insufficient")
            ? `Payment failed - insufficient funds. Wallet: ${walletAddress}. Error: ${msg}`
            : `Request failed: ${msg}`;
        return { content: [{ type: "text" as const, text }], details: {} };
      }
    },
  });

  api.registerTool({
    name: "x_discover",
    label: "x402 Discover",
    description:
      "Search for x402-enabled paid APIs in the zauth verified provider directory. " +
      "Use this to find services the user needs - weather, trading signals, blockchain data, AI agents, etc.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Search keyword (e.g. 'trending tokens', 'weather', 'trading')",
        }),
      ),
      network: Type.Optional(
        Type.String({ description: "Filter by blockchain network (e.g. 'solana', 'base')" }),
      ),
      verified: Type.Optional(
        Type.Boolean({ description: "Only show verified endpoints (default: false)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results to return (default: 10)" })),
    }),
    async execute(_id, params) {
      const url = new URL("https://back.zauthx402.com/api/directory");
      if (params.query) url.searchParams.set("search", params.query);
      if (params.network) url.searchParams.set("network", params.network);
      if (params.verified) url.searchParams.set("verified", "true");
      url.searchParams.set("limit", String(params.limit || 10));

      try {
        const res = await globalThis.fetch(url.toString());
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Directory returned HTTP ${res.status}: ${await res.text()}`,
              },
            ],
            details: {},
          };
        }
        const data = await res.text();
        const truncated =
          data.length > MAX_RESPONSE_CHARS
            ? `${data.substring(0, MAX_RESPONSE_CHARS)}\n\n[Truncated]`
            : data;
        return {
          content: [{ type: "text" as const, text: truncated }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to search directory: ${String(err)}` }],
          details: {},
        };
      }
    },
  });

  api.registerTool({
    name: "x_trade",
    label: "Pump.fun Trade",
    description:
      "Buy or sell pump.fun tokens. Buy spends SOL to get tokens, sell converts tokens back to SOL.",
    parameters: Type.Object({
      action: Type.Unsafe<"buy" | "sell">({
        type: "string",
        enum: ["buy", "sell"],
        description: "buy = spend SOL to get tokens, sell = sell tokens for SOL",
      }),
      mint: Type.String({ description: "Token mint address" }),
      amount: Type.Number({
        description:
          "For buy: SOL amount to spend (e.g. 0.1). For sell: percentage of held tokens to sell (e.g. 50 for 50%, 100 for all)",
      }),
      slippage: Type.Optional(
        Type.Number({ description: "Slippage tolerance in % (default: 25)" }),
      ),
    }),
    async execute(_id, params) {
      if (!signerRef) {
        return {
          content: [
            { type: "text" as const, text: "Wallet not loaded yet. Wait for gateway startup." },
          ],
          details: {},
        };
      }

      if (params.action === "buy" && walletAddress) {
        const sol = await getSolBalance(rpcUrl, walletAddress);
        if (Number.parseFloat(sol) < params.amount + 0.01) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Insufficient SOL. Balance: ${sol} SOL, need ~${(params.amount + 0.01).toFixed(3)} SOL (${params.amount} + fees). Top up: ${walletAddress}`,
              },
            ],
            details: {},
          };
        }
      }

      const tradeParams: Record<string, unknown> = {
        action: params.action,
        mint: params.mint,
        slippage: params.slippage ?? 25,
        priorityFee: 0.0005,
        pool: "auto",
      };

      if (params.action === "buy") {
        tradeParams.amount = params.amount;
        tradeParams.denominatedInSol = "true";
      } else {
        tradeParams.amount = `${params.amount}%`;
        tradeParams.denominatedInSol = "false";
      }

      try {
        const signature = await signAndSendPumpPortalTx(signerRef, rpcUrl, tradeParams);
        appendHistory(historyPath, {
          t: Date.now(),
          k: "trade",
          ok: true,
          tx: signature,
          act: params.action,
          token: params.mint,
          sol: params.action === "buy" ? params.amount : undefined,
        });
        const action = params.action === "buy" ? "Bought" : "Sold";
        const detail =
          params.action === "buy" ? `Spent: ${params.amount} SOL` : `Sold: ${params.amount}%`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${action} tokens\nMint: ${params.mint}\n${detail}\nhttps://solscan.io/tx/${signature}`,
            },
          ],
          details: {},
        };
      } catch (err) {
        appendHistory(historyPath, {
          t: Date.now(),
          k: "trade",
          ok: false,
          act: params.action,
          token: params.mint,
          sol: params.action === "buy" ? params.amount : undefined,
        });
        return {
          content: [{ type: "text" as const, text: `Trade failed: ${String(err)}` }],
          details: {},
        };
      }
    },
  });

  api.registerTool({
    name: "x_token_info",
    label: "Token Info",
    description:
      "Look up a Solana token by mint address, or omit mint to get trending tokens (most boosted on DexScreener).",
    parameters: Type.Object({
      mint: Type.Optional(
        Type.String({ description: "Token mint address. Omit to get trending Solana tokens." }),
      ),
    }),
    async execute(_id, params) {
      try {
        // Trending mode: no mint provided
        if (!params.mint) {
          const res = await globalThis.fetch("https://api.dexscreener.com/token-boosts/top/v1");
          if (!res.ok) {
            return {
              content: [{ type: "text" as const, text: "Failed to fetch trending tokens" }],
              details: {},
            };
          }
          const boosts = (await res.json()) as Array<{
            chainId?: string;
            tokenAddress?: string;
            totalAmount?: number;
            description?: string;
            url?: string;
          }>;
          const solana = boosts.filter((b) => b.chainId === "solana").slice(0, 10);
          if (solana.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No trending Solana tokens right now" }],
              details: {},
            };
          }
          const lines = ["Trending Solana tokens (by DexScreener boosts):\n"];
          for (const [i, b] of solana.entries()) {
            const desc = b.description ? ` - ${b.description.slice(0, 60)}` : "";
            lines.push(
              `${i + 1}. \`${b.tokenAddress}\`${desc}`,
              `   Boosts: ${b.totalAmount ?? 0} | ${b.url ?? ""}`,
            );
          }
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {},
          };
        }

        // Lookup mode: mint provided
        const dexRes = await globalThis.fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${params.mint}`,
        );
        if (dexRes.ok) {
          const pairs = (await dexRes.json()) as Array<{
            baseToken?: { name?: string; symbol?: string };
            priceUsd?: string;
            fdv?: number;
            volume?: { h24?: number };
            liquidity?: { usd?: number };
            priceChange?: { h24?: number };
            url?: string;
          }>;
          if (pairs.length > 0) {
            const p = pairs[0];
            const lines = [
              `${p.baseToken?.name || "Unknown"} (${p.baseToken?.symbol || "?"})`,
              `Price: $${p.priceUsd || "N/A"}`,
              p.fdv ? `Market cap: $${(p.fdv / 1e6).toFixed(2)}M` : null,
              p.volume?.h24 ? `24h volume: $${(p.volume.h24 / 1e3).toFixed(1)}K` : null,
              p.liquidity?.usd ? `Liquidity: $${(p.liquidity.usd / 1e3).toFixed(1)}K` : null,
              p.priceChange?.h24 != null
                ? `24h change: ${p.priceChange.h24 > 0 ? "+" : ""}${p.priceChange.h24.toFixed(2)}%`
                : null,
              `Mint: ${params.mint}`,
              p.url || null,
            ].filter(Boolean);
            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: {},
            };
          }
        }

        // Fallback: pump.fun API for pre-graduation tokens on bonding curve
        const pfRes = await globalThis.fetch(
          `https://frontend-api-v3.pump.fun/coins/${params.mint}`,
        );
        if (pfRes.ok) {
          const coin = (await pfRes.json()) as {
            name?: string;
            symbol?: string;
            usd_market_cap?: number;
          };
          const lines = [
            `${coin.name || "Unknown"} (${coin.symbol || "?"})`,
            coin.usd_market_cap ? `Market cap: $${(coin.usd_market_cap / 1e3).toFixed(1)}K` : null,
            "Status: Pre-graduation (bonding curve)",
            `Mint: ${params.mint}`,
          ].filter(Boolean);
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {},
          };
        }

        return {
          content: [{ type: "text" as const, text: `No data found for mint: ${params.mint}` }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to fetch token info: ${String(err)}` }],
          details: {},
        };
      }
    },
  });

  // --- x402 fetch interceptor service ---

  api.registerService({
    id: "x402-fetch-patch",
    async start(ctx) {
      let signer: KeyPairSigner;
      try {
        const keypairData = JSON.parse(readFileSync(keypairPath, "utf-8")) as number[];
        signer = await createKeyPairSignerFromBytes(new Uint8Array(keypairData));
        walletAddress = signer.address;
        signerRef = signer;
        ctx.logger.info(`x402: wallet ${signer.address}`);
      } catch (err) {
        ctx.logger.error(`x402: failed to load keypair from ${keypairPath}: ${err}`);
        return;
      }

      const client = new x402Client();
      client.register(
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        new ExactSvmScheme(signer, { rpcUrl }),
      );

      const x402Fetch = wrapFetchWithPayment(globalThis.fetch, client);
      x402FetchRef = x402Fetch;

      const origFetch = globalThis.fetch;
      globalThis.fetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;

        if (x402Urls.some((u) => url.startsWith(u))) {
          ctx.logger.info(`x402: intercepting ${url.substring(0, 80)}`);

          const cleanInit = { ...init };
          if (cleanInit.headers) {
            const h = new Headers(cleanInit.headers);
            h.delete("Authorization");
            cleanInit.headers = h;
          }

          // x402 payment settlement is synchronous - streaming is impossible.
          // OpenClaw's pi-ai layer hardcodes stream:true (not configurable),
          // so we force stream:false here and wrap the response as SSE below.
          const isChatCompletion = url.includes("/chat/completions");
          if (isChatCompletion && cleanInit.body && typeof cleanInit.body === "string") {
            try {
              const parsed = JSON.parse(cleanInit.body) as Record<string, unknown>;
              if (parsed.stream === true) {
                parsed.stream = false;
                cleanInit.body = JSON.stringify(parsed);
                ctx.logger.info("x402: forced stream: false in request body");
              }
            } catch {
              // not JSON body, leave as-is
            }
          }

          const startMs = Date.now();
          try {
            const response = await x402Fetch(input, cleanInit);

            if (response.status === 402) {
              const body = await response.text();
              ctx.logger.error(`x402: payment failed, raw response: ${body}`);
              appendHistory(historyPath, {
                t: Date.now(),
                k: "inference",
                ok: false,
                ms: Date.now() - startMs,
                s: 402,
              });

              let userMessage: string;
              if (body.includes("simulation") || body.includes("Simulation")) {
                userMessage =
                  "Insufficient USDC or SOL in wallet " +
                  signer.address +
                  ". Fund it with USDC (SPL token) to pay for inference.";
              } else if (body.includes("insufficient") || body.includes("balance")) {
                userMessage =
                  "Insufficient funds in wallet " +
                  signer.address +
                  ". Top up with USDC on Solana mainnet.";
              } else {
                userMessage =
                  "x402 payment failed: " +
                  (body.substring(0, 200) || "unknown error") +
                  ". Wallet: " +
                  signer.address;
              }

              return new Response(
                JSON.stringify({
                  error: {
                    message: userMessage,
                    type: "x402_payment_error",
                    code: "payment_failed",
                  },
                }),
                { status: 402, headers: { "Content-Type": "application/json" } },
              );
            }

            // Upstream failed after payment settled - don't retry (would trigger another payment)
            if (!response.ok && isChatCompletion) {
              const body = await response.text();
              ctx.logger.error(
                `x402: upstream error ${response.status}: ${body.substring(0, 300)}`,
              );
              appendHistory(historyPath, {
                t: Date.now(),
                k: "inference",
                ok: false,
                ms: Date.now() - startMs,
                s: response.status,
              });

              return new Response(
                JSON.stringify({
                  error: {
                    message: `LLM provider temporarily unavailable (HTTP ${response.status}). Try again shortly.`,
                    type: "x402_upstream_error",
                    code: "upstream_failed",
                  },
                }),
                { status: 502, headers: { "Content-Type": "application/json" } },
              );
            }

            ctx.logger.info(`x402: response ${response.status}`);

            // Non-streaming JSON response wrapped as SSE for pi-ai compatibility
            const ct = response.headers.get("content-type") || "";
            if (isChatCompletion && response.ok && ct.includes("application/json")) {
              const text = await response.text();
              try {
                const body = JSON.parse(text) as {
                  model?: string;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                  choices?: Array<{ message?: unknown; delta?: unknown }>;
                };
                if (body.choices) {
                  for (const c of body.choices) {
                    if (c.message && !c.delta) {
                      c.delta = c.message;
                      delete c.message;
                    }
                  }
                }

                // Log inference transaction
                const inTok = body.usage?.prompt_tokens ?? 0;
                const outTok = body.usage?.completion_tokens ?? 0;
                const model = body.model ?? "";
                appendHistory(historyPath, {
                  t: Date.now(),
                  k: "inference",
                  ok: true,
                  m: model,
                  in: inTok,
                  out: outTok,
                  c: estimateCost(allModels, model, inTok, outTok),
                  ms: Date.now() - startMs,
                  tx: extractTxSignature(response),
                });

                ctx.logger.info("x402: wrapped JSON response as SSE");
                const sse = `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`;
                return new Response(sse, {
                  status: 200,
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                  },
                });
              } catch {
                return new Response(text, {
                  status: response.status,
                  headers: response.headers,
                });
              }
            }

            return response;
          } catch (err) {
            const msg = String(err);
            ctx.logger.error(`x402: fetch threw: ${msg}`);
            appendHistory(historyPath, {
              t: Date.now(),
              k: "inference",
              ok: false,
              ms: Date.now() - startMs,
            });

            let userMessage: string;
            if (msg.includes("Simulation failed") || msg.includes("simulation")) {
              userMessage =
                "Insufficient USDC or SOL in wallet " +
                signer.address +
                ". Fund it with USDC and SOL to pay for inference.";
            } else if (msg.includes("Failed to create payment")) {
              userMessage = `x402 payment creation failed: ${msg}. Wallet: ${signer.address}`;
            } else {
              userMessage = `x402 request failed: ${msg}`;
            }

            return new Response(
              JSON.stringify({
                error: { message: userMessage, type: "x402_payment_error", code: "payment_failed" },
              }),
              { status: 402, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        return origFetch(input, init);
      };

      ctx.logger.info(`x402: fetch patched for ${x402Urls.join(", ")} (wallet: ${signer.address})`);
    },
    async stop() {},
  });

  // --- CLI: wallet generation ---

  api.registerCli(
    ({ program }) => {
      const x402 = program.command("x402").description("x402 payment plugin commands");
      x402
        .command("generate")
        .description("Generate Solana + EVM wallets from a single BIP-39 mnemonic")
        .option("-o, --output <dir>", "Output directory for wallet files")
        .action((opts: { output?: string }) => {
          if (!opts.output) {
            console.error("Usage: openclaw x402 generate --output <dir>");
            process.exit(1);
          }
          const dir = opts.output;
          mkdirSync(dir, { recursive: true });

          // Generate a single mnemonic, then derive both chain keypairs from it
          const mnemonic = generateMnemonic(english, 256);
          const sol = deriveSolanaKeypair(mnemonic);
          const evm = deriveEvmKeypair(mnemonic);

          // wallet-sol.json: 64-byte array [32 secret + 32 public] (solana-keygen compatible)
          const keypairBytes = new Uint8Array(64);
          keypairBytes.set(sol.secretKey, 0);
          keypairBytes.set(sol.publicKey, 32);
          writeFileSync(
            join(dir, "wallet-sol.json"),
            `${JSON.stringify(Array.from(keypairBytes))}\n`,
            { mode: 0o600 },
          );

          // wallet-evm.key: raw 0x... private key hex
          writeFileSync(join(dir, "wallet-evm.key"), `${evm.privateKey}\n`, { mode: 0o600 });

          // mnemonic: 24 words plaintext
          writeFileSync(join(dir, "mnemonic"), `${mnemonic}\n`, { mode: 0o600 });

          console.log(sol.address);
        });
    },
    { commands: ["x402"] },
  );
}
