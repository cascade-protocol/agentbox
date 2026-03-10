import type { x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";

export type PaymentInfo = {
  network: string | undefined;
  payTo: string | undefined;
  /** Raw amount in base units as returned by x402 (e.g. "50000" for 0.05 USDC) */
  amount: string | undefined;
  asset: string | undefined;
};

export type X402ProxyOptions = {
  client: x402Client;
};

export type X402ProxyHandler = {
  /** Wrapped fetch with x402 payment handling */
  x402Fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Shift the latest payment info from the queue (call after x402Fetch) */
  shiftPayment: () => PaymentInfo | undefined;
};

/**
 * Extract the on-chain transaction signature from an x402 payment response header.
 */
export function extractTxSignature(response: Response): string | undefined {
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

/**
 * Create an x402 proxy handler that wraps fetch with automatic payment.
 *
 * Chain-agnostic: accepts a pre-configured x402Client with any registered
 * schemes (SVM, EVM, etc). The handler captures payment info via the
 * onAfterPaymentCreation hook. Callers use `x402Fetch` for requests that
 * may require x402 payment, and `shiftPayment` to retrieve captured
 * payment info after each call.
 */
export function createX402ProxyHandler(opts: X402ProxyOptions): X402ProxyHandler {
  const { client } = opts;

  // Per-payment capture via queue. Hook pushes during createPaymentPayload,
  // caller shifts after wrapFetchWithPayment returns. Order is guaranteed
  // because the hook fires within the same async flow before the wrapper returns.
  const paymentQueue: PaymentInfo[] = [];

  client.onAfterPaymentCreation(async (hookCtx) => {
    const raw = hookCtx.selectedRequirements.amount;
    paymentQueue.push({
      network: hookCtx.selectedRequirements.network,
      payTo: hookCtx.selectedRequirements.payTo,
      amount: raw?.startsWith("debug.") ? raw.slice(6) : raw,
      asset: hookCtx.selectedRequirements.asset,
    });
  });

  const x402Fetch = wrapFetchWithPayment(globalThis.fetch, client);

  return {
    x402Fetch,
    shiftPayment: () => paymentQueue.shift(),
  };
}
