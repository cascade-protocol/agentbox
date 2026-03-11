import type { IncomingMessage, ServerResponse } from "node:http";
import { appendHistory, extractTxSignature, type X402ProxyHandler } from "x402-proxy";
import { type ModelEntry, paymentAmount, SOL_MAINNET } from "./tools.js";

export type X402RouteOptions = {
  upstreamOrigin: string;
  proxy: X402ProxyHandler;
  getWalletAddress: () => string | null;
  historyPath: string;
  allModels: Pick<ModelEntry, "provider" | "id">[];
  logger: { info: (msg: string) => void; error: (msg: string) => void };
};

/**
 * Create a gateway HTTP handler that proxies requests through x402 payment.
 *
 * Registered via registerHttpHandler to intercept all /x402/* requests.
 * Strips the prefix, builds the upstream URL, and forwards via x402-wrapped
 * fetch. SSE streams are piped through directly; usage is extracted from the
 * final data chunk for history logging.
 */
export function createX402RouteHandler(
  opts: X402RouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { upstreamOrigin, proxy, getWalletAddress, historyPath, allModels, logger } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Wallet not loaded yet", code: "not_ready" } }));
      return;
    }

    // Strip /x402 prefix, build upstream URL
    const pathSuffix = url.pathname.slice(5); // e.g., "/v1/chat/completions"
    const upstreamUrl = upstreamOrigin + pathSuffix + url.search;

    logger.info(`x402: intercepting ${upstreamUrl.substring(0, 80)}`);

    // Read request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks).toString("utf-8");

    // Strip hop-by-hop and gateway-internal headers before forwarding.
    // content-length/transfer-encoding MUST be stripped: body may be modified
    // (stream_options injection) and fetch() manages these automatically.
    const HOP_BY_HOP = new Set([
      "authorization",
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "keep-alive",
      "te",
      "upgrade",
    ]);
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key)) continue;
      if (typeof val === "string") headers[key] = val;
    }

    const isChatCompletion = pathSuffix.includes("/chat/completions");
    let thinkingMode: string | undefined;
    if (isChatCompletion && body) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed.reasoning_effort) thinkingMode = String(parsed.reasoning_effort);
        // Ensure streaming responses include usage in the final SSE chunk
        if (!parsed.stream_options) {
          parsed.stream_options = { include_usage: true };
          body = JSON.stringify(parsed);
        }
      } catch {
        // not JSON body, leave as-is
      }
    }

    const method = req.method ?? "GET";
    const startMs = Date.now();

    try {
      const response = await proxy.x402Fetch(upstreamUrl, {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
      });

      if (response.status === 402) {
        const responseBody = await response.text();
        logger.error(`x402: payment failed, raw response: ${responseBody}`);
        const payment = proxy.shiftPayment();
        const amount = paymentAmount(payment);
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_inference",
          net: SOL_MAINNET,
          from: walletAddress,
          to: payment?.payTo,
          amount,
          token: amount != null ? "USDC" : undefined,
          ms: Date.now() - startMs,
          error: "payment_required",
        });

        let userMessage: string;
        if (responseBody.includes("simulation") || responseBody.includes("Simulation")) {
          userMessage = `Insufficient USDC or SOL in wallet ${walletAddress}. Fund it with USDC (SPL token) to pay for inference.`;
        } else if (responseBody.includes("insufficient") || responseBody.includes("balance")) {
          userMessage = `Insufficient funds in wallet ${walletAddress}. Top up with USDC on Solana mainnet.`;
        } else {
          userMessage = `x402 payment failed: ${responseBody.substring(0, 200) || "unknown error"}. Wallet: ${walletAddress}`;
        }

        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: userMessage, type: "x402_payment_error", code: "payment_failed" },
          }),
        );
        return;
      }

      // Upstream failed after payment settled - don't retry (would trigger another payment)
      if (!response.ok && isChatCompletion) {
        const responseBody = await response.text();
        logger.error(`x402: upstream error ${response.status}: ${responseBody.substring(0, 300)}`);
        const payment = proxy.shiftPayment();
        const amount = paymentAmount(payment);
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_inference",
          net: SOL_MAINNET,
          from: walletAddress,
          to: payment?.payTo,
          amount,
          token: amount != null ? "USDC" : undefined,
          ms: Date.now() - startMs,
          error: `upstream_${response.status}`,
        });

        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `LLM provider temporarily unavailable (HTTP ${response.status}). Try again shortly.`,
              type: "x402_upstream_error",
              code: "upstream_failed",
            },
          }),
        );
        return;
      }

      logger.info(`x402: response ${response.status}`);

      const txSig = extractTxSignature(response);
      const payment = proxy.shiftPayment();
      const amount = paymentAmount(payment);

      // Pipe response through, intercepting SSE usage from the final data chunk
      const resHeaders: Record<string, string> = {};
      for (const [key, val] of response.headers.entries()) {
        resHeaders[key] = val;
      }
      res.writeHead(response.status, resHeaders);

      if (!response.body) {
        res.end();
        appendHistory(historyPath, {
          t: Date.now(),
          ok: true,
          kind: "x402_inference",
          net: SOL_MAINNET,
          from: walletAddress,
          to: payment?.payTo,
          tx: txSig,
          amount,
          token: "USDC",
          ms: Date.now() - startMs,
        });
        return;
      }

      const ct = response.headers.get("content-type") || "";
      const isSSE = isChatCompletion && ct.includes("text/event-stream");
      let lastDataLine = "";
      let residual = "";

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);

          if (isSSE) {
            const text = residual + decoder.decode(value, { stream: true });
            const lines = text.split("\n");
            residual = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("data: ") && line !== "data: [DONE]") {
                lastDataLine = line.slice(6);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      res.end();

      // Log history with usage extracted from the final SSE chunk
      const durationMs = Date.now() - startMs;
      if (isSSE && lastDataLine) {
        try {
          const parsed = JSON.parse(lastDataLine) as {
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
          };
          const usage = parsed.usage;
          const model = parsed.model ?? "";
          appendHistory(historyPath, {
            t: Date.now(),
            ok: true,
            kind: "x402_inference",
            net: SOL_MAINNET,
            from: walletAddress,
            to: payment?.payTo,
            tx: txSig,
            amount,
            token: "USDC",
            provider: allModels.find((m) => m.id === model || `${m.provider}/${m.id}` === model)
              ?.provider,
            model,
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
            cacheRead: usage?.prompt_tokens_details?.cached_tokens,
            cacheWrite: usage?.prompt_tokens_details?.cache_creation_input_tokens,
            thinking: thinkingMode,
            ms: durationMs,
          });
        } catch {
          appendHistory(historyPath, {
            t: Date.now(),
            ok: true,
            kind: "x402_inference",
            net: SOL_MAINNET,
            from: walletAddress,
            to: payment?.payTo,
            tx: txSig,
            amount,
            token: "USDC",
            ms: durationMs,
          });
        }
      } else {
        appendHistory(historyPath, {
          t: Date.now(),
          ok: true,
          kind: "x402_inference",
          net: SOL_MAINNET,
          from: walletAddress,
          to: payment?.payTo,
          tx: txSig,
          amount,
          token: "USDC",
          ms: durationMs,
        });
      }
      return;
    } catch (err) {
      const msg = String(err);
      logger.error(`x402: fetch threw: ${msg}`);
      proxy.shiftPayment();
      appendHistory(historyPath, {
        t: Date.now(),
        ok: false,
        kind: "x402_inference",
        net: SOL_MAINNET,
        from: walletAddress,
        ms: Date.now() - startMs,
        error: msg.substring(0, 200),
      });

      let userMessage: string;
      if (msg.includes("Simulation failed") || msg.includes("simulation")) {
        userMessage = `Insufficient USDC or SOL in wallet ${walletAddress}. Fund it with USDC and SOL to pay for inference.`;
      } else if (msg.includes("Failed to create payment")) {
        userMessage = `x402 payment creation failed: ${msg}. Wallet: ${walletAddress}`;
      } else {
        userMessage = `x402 request failed: ${msg}`;
      }

      if (!res.headersSent) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: userMessage, type: "x402_payment_error", code: "payment_failed" },
          }),
        );
      }
    }
  };
}
