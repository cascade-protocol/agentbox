import { execSync } from "node:child_process";
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
  getTokenDecimals,
  getUsdcBalance,
  JupiterNoRouteError,
  SOL_MINT,
  signAndSendPumpPortalTx,
  swapViaJupiter,
  transferUsdc,
} from "./solana.js";
import { deriveEvmKeypair, deriveSolanaKeypair } from "./wallet.js";

const INFERENCE_RESERVE = 0.3;
const MAX_RESPONSE_CHARS = 50_000;
const PLUGIN_VERSION = "0.10.0";
const SOL_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

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

  // Per-payment capture via queue. Hook pushes during createPaymentPayload,
  // caller shifts after wrapFetchWithPayment returns. Order is guaranteed
  // because the hook fires within the same async flow before the wrapper returns.
  type PaymentInfo = { amount: number | undefined; payTo: string | undefined };
  const paymentQueue: PaymentInfo[] = [];

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
        footer.push("History: `/x_wallet history`");
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

      // Models by provider (only show agentbox + blockrun)
      const showProviders = ["agentbox", "blockrun"];
      for (const provName of showProviders) {
        const provModels = allModels.filter((m) => m.provider === provName);
        if (provModels.length === 0) continue;
        lines.push("", `**${provName}**`);
        for (const m of provModels) {
          lines.push(`\`/model ${provName}/${m.id}\``);
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
        "`/x_wallet` · full balance and send",
        "`/x_wallet history` · transaction history",
        "`/x_update` · update plugin + skills",
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
      const hasPluginUpdate = latestVersion && latestVersion !== PLUGIN_VERSION;
      const lines: string[] = [];
      let needsRestart = false;

      // Always refresh skills regardless of plugin version
      try {
        execSync("npx skills add -g cascade-protocol/agentbox", {
          timeout: 30_000,
          stdio: "pipe",
        });
        lines.push("Skills   refreshed");
      } catch {
        lines.push("Skills   skipped (could not reach GitHub)");
      }

      // Update plugin only if a new version exists
      if (hasPluginUpdate) {
        const extDir = join(homedir(), ".openclaw/extensions/openclaw-x402");
        try {
          execSync(`rm -rf ${extDir}`, { timeout: 5_000, stdio: "pipe" });
          execSync("openclaw plugins install openclaw-x402@latest", {
            timeout: 60_000,
            stdio: "pipe",
          });
          lines.push(`Plugin   v${PLUGIN_VERSION} -> v${latestVersion}`);
          needsRestart = true;
        } catch (err) {
          lines.push(`Plugin   update failed: ${String(err)}`);
        }
      } else {
        lines.push(`Plugin   v${PLUGIN_VERSION} (up to date)`);
      }

      if (needsRestart) {
        lines.push("", "Restarting gateway...");
        // Exit after response is sent - systemd Restart=always handles the restart
        setTimeout(() => process.exit(0), 2000);
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
          paymentQueue.shift();
          appendHistory(historyPath, {
            t: Date.now(),
            ok: false,
            kind: "x402_payment",
            net: SOL_MAINNET,
            from: walletAddress ?? "",
            label: url,
            ms: Date.now() - toolStartMs,
            error: "payment_required",
          });
          return toolResult(
            `Payment failed (402): ${body.substring(0, 500)}. Wallet: ${walletAddress}`,
          );
        }

        const payment = paymentQueue.shift();
        appendHistory(historyPath, {
          t: Date.now(),
          ok: true,
          kind: "x402_payment",
          net: SOL_MAINNET,
          from: walletAddress ?? "",
          to: payment?.payTo,
          tx: extractTxSignature(response),
          amount: payment?.amount,
          token: "USDC",
          label: url,
          ms: Date.now() - toolStartMs,
        });

        const truncated =
          body.length > MAX_RESPONSE_CHARS
            ? `${body.substring(0, MAX_RESPONSE_CHARS)}\n\n[Truncated - response was ${body.length} chars]`
            : body;

        return toolResult(`HTTP ${response.status}\n\n${truncated}`);
      } catch (err) {
        paymentQueue.shift();
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_payment",
          net: SOL_MAINNET,
          from: walletAddress ?? "",
          label: params.url,
          error: String(err).substring(0, 200),
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
    name: "x_swap",
    label: "Token Swap",
    description:
      "Swap any Solana token for another. Provide mint addresses for both tokens. " +
      "Works for SOL, USDC, meme tokens, and any SPL token with DEX liquidity. " +
      "Use x_token_info to look up mint addresses. " +
      `SOL mint: ${SOL_MINT}  USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`,
    parameters: Type.Object({
      inputMint: Type.String({ description: "Mint address of the token to sell" }),
      outputMint: Type.String({ description: "Mint address of the token to buy" }),
      amount: Type.Number({
        description:
          "Amount of input token to swap in human-readable units (e.g. 0.5 for 0.5 SOL, 10 for 10 USDC)",
      }),
      slippage: Type.Optional(
        Type.Number({
          description: "Slippage tolerance in basis points (default: 250 = 2.5%)",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!signerRef || !walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      const slippageBps = params.slippage ?? 250;
      const inputShort = `${params.inputMint.slice(0, 4)}...${params.inputMint.slice(-4)}`;
      const outputShort = `${params.outputMint.slice(0, 4)}...${params.outputMint.slice(-4)}`;

      try {
        const inputDecimals = await getTokenDecimals(rpcUrl, params.inputMint);
        const amountRaw = String(Math.round(params.amount * 10 ** inputDecimals));

        // Jupiter first, PumpPortal fallback for bonding curve tokens
        let signature: string;
        let outAmountDisplay: string | undefined;
        try {
          const result = await swapViaJupiter(
            signerRef,
            rpcUrl,
            params.inputMint,
            params.outputMint,
            amountRaw,
            slippageBps,
          );
          signature = result.signature;
          const outDecimals = await getTokenDecimals(rpcUrl, params.outputMint);
          outAmountDisplay = (Number(result.outAmount) / 10 ** outDecimals).toFixed(
            Math.min(outDecimals, 6),
          );
        } catch (err) {
          if (!(err instanceof JupiterNoRouteError)) throw err;

          // PumpPortal fallback: only works for SOL <-> token pairs
          const isBuy = params.inputMint === SOL_MINT;
          const isSell = params.outputMint === SOL_MINT;
          if (!isBuy && !isSell) {
            throw new Error("No swap route found for this token pair");
          }

          const tokenMint = isBuy ? params.outputMint : params.inputMint;
          const pumpParams: Record<string, unknown> = {
            action: isBuy ? "buy" : "sell",
            mint: tokenMint,
            slippage: Math.max(slippageBps / 100, 10),
            priorityFee: 0.0005,
            pool: "pump",
          };

          if (isBuy) {
            pumpParams.amount = params.amount;
            pumpParams.denominatedInSol = "true";
          } else {
            const holdings = await getTokenAccounts(rpcUrl, walletAddress);
            const holding = holdings.find((h) => h.mint === tokenMint);
            if (!holding || Number.parseFloat(holding.amount) === 0) {
              throw new Error(`No holdings found for token ${tokenMint}`);
            }
            const pct = Math.min(100, (params.amount / Number.parseFloat(holding.amount)) * 100);
            pumpParams.amount = `${Math.round(pct)}%`;
            pumpParams.denominatedInSol = "false";
          }

          signature = await signAndSendPumpPortalTx(signerRef, rpcUrl, pumpParams);
        }

        appendHistory(historyPath, {
          t: Date.now(),
          ok: true,
          kind: "swap",
          net: SOL_MAINNET,
          from: walletAddress,
          tx: signature,
          amount: params.amount,
          label: `${inputShort}→${outputShort}`,
        });

        const outLine = outAmountDisplay ? ` → ${outAmountDisplay}` : "";
        return toolResult(
          `Swapped ${params.amount}${outLine}\nInput: ${params.inputMint}\nOutput: ${params.outputMint}\nhttps://solscan.io/tx/${signature}`,
        );
      } catch (err) {
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "swap",
          net: SOL_MAINNET,
          from: walletAddress,
          label: `${inputShort}→${outputShort}`,
          error: String(err).substring(0, 200),
        });
        return toolResult(`Swap failed: ${String(err)}`);
      }
    },
  });

  api.registerTool({
    name: "x_launch_token",
    label: "Launch Token",
    description:
      "Launch a new token on pump.fun with an initial dev buy. Requires name, symbol, and description.",
    parameters: Type.Object({
      name: Type.String({ description: "Token name" }),
      symbol: Type.String({ description: "Token ticker symbol" }),
      description: Type.String({ description: "Token description" }),
      image_url: Type.Optional(
        Type.String({
          description: "URL to token image (PNG/JPG). Placeholder used if omitted.",
        }),
      ),
      initial_buy: Type.Optional(
        Type.Number({ description: "SOL for initial dev buy (default: 0.05)" }),
      ),
      slippage: Type.Optional(
        Type.Number({ description: "Slippage tolerance in % (default: 10)" }),
      ),
    }),
    async execute(_id, params) {
      if (!signerRef || !walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      const initialBuy = params.initial_buy ?? 0.05;
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
          ok: true,
          kind: "mint",
          net: SOL_MAINNET,
          from: walletAddress,
          tx: signature,
          label: mintAddress,
          amount: initialBuy,
          token: "SOL",
        });

        return toolResult(
          `Token launched\nName: ${params.name} (${params.symbol})\nMint: ${mintAddress}\nInitial buy: ${initialBuy} SOL\nhttps://pump.fun/${mintAddress}\nhttps://solscan.io/tx/${signature}`,
        );
      } catch (err) {
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "mint",
          net: SOL_MAINNET,
          from: walletAddress,
          error: String(err).substring(0, 200),
        });
        return toolResult(`Token launch failed: ${String(err)}`);
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
      client.register(SOL_MAINNET, new ExactSvmScheme(signer, { rpcUrl }));

      // Capture payment amount and payTo from x402 hooks - no RPC lookup needed.
      // The amount from selectedRequirements is in base units (micro-USDC for 6-decimal tokens).
      const USDC_DECIMALS = 6;
      client.onAfterPaymentCreation(async (hookCtx) => {
        const raw = hookCtx.selectedRequirements.amount;
        const cleaned = raw.startsWith("debug.") ? raw.slice(6) : raw;
        const parsed = Number.parseFloat(cleaned);
        paymentQueue.push({
          amount: Number.isNaN(parsed) ? undefined : parsed / 10 ** USDC_DECIMALS,
          payTo: hookCtx.selectedRequirements.payTo,
        });
      });

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
          let thinkingMode: string | undefined;
          if (isChatCompletion && cleanInit.body && typeof cleanInit.body === "string") {
            try {
              const parsed = JSON.parse(cleanInit.body) as Record<string, unknown>;
              if (parsed.stream === true) {
                parsed.stream = false;
                cleanInit.body = JSON.stringify(parsed);
                ctx.logger.info("x402: forced stream: false in request body");
              }
              if (parsed.reasoning_effort) thinkingMode = String(parsed.reasoning_effort);
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
              const payment = paymentQueue.shift();
              appendHistory(historyPath, {
                t: Date.now(),
                ok: false,
                kind: "x402_inference",
                net: SOL_MAINNET,
                from: walletAddress ?? "",
                to: payment?.payTo,
                amount: payment?.amount,
                token: payment?.amount != null ? "USDC" : undefined,
                ms: Date.now() - startMs,
                error: "payment_required",
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
              const payment = paymentQueue.shift();
              appendHistory(historyPath, {
                t: Date.now(),
                ok: false,
                kind: "x402_inference",
                net: SOL_MAINNET,
                from: walletAddress ?? "",
                to: payment?.payTo,
                amount: payment?.amount,
                token: payment?.amount != null ? "USDC" : undefined,
                ms: Date.now() - startMs,
                error: `upstream_${response.status}`,
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
                  usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    prompt_tokens_details?: {
                      cached_tokens?: number;
                      cache_creation_input_tokens?: number;
                    };
                    completion_tokens_details?: { reasoning_tokens?: number };
                  };
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

                const usage = body.usage;
                const inTok = usage?.prompt_tokens ?? 0;
                const outTok = usage?.completion_tokens ?? 0;
                const model = body.model ?? "";
                const txSig = extractTxSignature(response);
                const durationMs = Date.now() - startMs;
                const providerName = allModels.find(
                  (m) => m.id === model || `${m.provider}/${m.id}` === model,
                )?.provider;

                const payment = paymentQueue.shift();
                appendHistory(historyPath, {
                  t: Date.now(),
                  ok: true,
                  kind: "x402_inference",
                  net: SOL_MAINNET,
                  from: walletAddress ?? "",
                  to: payment?.payTo,
                  tx: txSig,
                  amount: payment?.amount,
                  token: "USDC",
                  provider: providerName,
                  model,
                  inputTokens: inTok,
                  outputTokens: outTok,
                  reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
                  cacheRead: usage?.prompt_tokens_details?.cached_tokens,
                  cacheWrite: usage?.prompt_tokens_details?.cache_creation_input_tokens,
                  thinking: thinkingMode,
                  ms: durationMs,
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
            paymentQueue.shift();
            appendHistory(historyPath, {
              t: Date.now(),
              ok: false,
              kind: "x402_inference",
              net: SOL_MAINNET,
              from: walletAddress ?? "",
              ms: Date.now() - startMs,
              error: String(err).substring(0, 200),
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
        text: "Usage: `/x_wallet send <amount|all> <address>`\n\n  `/x_wallet send 0.5 7xKXtg...`\n  `/x_wallet send all 7xKXtg...`",
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
        ok: true,
        kind: "transfer",
        net: SOL_MAINNET,
        from: wallet,
        to: destAddr,
        tx: sig,
        amount: Number.parseFloat(amountUi),
        token: "USDC",
        label: `${destAddr.slice(0, 4)}...${destAddr.slice(-4)}`,
      });

      return {
        text: `Sent ${amountUi} USDC to \`${destAddr}\`\n[View transaction](https://solscan.io/tx/${sig})`,
      };
    } catch (err) {
      appendHistory(histPath, {
        t: Date.now(),
        ok: false,
        kind: "transfer",
        net: SOL_MAINNET,
        from: wallet,
        to: destAddr,
        token: "USDC",
        error: String(err).substring(0, 200),
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
      nav.push(`Newer: \`/x_wallet history${page === 2 ? "" : ` ${page - 1}`}\``);
    }
    if (start + HISTORY_PAGE_SIZE < totalTxs) {
      nav.push(`Older: \`/x_wallet history ${page + 1}\``);
    }
    if (nav.length > 0) {
      lines.push("", nav.join(" · "));
    }

    return { text: lines.join("\n") };
  }
}
