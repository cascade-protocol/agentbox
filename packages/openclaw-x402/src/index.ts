import { execSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { Type } from "@sinclair/typebox";
import {
  createKeyPairSignerFromBytes,
  generateKeyPair,
  getAddressFromPublicKey,
  type KeyPairSigner,
} from "@solana/kit";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  appendHistory,
  calcSpend,
  formatTxLine,
  HISTORY_PAGE_SIZE,
  INLINE_HISTORY_TOKEN_THRESHOLD,
  readHistory,
  resolveTokenSymbols,
  STATUS_HISTORY_COUNT,
} from "./history.js";
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
const PLUGIN_VERSION = "0.9.0";

// --- Types ---

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

// --- Pure functions ---

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

async function checkNpmLatestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await globalThis.fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

// --- Plugin entry point ---

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

  // Shared balance + token + spend snapshot
  async function getWalletSnapshot(wallet: string) {
    const [{ ui, raw }, sol, tokens] = await Promise.all([
      getUsdcBalance(rpcUrl, wallet),
      getSolBalance(rpcUrl, wallet),
      getTokenAccounts(rpcUrl, wallet).catch(() => []),
    ]);
    const records = readHistory(historyPath);
    const spend = calcSpend(records);
    return { ui, raw, sol, tokens, records, spend };
  }

  // --- Slash commands ---

  api.registerCommand({
    name: "x_wallet",
    description: "Wallet balance, tokens, send USDC, transaction history",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!walletAddress) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }

      const args = ctx.args?.trim() ?? "";
      const parts = args.split(/\s+/).filter(Boolean);

      // /x_wallet send <amount|all> <address>
      if (parts[0]?.toLowerCase() === "send") {
        return handleSend(parts.slice(1), walletAddress, signerRef, rpcUrl, historyPath);
      }

      // /x_wallet history [page]
      if (parts[0]?.toLowerCase() === "history") {
        const pageArg = parts[1];
        const page = pageArg ? Math.max(1, Number.parseInt(pageArg, 10) || 1) : 1;
        return handleHistory(historyPath, page);
      }

      // Default: balance view
      try {
        const snap = await getWalletSnapshot(walletAddress);

        const lines: string[] = [
          "**Wallet**",
          `\`${walletAddress}\``,
          "",
          `  ${snap.sol} SOL`,
          `  ${snap.ui} USDC`,
        ];
        if (snap.spend.today > 0) {
          lines.push(`  -${snap.spend.today.toFixed(2)} USDC today`);
        }

        // Token holdings
        if (snap.tokens.length > 0) {
          const displayTokens = snap.tokens.slice(0, 10);
          const symbols = await resolveTokenSymbols(displayTokens.map((t) => t.mint));
          lines.push("", "**Tokens**");
          for (const t of displayTokens) {
            const sym = symbols.get(t.mint);
            const label = sym ?? `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
            const amt = Number.parseFloat(t.amount).toLocaleString("en-US", {
              maximumFractionDigits: 0,
            });
            lines.push(`  ${amt} ${label}`);
          }
          if (snap.tokens.length > 10) {
            lines.push(`  ...and ${snap.tokens.length - 10} more`);
          }
        }

        // Show inline history only when token count is low
        if (snap.tokens.length <= INLINE_HISTORY_TOKEN_THRESHOLD) {
          const reversed = [...snap.records].reverse();
          const recentRecords = reversed.slice(0, STATUS_HISTORY_COUNT);
          if (recentRecords.length > 0) {
            lines.push("", "**Recent**");
            for (const r of recentRecords) {
              lines.push(formatTxLine(r));
            }
          }
        }

        // Footer
        const footer: string[] = [];
        footer.push("History: /x\\_wallet history");
        footer.push(`[Solscan](https://solscan.io/account/${walletAddress})`);
        if (dashboardUrl) {
          footer.push(`[Dashboard](${dashboardUrl})`);
        }
        lines.push("", footer.join(" · "));

        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Failed to check balance: ${String(err)}` };
      }
    },
  });

  api.registerCommand({
    name: "x_status",
    description: "System overview: version, model, balance, recent activity",
    acceptsArgs: false,
    handler: async () => {
      const latestVersion = await checkNpmLatestVersion("openclaw-x402");
      const updateStatus =
        latestVersion && latestVersion !== PLUGIN_VERSION
          ? `update available: v${latestVersion}`
          : "up to date";

      const lines: string[] = [`x402 v${PLUGIN_VERSION} · ${updateStatus}`];

      // Current model
      const defaultModel = allModels[0];
      if (defaultModel) {
        lines.push("", `**Model** · ${defaultModel.name} (${defaultModel.provider})`);
      }

      // Models pricing
      const byProvider = new Map<string, ModelEntry[]>();
      for (const m of allModels) {
        let list = byProvider.get(m.provider);
        if (!list) {
          list = [];
          byProvider.set(m.provider, list);
        }
        list.push(m);
      }
      lines.push("", "**Models**");
      for (const [, models] of byProvider) {
        for (const m of models) {
          const inp = m.cost.input < 1 ? `${m.cost.input}` : `${m.cost.input.toFixed(0)}`;
          const out = m.cost.output < 1 ? `${m.cost.output}` : `${m.cost.output.toFixed(0)}`;
          const ctx = `${(m.contextWindow / 1000).toFixed(0)}K`;
          lines.push(`  ${m.name} · ${inp}/${out} per 1M · ${ctx}`);
        }
      }

      // Wallet summary
      if (walletAddress) {
        try {
          const snap = await getWalletSnapshot(walletAddress);
          lines.push("", "**Wallet**", `\`${walletAddress}\``, `${snap.sol} SOL · ${snap.ui} USDC`);

          // Recent transactions
          const reversed = [...snap.records].reverse();
          const recentRecords = reversed.slice(0, STATUS_HISTORY_COUNT);
          if (recentRecords.length > 0) {
            lines.push("", "**Recent**");
            for (const r of recentRecords) {
              lines.push(formatTxLine(r));
            }
          }
        } catch {
          lines.push("", "**Wallet**", `\`${walletAddress}\``, "Balance unavailable");
        }
      } else {
        lines.push("", "Wallet not loaded yet");
      }

      // Commands
      lines.push(
        "",
        "/x\\_wallet · full balance and send",
        "/x\\_wallet history · transaction history",
        "/x\\_update · update plugin + skills",
        "/model · switch AI model",
      );

      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "x_update",
    description: "Update x402 plugin and skills, then restart gateway",
    acceptsArgs: false,
    handler: async () => {
      const latestVersion = await checkNpmLatestVersion("openclaw-x402");

      if (!latestVersion) {
        return { text: "Could not check npm registry. Try again later." };
      }

      if (latestVersion === PLUGIN_VERSION) {
        const lines = [
          `Everything up to date · plugin v${PLUGIN_VERSION}`,
          "",
          "/x\\_status · system overview",
          "/x\\_wallet · balance and send",
        ];
        return { text: lines.join("\n") };
      }

      const lines = [`Updating x402 v${PLUGIN_VERSION} -> v${latestVersion}`, ""];

      try {
        execSync("openclaw plugins update openclaw-x402", {
          timeout: 60_000,
          stdio: "pipe",
        });
        lines.push("Plugin   updated");
      } catch (err) {
        lines.push(`Plugin   failed: ${String(err)}`);
        return { text: lines.join("\n") };
      }

      try {
        execSync("npx skills add -g cascade-protocol/agentbox", {
          timeout: 30_000,
          stdio: "pipe",
        });
        lines.push("Skills   refreshed");
      } catch {
        lines.push("Skills   skipped (could not reach GitHub)");
      }

      lines.push("", "Restarting gateway...");

      // Schedule restart after response is sent
      setTimeout(() => {
        try {
          spawn("systemctl", ["--user", "restart", "openclaw-gateway"], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } catch {
          // Fallback: try system-level restart
          try {
            spawn("systemctl", ["restart", "openclaw-gateway"], {
              detached: true,
              stdio: "ignore",
            }).unref();
          } catch {
            // Cannot restart - user will need to restart manually
          }
        }
      }, 2000);

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
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }
      try {
        const snap = await getWalletSnapshot(walletAddress);
        const total = Number.parseFloat(snap.ui);
        const available = Math.max(0, total - INFERENCE_RESERVE);
        const tokenLines = snap.tokens.slice(0, 5).map((t) => {
          const short = `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
          return `${Number.parseFloat(t.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${short})`;
        });
        return toolResult(
          [
            `Wallet: ${walletAddress}`,
            `SOL: ${snap.sol} SOL`,
            `USDC: ${snap.ui} USDC`,
            `Available for tools: ${available.toFixed(2)} USDC`,
            `Reserved for inference: ${INFERENCE_RESERVE.toFixed(2)} USDC`,
            `Spent today: ${snap.spend.today.toFixed(4)} USDC`,
            `Total spent: ${snap.spend.total.toFixed(4)} USDC (${snap.spend.count} txs)`,
            ...(tokenLines.length > 0 ? [`Tokens held: ${tokenLines.join(", ")}`] : []),
          ].join("\n"),
        );
      } catch (err) {
        return toolResult(`Failed to check balance: ${String(err)}`);
      }
    },
  });

  api.registerTool({
    name: "x_payment",
    label: "x402 Payment",
    description:
      "Call an x402-enabled paid API endpoint with automatic USDC payment on Solana. " +
      "Use this when you need to call a paid service given by the user. " +
      `Note: ${INFERENCE_RESERVE.toFixed(2)} USDC is reserved for LLM inference and cannot be spent by this tool.`,
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
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      try {
        const { ui } = await getUsdcBalance(rpcUrl, walletAddress);
        if (Number.parseFloat(ui) <= INFERENCE_RESERVE) {
          return toolResult(
            `Insufficient funds. Balance: ${ui} USDC, reserved for inference: ${INFERENCE_RESERVE.toFixed(2)} USDC. Top up wallet: ${walletAddress}`,
          );
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
          return toolResult("Invalid headers JSON.");
        }
      }

      if (params.params) {
        if (method === "GET" || method === "HEAD") {
          try {
            const qp = JSON.parse(params.params) as Record<string, string>;
            const qs = new URLSearchParams(qp).toString();
            url = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
          } catch {
            return toolResult("Invalid params JSON for GET request.");
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
          return toolResult(
            `Payment failed (402): ${body.substring(0, 500)}. Wallet: ${walletAddress}`,
          );
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

        return toolResult(`HTTP ${response.status}\n\n${truncated}`);
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
        return toolResult(text);
      }
    },
  });

  api.registerTool({
    name: "x_trade",
    label: "Pump.fun Trade",
    description:
      "Buy, sell, or create pump.fun tokens. Buy spends SOL to get tokens, sell converts tokens back to SOL, create launches a new token.",
    parameters: Type.Object({
      action: Type.Unsafe<"buy" | "sell" | "create">({
        type: "string",
        enum: ["buy", "sell", "create"],
        description:
          "buy = spend SOL to get tokens, sell = sell tokens for SOL, create = launch a new token on pump.fun",
      }),
      mint: Type.Optional(
        Type.String({
          description: "Token mint address (required for buy/sell, omit for create)",
        }),
      ),
      amount: Type.Optional(
        Type.Number({
          description:
            "For buy: SOL to spend. For sell: % of tokens to sell (e.g. 50 for 50%). For create: SOL for initial dev buy (default: 0.05)",
        }),
      ),
      slippage: Type.Optional(
        Type.Number({
          description: "Slippage tolerance in % (default: 25 for trade, 10 for create)",
        }),
      ),
      name: Type.Optional(Type.String({ description: "Token name (required for create)" })),
      symbol: Type.Optional(Type.String({ description: "Token ticker (required for create)" })),
      description: Type.Optional(
        Type.String({ description: "Token description (required for create)" }),
      ),
      image_url: Type.Optional(
        Type.String({
          description: "URL to token image for create (PNG/JPG). Placeholder used if omitted.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!signerRef || !walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      // --- Create token ---
      if (params.action === "create") {
        if (!params.name || !params.symbol || !params.description) {
          return toolResult("Token creation requires name, symbol, and description parameters.");
        }

        const initialBuy = params.amount ?? 0.05;
        const sol = await getSolBalance(rpcUrl, walletAddress);
        if (Number.parseFloat(sol) < initialBuy + 0.02) {
          return toolResult(
            `Insufficient SOL. Balance: ${sol} SOL, need ~${(initialBuy + 0.02).toFixed(3)} SOL (${initialBuy} buy + fees). Top up: ${walletAddress}`,
          );
        }

        try {
          const mintKeyPair = await generateKeyPair();
          const mintAddress = await getAddressFromPublicKey(mintKeyPair.publicKey);

          let imageBlob: Blob;
          if (params.image_url) {
            const imgRes = await globalThis.fetch(params.image_url);
            if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
            imageBlob = await imgRes.blob();
          } else {
            const png = Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
              "base64",
            );
            imageBlob = new Blob([png], { type: "image/png" });
          }

          const form = new FormData();
          form.append("file", imageBlob, "token.png");
          form.append("name", params.name);
          form.append("symbol", params.symbol);
          form.append("description", params.description);
          form.append("showName", "true");

          const ipfsRes = await globalThis.fetch("https://pump.fun/api/ipfs", {
            method: "POST",
            body: form,
          });
          if (!ipfsRes.ok) {
            const text = await ipfsRes.text();
            throw new Error(`IPFS upload failed: ${ipfsRes.status} ${text}`);
          }
          const { metadataUri } = (await ipfsRes.json()) as { metadataUri: string };

          const signature = await signAndSendPumpPortalTx(
            signerRef,
            rpcUrl,
            {
              action: "create",
              tokenMetadata: { name: params.name, symbol: params.symbol, uri: metadataUri },
              mint: mintAddress,
              denominatedInSol: "true",
              amount: initialBuy,
              slippage: params.slippage ?? 10,
              priorityFee: 0.0005,
              pool: "pump",
            },
            [mintKeyPair],
          );

          appendHistory(historyPath, {
            t: Date.now(),
            k: "trade",
            ok: true,
            tx: signature,
            act: "create",
            token: mintAddress,
            sol: initialBuy,
          });

          return toolResult(
            `Token created\nName: ${params.name} (${params.symbol})\nMint: ${mintAddress}\nInitial buy: ${initialBuy} SOL\nhttps://pump.fun/${mintAddress}\nhttps://solscan.io/tx/${signature}`,
          );
        } catch (err) {
          appendHistory(historyPath, { t: Date.now(), k: "trade", ok: false, act: "create" });
          return toolResult(`Token creation failed: ${String(err)}`);
        }
      }

      // --- Buy/Sell ---
      if (!params.mint) {
        return toolResult("Token mint address is required for buy/sell.");
      }
      if (params.amount == null) {
        return toolResult("Amount is required for buy/sell.");
      }

      if (params.action === "buy") {
        const sol = await getSolBalance(rpcUrl, walletAddress);
        if (Number.parseFloat(sol) < params.amount + 0.01) {
          return toolResult(
            `Insufficient SOL. Balance: ${sol} SOL, need ~${(params.amount + 0.01).toFixed(3)} SOL (${params.amount} + fees). Top up: ${walletAddress}`,
          );
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
        return toolResult(
          `${action} tokens\nMint: ${params.mint}\n${detail}\nhttps://solscan.io/tx/${signature}`,
        );
      } catch (err) {
        appendHistory(historyPath, {
          t: Date.now(),
          k: "trade",
          ok: false,
          act: params.action,
          token: params.mint,
          sol: params.action === "buy" ? params.amount : undefined,
        });
        return toolResult(`Trade failed: ${String(err)}`);
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
        if (!params.mint) {
          const res = await globalThis.fetch("https://api.dexscreener.com/token-boosts/top/v1");
          if (!res.ok) {
            return toolResult("Failed to fetch trending tokens");
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
            return toolResult("No trending Solana tokens right now");
          }
          const lines = ["Trending Solana tokens (by DexScreener boosts):\n"];
          for (const [i, b] of solana.entries()) {
            const desc = b.description ? ` - ${b.description.slice(0, 60)}` : "";
            lines.push(
              `${i + 1}. \`${b.tokenAddress}\`${desc}`,
              `   Boosts: ${b.totalAmount ?? 0} | ${b.url ?? ""}`,
            );
          }
          return toolResult(lines.join("\n"));
        }

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
              `Price: ${p.priceUsd || "N/A"} USD`,
              p.fdv ? `Market cap: ${(p.fdv / 1e6).toFixed(2)}M USD` : null,
              p.volume?.h24 ? `24h volume: ${(p.volume.h24 / 1e3).toFixed(1)}K USD` : null,
              p.liquidity?.usd ? `Liquidity: ${(p.liquidity.usd / 1e3).toFixed(1)}K USD` : null,
              p.priceChange?.h24 != null
                ? `24h change: ${p.priceChange.h24 > 0 ? "+" : ""}${p.priceChange.h24.toFixed(2)}%`
                : null,
              `Mint: ${params.mint}`,
              p.url || null,
            ].filter(Boolean);
            return toolResult(lines.join("\n"));
          }
        }

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
            coin.usd_market_cap
              ? `Market cap: ${(coin.usd_market_cap / 1e3).toFixed(1)}K USD`
              : null,
            "Status: Pre-graduation (bonding curve)",
            `Mint: ${params.mint}`,
          ].filter(Boolean);
          return toolResult(lines.join("\n"));
        }

        return toolResult(`No data found for mint: ${params.mint}`);
      } catch (err) {
        return toolResult(`Failed to fetch token info: ${String(err)}`);
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
                error: {
                  message: userMessage,
                  type: "x402_payment_error",
                  code: "payment_failed",
                },
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

          const mnemonic = generateMnemonic(english, 256);
          const sol = deriveSolanaKeypair(mnemonic);
          const evm = deriveEvmKeypair(mnemonic);

          const keypairBytes = new Uint8Array(64);
          keypairBytes.set(sol.secretKey, 0);
          keypairBytes.set(sol.publicKey, 32);
          writeFileSync(
            join(dir, "wallet-sol.json"),
            `${JSON.stringify(Array.from(keypairBytes))}\n`,
            { mode: 0o600 },
          );

          writeFileSync(join(dir, "wallet-evm.key"), `${evm.privateKey}\n`, { mode: 0o600 });
          writeFileSync(join(dir, "mnemonic"), `${mnemonic}\n`, { mode: 0o600 });

          console.log(sol.address);
        });
    },
    { commands: ["x402"] },
  );

  // --- Helper functions for command handlers ---

  async function handleSend(
    parts: string[],
    wallet: string,
    signer: KeyPairSigner | null,
    rpc: string,
    histPath: string,
  ): Promise<{ text: string }> {
    if (!signer) {
      return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
    }

    if (parts.length !== 2) {
      return {
        text: "Usage: /x\\_wallet send <amount|all> <address>\n\n  /x\\_wallet send 0.5 7xKXtg...\n  /x\\_wallet send all 7xKXtg...",
      };
    }

    const [amountStr, destAddr] = parts;
    if (destAddr.length < 32 || destAddr.length > 44) {
      return { text: `Invalid Solana address: ${destAddr}` };
    }

    try {
      const recipientHasAta = await checkAtaExists(rpc, destAddr);
      if (!recipientHasAta) {
        return {
          text: "Recipient does not have a USDC token account.\nThey need to receive USDC at least once to create one.",
        };
      }

      let amountRaw: bigint;
      let amountUi: string;
      if (amountStr.toLowerCase() === "all") {
        const balance = await getUsdcBalance(rpc, wallet);
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

      const sig = await transferUsdc(signer, rpc, destAddr, amountRaw);
      appendHistory(histPath, {
        t: Date.now(),
        k: "send",
        ok: true,
        tx: sig,
        to: destAddr,
        amt: Number.parseFloat(amountUi),
        cur: "USDC",
      });

      return {
        text: `Sent ${amountUi} USDC to \`${destAddr}\`\n[View transaction](https://solscan.io/tx/${sig})`,
      };
    } catch (err) {
      appendHistory(histPath, {
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
          text: "Send failed - insufficient SOL for fees\nBalance too low for transaction fees. Fund wallet with SOL.",
        };
      }
      return { text: `Send failed: ${detail}` };
    }
  }

  function handleHistory(histPath: string, page: number): { text: string } {
    const records = readHistory(histPath);
    const reversed = [...records].reverse();
    const totalTxs = reversed.length;
    const start = (page - 1) * HISTORY_PAGE_SIZE;
    const pageRecords = reversed.slice(start, start + HISTORY_PAGE_SIZE);

    if (pageRecords.length === 0) {
      return { text: page === 1 ? "No transactions yet." : "No more transactions." };
    }

    const rangeStart = start + 1;
    const rangeEnd = start + pageRecords.length;
    const lines: string[] = [`**History** (${rangeStart}-${rangeEnd})`, ""];
    for (const r of pageRecords) {
      lines.push(formatTxLine(r));
    }

    const nav: string[] = [];
    if (page > 1) {
      nav.push(`Newer: /x\\_wallet history${page === 2 ? "" : ` ${page - 1}`}`);
    }
    if (start + HISTORY_PAGE_SIZE < totalTxs) {
      nav.push(`Older: /x\\_wallet history ${page + 1}`);
    }
    if (nav.length > 0) {
      lines.push("", nav.join(" · "));
    }

    return { text: lines.join("\n") };
  }
}
