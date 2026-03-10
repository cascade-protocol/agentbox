import { Type } from "@sinclair/typebox";
import { generateKeyPair, getAddressFromPublicKey, type KeyPairSigner } from "@solana/kit";
import {
  appendHistory,
  calcSpend,
  extractTxSignature,
  type PaymentInfo,
  readHistory,
  type X402ProxyHandler,
} from "x402-proxy";
import {
  BagsNoRouteError,
  getSolBalance,
  getTokenAccounts,
  getTokenDecimals,
  getUsdcBalance,
  JupiterNoRouteError,
  launchOnBags,
  SOL_MINT,
  signAndSendPumpPortalTx,
  swapViaBags,
  swapViaJupiter,
} from "./solana.js";

export const SOL_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_DECIMALS = 6;
const INFERENCE_RESERVE = 0.3;
const MAX_RESPONSE_CHARS = 50_000;

/** Convert raw base-unit amount string from PaymentInfo to human-readable number */
export function paymentAmount(payment: PaymentInfo | undefined): number | undefined {
  if (!payment?.amount) return undefined;
  const parsed = Number.parseFloat(payment.amount);
  return Number.isNaN(parsed) ? undefined : parsed / 10 ** USDC_DECIMALS;
}

export type ModelEntry = {
  provider: string;
  id: string;
  name: string;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
};

export type ToolContext = {
  getWalletAddress: () => string | null;
  getSigner: () => KeyPairSigner | null;
  rpcUrl: string;
  bagsApiKey: string;
  historyPath: string;
  proxy: X402ProxyHandler;
  allModels: ModelEntry[];
};

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export async function getWalletSnapshot(rpcUrl: string, wallet: string, historyPath: string) {
  const [{ ui, raw }, sol, tokens] = await Promise.all([
    getUsdcBalance(rpcUrl, wallet),
    getSolBalance(rpcUrl, wallet),
    getTokenAccounts(rpcUrl, wallet).catch(() => []),
  ]);
  const records = readHistory(historyPath);
  const spend = calcSpend(records);
  return { ui, raw, sol, tokens, records, spend };
}

