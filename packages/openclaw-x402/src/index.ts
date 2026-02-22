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

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, string>;
  const keypairPath = config.keypairPath || "/home/openclaw/.config/solana/id.json";
  const providerUrl = config.providerUrl || "";
  const rpcUrl = config.rpcUrl || "https://api.mainnet-beta.solana.com";

  if (!providerUrl) {
    api.logger.error("openclaw-x402: providerUrl is required in plugin config");
    return;
  }

  api.logger.info(`openclaw-x402: patching fetch for ${providerUrl}`);

  let walletAddress: string | null = null;
  let signerRef: KeyPairSigner | null = null;

  api.registerCommand({
    name: "balance",
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
    name: "send",
    description: "Send USDC to a Solana address. Usage: /send <amount|all> <address>",
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
          text: "Usage: /send <amount|all> <address>\nExamples:\n  /send 0.5 7xKXtg...\n  /send all 7xKXtg...",
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
        if (msg.includes("insufficient") || msg.includes("lamports")) {
          return {
            text:
              "Insufficient SOL for transaction fees. Send a tiny amount of SOL to " +
              walletAddress,
          };
        }
        return { text: `Failed to send USDC: ${msg}` };
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
