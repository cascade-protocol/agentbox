import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token-2022";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const INFERENCE_RESERVE_USDC = 0.3;
const ZAUTH_DIRECTORY_URL = "https://back.zauthx402.com/api/directory";
const MAX_RESPONSE_CHARS = 50000;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const TOKEN_PROGRAM: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

type UsdcBalance = { raw: bigint; ui: string };

async function getUsdcBalance(rpcUrl: string, owner: string): Promise<UsdcBalance> {
  const res = await globalThis.fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
    }),
  });
  const data = (await res.json()) as {
    result?: {
      value?: Array<{
        account: {
          data: { parsed: { info: { tokenAmount: { amount: string; uiAmountString?: string } } } };
        };
      }>;
    };
  };
  if (data.result?.value && data.result.value.length > 0) {
    const info = data.result.value[0].account.data.parsed.info.tokenAmount;
    return {
      raw: BigInt(info.amount),
      ui: info.uiAmountString || (Number(info.amount) / 1e6).toFixed(6),
    };
  }
  return { raw: 0n, ui: "0.00" };
}

async function checkAtaExists(rpcUrl: string, owner: string): Promise<boolean> {
  const [ata] = await findAssociatedTokenPda({
    mint: address(USDC_MINT),
    owner: address(owner),
    tokenProgram: TOKEN_PROGRAM,
  });
  const res = await globalThis.fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [ata, { encoding: "base64" }],
    }),
  });
  const data = (await res.json()) as { result?: { value: unknown } };
  return data.result?.value !== null && data.result?.value !== undefined;
}