export function createBalanceTool(ctx: ToolContext) {
  return {
    name: "x_balance",
    label: "Wallet Balance",
    description:
      "Check wallet SOL and USDC balances. Use before making payments or trades to verify sufficient funds.",
    parameters: Type.Object({}),
    async execute() {
      const walletAddress = ctx.getWalletAddress();
      if (!walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }
      try {
        const snap = await getWalletSnapshot(ctx.rpcUrl, walletAddress, ctx.historyPath);
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
  };
}

export function createPaymentTool(ctx: ToolContext) {
  return {
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
    async execute(
      _id: string,
      params: { url: string; method?: string; params?: string; headers?: string },
    ) {
      const walletAddress = ctx.getWalletAddress();
      if (!walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      try {
        const { ui } = await getUsdcBalance(ctx.rpcUrl, walletAddress);
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
        const response = await ctx.proxy.x402Fetch(url, reqInit);
        const body = await response.text();

        if (response.status === 402) {
          ctx.proxy.shiftPayment();
          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: false,
            kind: "x402_payment",
            net: SOL_MAINNET,
            from: walletAddress,
            label: url,
            ms: Date.now() - toolStartMs,
            error: "payment_required",
          });
          return toolResult(
            `Payment failed (402): ${body.substring(0, 500)}. Wallet: ${walletAddress}`,
          );
        }

        const payment = ctx.proxy.shiftPayment();
        const amount = paymentAmount(payment);
        appendHistory(ctx.historyPath, {
          t: Date.now(),
          ok: true,
          kind: "x402_payment",
          net: SOL_MAINNET,
          from: walletAddress,
          to: payment?.payTo,
          tx: extractTxSignature(response),
          amount,
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
        ctx.proxy.shiftPayment();
        appendHistory(ctx.historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_payment",
          net: SOL_MAINNET,
          from: walletAddress,
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
  };
}

export function createSwapTool(ctx: ToolContext) {
  return {
    name: "x_swap",
    label: "Token Swap",
    description:
      "Swap any Solana token for another. Provide mint addresses for both tokens. " +
      "Works for SOL, USDC, meme tokens, and any SPL token with DEX liquidity. " +
      "Routes through Jupiter, Bags.fm (Meteora DLMM), or PumpPortal automatically. " +
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
    async execute(
      _id: string,
      params: { inputMint: string; outputMint: string; amount: number; slippage?: number },
    ) {
      const signer = ctx.getSigner();
      const walletAddress = ctx.getWalletAddress();
      if (!signer || !walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      const slippageBps = params.slippage ?? 250;
      const inputShort = `${params.inputMint.slice(0, 4)}...${params.inputMint.slice(-4)}`;
      const outputShort = `${params.outputMint.slice(0, 4)}...${params.outputMint.slice(-4)}`;

      try {
        const inputDecimals = await getTokenDecimals(ctx.rpcUrl, params.inputMint);
        const amountRaw = String(Math.round(params.amount * 10 ** inputDecimals));

        let signature: string;
        let outAmountDisplay: string | undefined;
        try {
          const result = await swapViaJupiter(
            signer,
            ctx.rpcUrl,
            params.inputMint,
            params.outputMint,
            amountRaw,
            slippageBps,
          );
          signature = result.signature;
          const outDecimals = await getTokenDecimals(ctx.rpcUrl, params.outputMint);
          outAmountDisplay = (Number(result.outAmount) / 10 ** outDecimals).toFixed(
            Math.min(outDecimals, 6),
          );
        } catch (err) {
          if (!(err instanceof JupiterNoRouteError)) throw err;

          try {
            if (!ctx.bagsApiKey) throw new BagsNoRouteError("not configured");
            const result = await swapViaBags(
              signer,
              ctx.rpcUrl,
              ctx.bagsApiKey,
              params.inputMint,
              params.outputMint,
              amountRaw,
              slippageBps,
            );
            signature = result.signature;
            const outDecimals = await getTokenDecimals(ctx.rpcUrl, params.outputMint);
            outAmountDisplay = (Number(result.outAmount) / 10 ** outDecimals).toFixed(
              Math.min(outDecimals, 6),
            );
          } catch (bagsErr) {
            if (!(bagsErr instanceof BagsNoRouteError)) throw bagsErr;

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
              const holdings = await getTokenAccounts(ctx.rpcUrl, walletAddress);
              const holding = holdings.find((h) => h.mint === tokenMint);
              if (!holding || Number.parseFloat(holding.amount) === 0) {
                throw new Error(`No holdings found for token ${tokenMint}`);
              }
              const pct = Math.min(100, (params.amount / Number.parseFloat(holding.amount)) * 100);
              pumpParams.amount = `${Math.round(pct)}%`;
              pumpParams.denominatedInSol = "false";
            }

            signature = await signAndSendPumpPortalTx(signer, ctx.rpcUrl, pumpParams);
          }
        }

        appendHistory(ctx.historyPath, {
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
        appendHistory(ctx.historyPath, {
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
  };
}

export function createLaunchTokenTool(ctx: ToolContext) {
  return {
    name: "x_launch_token",
    label: "Launch Token",
    description:
      "Launch a new token with an initial dev buy. " +
      "Defaults to pump.fun. " +
      'Set platform to "bags" for Bags.fm (Meteora DLMM, creator earns 1% of all volume forever).',
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
        Type.Number({ description: "Slippage tolerance in % (default: 10, pump only)" }),
      ),
      platform: Type.Optional(
        Type.String({ description: 'Launch platform: "pump" (default) or "bags"' }),
      ),
    }),
    async execute(
      _id: string,
      params: {
        name: string;
        symbol: string;
        description: string;
        image_url?: string;
        initial_buy?: number;
        slippage?: number;
        platform?: string;
      },
    ) {
      const signer = ctx.getSigner();
      const walletAddress = ctx.getWalletAddress();
      if (!signer || !walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      const platform = params.platform === "bags" ? "bags" : "pump";
      const initialBuy = params.initial_buy ?? 0.05;
      const sol = await getSolBalance(ctx.rpcUrl, walletAddress);
      if (Number.parseFloat(sol) < initialBuy + 0.02) {
        return toolResult(
          `Insufficient SOL. Balance: ${sol} SOL, need ~${(initialBuy + 0.02).toFixed(3)} SOL (${initialBuy} buy + fees). Top up: ${walletAddress}`,
        );
      }

      let imageBlob: Blob;
      if (params.image_url) {
        const imgRes = await globalThis.fetch(params.image_url);
        if (!imgRes.ok) return toolResult(`Failed to fetch image: ${imgRes.status}`);
        imageBlob = await imgRes.blob();
      } else {
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
          "base64",
        );
        imageBlob = new Blob([png], { type: "image/png" });
      }

      if (platform === "bags") {
        if (!ctx.bagsApiKey) {
          return toolResult('Bags.fm API key not configured. Use platform: "pump" instead.');
        }
        try {
          const { signature, mint } = await launchOnBags(signer, ctx.rpcUrl, ctx.bagsApiKey, {
            name: params.name,
            symbol: params.symbol,
            description: params.description,
            imageBlob,
            initialBuyLamports: Math.round(initialBuy * 1e9),
          });

          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: true,
            kind: "mint",
            net: SOL_MAINNET,
            from: walletAddress,
            tx: signature,
            label: mint,
            amount: initialBuy,
            token: "SOL",
          });

          return toolResult(
            `Token launched on Bags.fm\nName: ${params.name} (${params.symbol})\nMint: ${mint}\nInitial buy: ${initialBuy} SOL\nhttps://bags.fm/token/${mint}\nhttps://solscan.io/tx/${signature}`,
          );
        } catch (err) {
          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: false,
            kind: "mint",
            net: SOL_MAINNET,
            from: walletAddress,
            error: String(err).substring(0, 200),
          });
          return toolResult(`Bags.fm launch failed: ${String(err)}`);
        }
      }

      // pump.fun via PumpPortal
      try {
        const mintKeyPair = await generateKeyPair();
        const mintAddress = await getAddressFromPublicKey(mintKeyPair.publicKey);

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
          signer,
          ctx.rpcUrl,
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

        appendHistory(ctx.historyPath, {
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
          `Token launched on pump.fun\nName: ${params.name} (${params.symbol})\nMint: ${mintAddress}\nInitial buy: ${initialBuy} SOL\nhttps://pump.fun/${mintAddress}\nhttps://solscan.io/tx/${signature}`,
        );
      } catch (err) {
        appendHistory(ctx.historyPath, {
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
  };
}

export function createTokenInfoTool() {
  return {
    name: "x_token_info",
    label: "Token Info",
    description:
      "Look up a Solana token by mint address, or omit mint to get trending tokens (most boosted on DexScreener).",
    parameters: Type.Object({
      mint: Type.Optional(
        Type.String({ description: "Token mint address. Omit to get trending Solana tokens." }),
      ),
    }),
    async execute(_id: string, params: { mint?: string }) {
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
  };
}
