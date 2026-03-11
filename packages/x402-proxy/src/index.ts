export type { ClientEvmSigner } from "@x402/evm";
export { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
// Re-exports for convenience - consumers don't need to depend on these directly
export { x402Client } from "@x402/fetch";
export { ExactSvmScheme } from "@x402/svm/exact/client";
export type { PaymentInfo, X402ProxyHandler, X402ProxyOptions } from "./handler.js";
export { createX402ProxyHandler, extractTxSignature } from "./handler.js";
export type { TxRecord } from "./history.js";
export {
  appendHistory,
  calcSpend,
  explorerUrl,
  formatTxLine,
  HISTORY_KEEP_LINES,
  HISTORY_MAX_LINES,
  readHistory,
} from "./history.js";
export { loadEvmWallet, loadSvmWallet } from "./wallet.js";
