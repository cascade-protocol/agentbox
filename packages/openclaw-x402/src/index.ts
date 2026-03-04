import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { Type } from "@sinclair/typebox";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  checkAtaExists,
  getSolBalance,
  getUsdcBalance,
  signAndSendPumpPortalTx,
  transferUsdc,
} from "./solana.js";
import { deriveEvmKeypair, deriveSolanaKeypair } from "./wallet.js";

const INFERENCE_RESERVE = 0.3;
const MAX_RESPONSE_CHARS = 50_000;

const CURATED_MODELS = [
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 2048,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 2048,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 200000,
    maxTokens: 2048,
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 1.75, output: 14, cacheRead: 0.44, cacheWrite: 1.75 },
    contextWindow: 400000,
    maxTokens: 2048,
  },
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0.6, output: 3, cacheRead: 0.3, cacheWrite: 0.6 },
    contextWindow: 262144,
    maxTokens: 4096,
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0.23, output: 0.34, cacheRead: 0.12, cacheWrite: 0.23 },
    contextWindow: 163840,
    maxTokens: 4096,
  },
];

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const keypairPath =
    (config.keypairPath as string) || "/home/openclaw/.openclaw/agentbox/wallet-sol.json";
  const providerUrl = (config.providerUrl as string) || "";
  const providerName = (config.providerName as string) || "blockrun";
  const rpcUrl = (config.rpcUrl as string) || "https://api.mainnet-beta.solana.com";

  if (!providerUrl) {
    api.logger.error("openclaw-x402: providerUrl is required in plugin config");
    return;
  }

  const baseUrl = `${providerUrl.replace(/\/+$/, "")}/api/v1`;

  // registerProvider() only handles auth flows (OAuth, API key, device code).
  // These models are NOT used by the model resolution system - the actual catalog
  // comes from models.providers in openclaw.json (served by backend via OPENCLAW_BASE_CONFIG).
  api.registerProvider({
    id: providerName,
    label: `${providerName} (x402)`,
    auth: [],
    models: {
      baseUrl,
      api: "openai-completions",
      authHeader: false,
      models: CURATED_MODELS,
    },
  });

  api.logger.info(
    `openclaw-x402: registered provider "${providerName}" with ${CURATED_MODELS.length} models`,
  );

  let walletAddress: string | null = null;
  let signerRef: KeyPairSigner | null = null;
  let x402FetchRef:
    | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>)
    | null = null;

  // --- Slash commands ---

  api.registerCommand({
    name: "x_balance",
    description: "Show wallet balances and address",
    acceptsArgs: false,
    handler: async () => {
      if (!walletAddress) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }
      try {
        const [{ ui }, sol] = await Promise.all([
          getUsdcBalance(rpcUrl, walletAddress),
          getSolBalance(rpcUrl, walletAddress),
        ]);
        return {
          text: [
            `Wallet: ${walletAddress}`,
            `SOL: ${sol} SOL`,
            `USDC: $${ui}`,
            "",
            "To top up, send SOL or USDC (SPL) on Solana to:",
            walletAddress,
          ].join("\n"),
        };
      } catch (err) {
        return { text: `Failed to check balance: ${String(err)}` };
      }
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
        return { text: `Sent ${amountUi} USDC to ${destAddr}\nhttps://solscan.io/tx/${sig}` };
      } catch (err) {
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
        const [{ ui }, sol] = await Promise.all([
          getUsdcBalance(rpcUrl, walletAddress),
          getSolBalance(rpcUrl, walletAddress),
        ]);
        const total = Number.parseFloat(ui);
        const available = Math.max(0, total - INFERENCE_RESERVE);
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

      try {
        const response = await x402FetchRef(url, reqInit);
        const body = await response.text();

        if (response.status === 402) {
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

        const truncated =
          body.length > MAX_RESPONSE_CHARS
            ? `${body.substring(0, MAX_RESPONSE_CHARS)}\n\n[Truncated - response was ${body.length} chars]`
            : body;

        return {
          content: [{ type: "text" as const, text: `HTTP ${response.status}\n\n${truncated}` }],
          details: {},
        };
      } catch (err) {
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
      "Look up token data: price, market cap, volume, liquidity. Works for any Solana token.",
    parameters: Type.Object({
      mint: Type.String({ description: "Token mint address to look up" }),
    }),
    async execute(_id, params) {
      try {
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

        if (url.startsWith(providerUrl)) {
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

          try {
            const response = await x402Fetch(input, cleanInit);

            if (response.status === 402) {
              const body = await response.text();
              ctx.logger.error(`x402: payment failed, raw response: ${body}`);

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

      ctx.logger.info(`x402: fetch patched for ${providerUrl} (wallet: ${signer.address})`);
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