const CURATED_MODELS = [
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
  const config = (api.pluginConfig ?? {}) as Record<string, string>;
  const keypairPath = config.keypairPath || "/home/openclaw/.openclaw/agentbox/wallet-sol.json";
  const providerUrl = config.providerUrl || "";
  const providerName = config.providerName || "aimo";
  const rpcUrl = config.rpcUrl || "https://api.mainnet-beta.solana.com";

  if (!providerUrl) {
    api.logger.error("openclaw-x402: providerUrl is required in plugin config");
    return;
  }

  const baseUrl = `${providerUrl.replace(/\/+$/, "")}/api/v1`;

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

  api.registerCommand({
    name: "x402_balance",
    description: "Show wallet USDC balance and address for topping up",
    acceptsArgs: false,
    handler: async () => {
      if (!walletAddress) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }
      try {
        const { ui } = await getUsdcBalance(rpcUrl, walletAddress);
        return {
          text: [
            `Wallet: ${walletAddress}`,
            `USDC balance: $${ui}`,
            "",
            "To top up, send USDC (SPL) on Solana to:",
            walletAddress,
          ].join("\n"),
        };
      } catch (err) {
        return { text: `Failed to check balance: ${String(err)}` };
      }
    },
  });

  api.registerCommand({
    name: "x402_send",
    description: "Send USDC to a Solana address. Usage: /x402_send <amount|all> <address>",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!walletAddress || !signerRef) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }
      const signer = signerRef;

      const args = ctx.args?.trim() ?? "";
      const parts = args.split(/\s+/);
      if (parts.length !== 2) {
        return {
          text: "Usage: /x402_send <amount|all> <address>\nExamples:\n  /x402_send 0.5 7xKXtg...\n  /x402_send all 7xKXtg...",
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

        const rpc = createSolanaRpc(rpcUrl);
        const usdcMint = address(USDC_MINT);

        const [sourceAta] = await findAssociatedTokenPda({
          mint: usdcMint,
          owner: address(walletAddress),
          tokenProgram: TOKEN_PROGRAM,
        });

        const [destAta] = await findAssociatedTokenPda({
          mint: usdcMint,
          owner: address(destAddr),
          tokenProgram: TOKEN_PROGRAM,
        });

        const transferIx = getTransferCheckedInstruction(
          {
            source: sourceAta,
            mint: usdcMint,
            destination: destAta,
            authority: signer,
            amount: amountRaw,
            decimals: USDC_DECIMALS,
          },
          { programAddress: TOKEN_PROGRAM },
        );

        const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

        const tx = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(signer.address, m),
          (m) => appendTransactionMessageInstructions([transferIx], m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        );

        const signed = await partiallySignTransactionMessageWithSigners(tx);
        const encoded = getBase64EncodedWireTransaction(signed);

        const sig = await rpc.sendTransaction(encoded, { encoding: "base64" }).send();

        return {
          text: `Sent ${amountUi} USDC to ${destAddr}\nhttps://solscan.io/tx/${sig}`,
        };
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
    name: "x402_balance",
    label: "x402 Balance",
    description:
      "Check the x402 wallet USDC balance and address. Use before making payments to verify sufficient funds.",
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
        const { ui } = await getUsdcBalance(rpcUrl, walletAddress);
        const total = Number.parseFloat(ui);
        const available = Math.max(0, total - INFERENCE_RESERVE_USDC);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Wallet: ${walletAddress}`,
                `Total USDC: $${ui}`,
                `Available for tools: $${available.toFixed(2)}`,
                `Reserved for inference: $${INFERENCE_RESERVE_USDC.toFixed(2)}`,
                "",
                "To top up, send USDC (SPL) on Solana to:",
                walletAddress,
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
    name: "x402_payment",
    label: "x402 Payment",
    description:
      "Call an x402-enabled paid API endpoint with automatic USDC payment on Solana. " +
      "Use this when you need to call a paid service discovered via x402_discover or given by the user. " +
      "Note: $0.30 USDC is reserved for LLM inference and cannot be spent by this tool.",
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

      // Check inference reserve
      try {
        const { ui } = await getUsdcBalance(rpcUrl, walletAddress);
        const balance = Number.parseFloat(ui);
        if (balance <= INFERENCE_RESERVE_USDC) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Insufficient funds. Balance: $${ui}, reserved for inference: $${INFERENCE_RESERVE_USDC.toFixed(2)}. ` +
                  `Top up wallet: ${walletAddress}`,
              },
            ],
            details: {},
          };
        }
      } catch {
        // If balance check fails, proceed anyway - x402Fetch will fail on payment if truly broke
      }

      const method = (params.method || "GET").toUpperCase();
      let url = params.url;
      const reqInit: RequestInit = { method };

      // Parse headers
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

      // Handle params
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
                text:
                  `Payment failed (402): ${body.substring(0, 500)}. ` + `Wallet: ${walletAddress}`,
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
          content: [
            {
              type: "text" as const,
              text: `HTTP ${response.status}\n\n${truncated}`,
            },
          ],
          details: {},
        };
      } catch (err) {
        const msg = String(err);
        let text: string;
        if (msg.includes("Simulation failed") || msg.includes("insufficient")) {
          text = `Payment failed - insufficient funds. Wallet: ${walletAddress}. Error: ${msg}`;
        } else {
          text = `Request failed: ${msg}`;
        }
        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      }
    },
  });

  api.registerTool({
    name: "x402_discover",
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
      const url = new URL(ZAUTH_DIRECTORY_URL);
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
      client.register(SOLANA_MAINNET, new ExactSvmScheme(signer, { rpcUrl }));

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
          // Only applies to chat completions, not /models or other endpoints.
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

            ctx.logger.info(`x402: response ${response.status}`);

            // Non-streaming JSON response needs to be wrapped as SSE because
            // pi-ai's OpenAI SDK expects streaming format (choices[].delta).
            const ct = response.headers.get("content-type") || "";
            if (isChatCompletion && response.ok && ct.includes("application/json")) {
              const text = await response.text();
              try {
                const body = JSON.parse(text) as {
                  choices?: Array<{
                    message?: unknown;
                    delta?: unknown;
                  }>;
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
                // Parse failed, return original text as-is
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
}
