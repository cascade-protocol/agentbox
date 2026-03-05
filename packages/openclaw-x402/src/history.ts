import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const HISTORY_MAX_LINES = 1000;
export const HISTORY_KEEP_LINES = 500;
export const HISTORY_PAGE_SIZE = 5;
export const STATUS_HISTORY_COUNT = 3;
export const INLINE_HISTORY_TOKEN_THRESHOLD = 3;

export type HistoryRecord = {
  t: number; // epoch ms
  k: "inference" | "x402" | "send" | "trade";
  ok: boolean;
  tx?: string; // solana signature
  ms?: number; // duration
  m?: string; // model (inference)
  in?: number; // input tokens
  out?: number; // output tokens
  c?: number; // estimated cost USD
  u?: string; // url (x402)
  s?: number; // http status
  to?: string; // recipient (send)
  amt?: number; // amount
  cur?: string; // currency
  act?: string; // buy/sell/create (trade)
  token?: string; // mint (trade)
  sol?: number; // SOL amount (trade)
};

export function appendHistory(historyPath: string, record: HistoryRecord): void {
  try {
    appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
    if (existsSync(historyPath)) {
      const stat = statSync(historyPath);
      if (stat.size > HISTORY_MAX_LINES * 120) {
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

export function readHistory(historyPath: string): HistoryRecord[] {
  try {
    if (!existsSync(historyPath)) return [];
    const content = readFileSync(historyPath, "utf-8").trimEnd();
    if (!content) return [];
    return content.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function calcSpend(records: HistoryRecord[]): {
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
    if (!r.ok) continue;
    const cost = r.c ?? 0;
    total += cost;
    count++;
    if (r.t >= todayMs) today += cost;
  }
  return { today, total, count };
}

// --- Transaction line formatting ---

function getTxParts(r: HistoryRecord): { action: string; detail: string; amount: string } {
  switch (r.k) {
    case "inference": {
      const model = r.m ? (r.m.split("/").pop() ?? r.m) : "unknown";
      return {
        action: "inference",
        detail: model,
        amount: r.c != null ? `${r.c.toFixed(3)} USDC` : "",
      };
    }
    case "x402": {
      let host = r.u ?? "unknown";
      try {
        if (r.u) host = new URL(r.u).hostname;
      } catch {
        // keep raw value
      }
      return {
        action: "x402",
        detail: host,
        amount: r.c != null ? `${r.c.toFixed(3)} USDC` : "",
      };
    }
    case "send": {
      const dest = r.to ? `${r.to.slice(0, 4)}...${r.to.slice(-4)}` : "unknown";
      return {
        action: "send",
        detail: dest,
        amount: r.amt != null ? `${r.amt.toFixed(2)} USDC` : "",
      };
    }
    case "trade": {
      const tokenShort = r.token ? r.token.slice(0, 8) : "token";
      return {
        action: r.act ?? "trade",
        detail: tokenShort,
        amount: r.sol != null ? `${r.sol} SOL` : "",
      };
    }
    default:
      return { action: "unknown", detail: "", amount: "" };
  }
}

export function formatTxLine(r: HistoryRecord): string {
  const time = new Date(r.t).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const timeStr = r.tx ? `[${time}](https://solscan.io/tx/${r.tx})` : time;
  const { action, detail, amount } = getTxParts(r);
  const parts = [action, detail, ...(r.ok ? [amount] : [])].filter(Boolean);
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
