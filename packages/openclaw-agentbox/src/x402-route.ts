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
 * Uses registerHttpHandler (not registerHttpRoute) because registerHttpRoute
 * does exact path matching and we need prefix matching on /x402/*.
 *
 * The handler intercepts requests to /x402/*, strips the prefix, builds the
 * upstream URL, and forwards via the x402-wrapped fetch. For chat completions,
 * it forces stream:false (x402 payment is synchronous) and wraps the JSON
 * response as SSE for pi-ai compatibility.
 */
export function createX402RouteHandler(
  opts: X402RouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { upstreamOrigin, proxy, getWalletAddress, historyPath, allModels, logger } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/x402/")) return false;

    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Wallet not loaded yet", code: "not_ready" } }));
      return true;
    }

    // Strip /x402 prefix, build upstream URL
    const pathSuffix = url.pathname.slice(5); // e.g., "/v1/chat/completions"
    const upstreamUrl = upstreamOrigin + pathSuffix + url.search;

    logger.info(`x402: intercepting ${upstreamUrl.substring(0, 80)}`);

    // Read request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks).toString("utf-8");

    // Build headers, strip gateway auth and host
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (key === "authorization" || key === "host" || key === "connection") continue;
      if (typeof val === "string") headers[key] = val;
    }

    // Force stream:false for chat completions (x402 payment is synchronous).
    // OpenClaw's pi-ai layer hardcodes stream:true (not configurable),
    // so we force stream:false here and wrap the response as SSE below.
    const isChatCompletion = pathSuffix.includes("/chat/completions");
    let thinkingMode: string | undefined;
    if (isChatCompletion && body) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed.stream === true) {
          parsed.stream = false;
          body = JSON.stringify(parsed);
          logger.info("x402: forced stream: false in request body");
        }
        if (parsed.reasoning_effort) thinkingMode = String(parsed.reasoning_effort);
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
        return true;
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
        return true;
      }

      logger.info(`x402: response ${response.status}`);

      // Non-streaming JSON response wrapped as SSE for pi-ai compatibility
      const ct = response.headers.get("content-type") || "";
      if (isChatCompletion && response.ok && ct.includes("application/json")) {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as {
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
          if (parsed.choices) {
            for (const c of parsed.choices) {
              if (c.message && !c.delta) {
                c.delta = c.message;
                delete c.message;
              }
            }
          }

          const usage = parsed.usage;
          const inTok = usage?.prompt_tokens ?? 0;
          const outTok = usage?.completion_tokens ?? 0;
          const model = parsed.model ?? "";
          const txSig = extractTxSignature(response);
          const durationMs = Date.now() - startMs;
          const providerName = allModels.find(
            (m) => m.id === model || `${m.provider}/${m.id}` === model,
          )?.provider;

          const payment = proxy.shiftPayment();
          const amount = paymentAmount(payment);
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

          logger.info("x402: wrapped JSON response as SSE");
          const sse = `data: ${JSON.stringify(parsed)}\n\ndata: [DONE]\n\n`;
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.end(sse);
          return true;
        } catch {
          res.writeHead(response.status, { "Content-Type": ct });
          res.end(text);
          return true;
        }
      }

      // Default: pipe response through
      const resHeaders: Record<string, string> = {};
      for (const [key, val] of response.headers.entries()) {
        resHeaders[key] = val;
      }
      res.writeHead(response.status, resHeaders);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
      return true;
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
      return true;
    }
  };
}
