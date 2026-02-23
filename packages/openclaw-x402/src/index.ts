import { readFileSync } from "node:fs";
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
    id: "nvidia/gpt-oss-120b",
    name: "NVIDIA GPT-OSS 120B (free)",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.14, cacheWrite: 0.28 },
    contextWindow: 65536,
    maxTokens: 8192,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.15, cacheWrite: 0.3 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0.3, output: 2.5, cacheRead: 0.015, cacheWrite: 0.3 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
    contextWindow: 1047576,
    maxTokens: 32768,
  },
];

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, string>;
  const keypairPath = config.keypairPath || "/home/openclaw/.config/solana/id.json";
  const providerUrl = config.providerUrl || "";
  const providerName = config.providerName || "blockrun";
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

  api.registerCommand({
    name: "balance-x402",
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
    name: "send-x402",
    description: "Send USDC to a Solana address. Usage: /send-x402 <amount|all> <address>",
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
          text: "Usage: /send-x402 <amount|all> <address>\nExamples:\n  /send-x402 0.5 7xKXtg...\n  /send-x402 all 7xKXtg...",
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

  api.registerCommand({
    name: "pricing-x402",
    description: "Show model pricing from the x402 provider",
    acceptsArgs: false,
    handler: async () => {
      try {
        const res = await globalThis.fetch(`${baseUrl}/models`);
        if (!res.ok) {
          return { text: `Failed to fetch models: HTTP ${res.status}` };
        }
        const json = (await res.json()) as {
          data?: Array<{
            id: string;
            billing_mode?: string;
            pricing?: { input?: number; output?: number };
          }>;
        };
        const models = json.data ?? [];
        if (models.length === 0) {
          return { text: "No models returned from provider." };
        }

        const curatedIds = new Set(CURATED_MODELS.map((m) => m.id));
        const lines = [`**${providerName} models** (${models.length} total)\n`];
        for (const m of models) {
          const tag = curatedIds.has(m.id) ? " [curated]" : "";
          const isFree = m.billing_mode === "free";
          const pricing = isFree
            ? " - free"
            : m.pricing
              ? ` - $${m.pricing.input ?? "?"}/M in, $${m.pricing.output ?? "?"}/M out`
              : "";
          lines.push(`- \`${m.id}\`${pricing}${tag}`);
        }
        lines.push("", `Use \`${providerName}/<model-id>\` to select a model.`);
        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Failed to fetch models: ${String(err)}` };
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
