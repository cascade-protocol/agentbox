import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const HISTORY_MAX_LINES = 1000;
export const HISTORY_KEEP_LINES = 500;
export const HISTORY_PAGE_SIZE = 5;
export const STATUS_HISTORY_COUNT = 3;
export const INLINE_HISTORY_TOKEN_THRESHOLD = 3;

// --- Record type ---

export type TxRecord = {
  t: number;
  ok: boolean;
  kind: "x402_inference" | "x402_payment" | "transfer" | "buy" | "sell" | "mint" | "swap";
  net: string;
  from: string;
  to?: string;
  tx?: string;
  amount?: number;
  token?: string;
  label?: string;
  ms?: number;
  error?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: string;
  meta?: Record<string, string | number>;
};

// --- File operations ---

export function appendHistory(historyPath: string, record: TxRecord): void {
  try {
    appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
    if (existsSync(historyPath)) {
      const stat = statSync(historyPath);
      if (stat.size > HISTORY_MAX_LINES * 200) {
        const lines = readFileSync(historyPath, "utf-8").trimEnd().split("\n");
        if (lines.length > HISTORY_MAX_LINES) {
          writeFileSync(historyPath, `${lines.slice(-HISTORY_KEEP_LINES).join("\n")}\n`);
        }
      }
    }
  } catch {
    // History is non-critical - never break the plugin
  }
}

export function readHistory(historyPath: string): TxRecord[] {
  try {
    if (!existsSync(historyPath)) return [];
    const content = readFileSync(historyPath, "utf-8").trimEnd();
    if (!content) return [];
    return content.split("\n").flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.t !== "number" || typeof parsed.kind !== "string") return [];
        return [parsed as TxRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// --- Spend aggregation ---

export function calcSpend(records: TxRecord[]): {
  today: number;
  total: number;
  count: number;
} {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  let today = 0;
  let total = 0;
  let count = 0;
  for (const r of records) {
    if (!r.ok || r.amount == null) continue;
    if (r.token !== "USDC") continue;
    total += r.amount;
    count++;
    if (r.t >= todayMs) today += r.amount;
  }
  return { today, total, count };
}

// --- Formatting ---

function formatAmount(amount: number, token: string): string {
  if (token === "USDC") {
    if (amount >= 0.01) return `${amount.toFixed(2)} USDC`;
    if (amount >= 0.001) return `${amount.toFixed(3)} USDC`;
    if (amount >= 0.0001) return `${amount.toFixed(4)} USDC`;
    return `${amount.toFixed(6)} USDC`;
  }
  if (token === "SOL") return `${amount} SOL`;
  return `${amount} ${token}`;
}

const KIND_LABELS: Record<TxRecord["kind"], string> = {
  x402_inference: "inference",
  x402_payment: "payment",
  transfer: "transfer",
  buy: "buy",
  sell: "sell",
  mint: "mint",
  swap: "swap",
};

export function explorerUrl(net: string, tx: string): string {
  if (net.startsWith("eip155:")) {
    const chainId = net.split(":")[1];
    if (chainId === "8453") return `https://basescan.org/tx/${tx}`;
    if (chainId === "84532") return `https://sepolia.basescan.org/tx/${tx}`;
    if (chainId === "1") return `https://etherscan.io/tx/${tx}`;
    return `https://basescan.org/tx/${tx}`;
  }
  return `https://solscan.io/tx/${tx}`;
}

export function formatTxLine(r: TxRecord): string {
  const time = new Date(r.t).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const timeStr = r.tx ? `[${time}](${explorerUrl(r.net, r.tx)})` : time;
  const action = KIND_LABELS[r.kind] ?? r.kind;
  const parts = [action];
  if (r.label) parts.push(r.label);
  if (r.ok && r.amount != null && r.token) {
    parts.push(formatAmount(r.amount, r.token));
  } else if (r.ok && r.kind === "sell" && r.meta?.pct != null) {
    parts.push(`${r.meta.pct}%`);
  }
  const prefix = r.ok ? "" : "✗ ";
  return `  ${timeStr} ${prefix}${parts.join(" · ")}`;
}

// --- Token symbol resolution ---

const tokenSymbolCache = new Map<string, string>();

export async function resolveTokenSymbols(mints: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toResolve: string[] = [];

  for (const m of mints) {
    const cached = tokenSymbolCache.get(m);
    if (cached) {
      result.set(m, cached);
    } else {
      toResolve.push(m);
    }
  }

  if (toResolve.length === 0) return result;

  try {
    const res = await globalThis.fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${toResolve.join(",")}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return result;

    const pairs = (await res.json()) as Array<{
      baseToken?: { address?: string; symbol?: string };
    }>;

    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      const sym = pair.baseToken?.symbol;
      if (addr && sym && toResolve.includes(addr)) {
        tokenSymbolCache.set(addr, sym);
        result.set(addr, sym);
      }
    }
  } catch {
    // DexScreener unavailable - return what we have from cache
  }

  return result;
}
