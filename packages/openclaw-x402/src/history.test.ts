import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendHistory,
  calcSpend,
  explorerUrl,
  formatTxLine,
  HISTORY_KEEP_LINES,
  HISTORY_MAX_LINES,
  readHistory,
  resolveTokenSymbols,
  type TxRecord,
} from "./history.js";

const SOL_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE_NET = "eip155:8453";
const WALLET = "J5UHSLvEuFTEyrZZgjwkSHicZbLYCNz3J5ZhpJt7BLfT";

function makeRecord(overrides: Partial<TxRecord> = {}): TxRecord {
  return {
    t: Date.now(),
    ok: true,
    kind: "x402_inference",
    net: SOL_NET,
    from: WALLET,
    ...overrides,
  };
}

// --- readHistory / appendHistory ---

describe("file operations", () => {
  let tmpDir: string;
  let historyPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "x402-test-"));
    historyPath = join(tmpDir, "history.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("append and read roundtrip", () => {
    const record = makeRecord({
      tx: "abc123",
      amount: 0.003,
      token: "USDC",
      model: "kimi-k2.5",
      provider: "agentbox",
    });
    appendHistory(historyPath, record);
    const records = readHistory(historyPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);
  });

  test("appends multiple records", () => {
    appendHistory(historyPath, makeRecord({ kind: "x402_inference" }));
    appendHistory(historyPath, makeRecord({ kind: "transfer" }));
    appendHistory(
      historyPath,
      makeRecord({ kind: "buy", ok: false, error: "insufficient_balance" }),
    );
    expect(readHistory(historyPath)).toHaveLength(3);
  });

  test("read returns empty for nonexistent file", () => {
    expect(readHistory(join(tmpDir, "missing.jsonl"))).toEqual([]);
  });

  test("read skips malformed lines", () => {
    writeFileSync(
      historyPath,
      `${[JSON.stringify(makeRecord({ t: 1 })), "NOT_JSON", JSON.stringify(makeRecord({ t: 2 }))].join("\n")}\n`,
    );
    const records = readHistory(historyPath);
    expect(records).toHaveLength(2);
    expect(records[0].t).toBe(1);
    expect(records[1].t).toBe(2);
  });

  test("read skips records missing required fields", () => {
    writeFileSync(
      historyPath,
      `${[
        JSON.stringify(makeRecord({ t: 1 })),
        JSON.stringify({ ok: true, from: WALLET }),
        JSON.stringify({ t: 3 }),
        JSON.stringify(makeRecord({ t: 4 })),
      ].join("\n")}\n`,
    );
    const records = readHistory(historyPath);
    expect(records).toHaveLength(2);
    expect(records[0].t).toBe(1);
    expect(records[1].t).toBe(4);
  });

  test("truncates when exceeding max lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < HISTORY_MAX_LINES + 50; i++) {
      lines.push(JSON.stringify(makeRecord({ t: i, label: "x".repeat(150) })));
    }
    writeFileSync(historyPath, `${lines.join("\n")}\n`);

    appendHistory(historyPath, makeRecord({ t: 999999 }));

    const records = readHistory(historyPath);
    expect(records).toHaveLength(HISTORY_KEEP_LINES);
    expect(records[records.length - 1].t).toBe(999999);
  });

  test("preserves all fields through roundtrip", () => {
    const full: TxRecord = {
      t: 1709654400000,
      ok: true,
      kind: "x402_inference",
      net: SOL_NET,
      from: WALLET,
      to: "Provider111111111111111111111111111111111111",
      tx: "5KtPn1LGuxhFiwjxErkxTb3ypMesas5hy8jJSk2Vx123",
      amount: 0.0034,
      token: "USDC",
      label: "kimi-k2.5",
      ms: 1250,
      provider: "agentbox",
      model: "kimi-k2.5",
      inputTokens: 1200,
      outputTokens: 340,
      reasoningTokens: 0,
      cacheRead: 800,
      cacheWrite: 400,
      thinking: "off",
      meta: { reasoningEffort: "high" },
    };
    appendHistory(historyPath, full);
    const [record] = readHistory(historyPath);
    expect(record).toEqual(full);
  });

  test("preserves failed record with error", () => {
    const failed: TxRecord = {
      t: 1709654400000,
      ok: false,
      kind: "buy",
      net: SOL_NET,
      from: WALLET,
      error: "insufficient_balance",
      label: "DOGWIF",
      ms: 450,
    };
    appendHistory(historyPath, failed);
    const [record] = readHistory(historyPath);
    expect(record).toEqual(failed);
    expect(record.ok).toBe(false);
    expect(record.error).toBe("insufficient_balance");
    expect(record.tx).toBeUndefined();
    expect(record.amount).toBeUndefined();
  });

  test("handles empty file", () => {
    writeFileSync(historyPath, "");
    expect(readHistory(historyPath)).toEqual([]);
  });

  test("handles file with only whitespace", () => {
    writeFileSync(historyPath, "\n\n  \n");
    expect(readHistory(historyPath)).toEqual([]);
  });
});

// --- calcSpend ---

describe("calcSpend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T15:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns zeros for empty records", () => {
    expect(calcSpend([])).toEqual({ today: 0, total: 0, count: 0 });
  });

  test("sums only USDC amounts from successful records", () => {
    const records: TxRecord[] = [
      makeRecord({ amount: 0.003, token: "USDC" }),
      makeRecord({ amount: 0.01, token: "USDC", ok: false, error: "failed" }),
      makeRecord({ amount: 0.5, token: "SOL", kind: "buy" }),
      makeRecord({ amount: 0.002, token: "USDC" }),
    ];
    const { total, count } = calcSpend(records);
    expect(total).toBeCloseTo(0.005);
    expect(count).toBe(2);
  });

  test("separates today from total", () => {
    const yesterday = new Date("2026-03-04T12:00:00Z").getTime();
    const todayTime = new Date("2026-03-05T10:00:00Z").getTime();
    const records: TxRecord[] = [
      makeRecord({ t: yesterday, amount: 1.0, token: "USDC" }),
      makeRecord({ t: todayTime, amount: 0.5, token: "USDC" }),
    ];
    const result = calcSpend(records);
    expect(result.total).toBeCloseTo(1.5);
    expect(result.today).toBeCloseTo(0.5);
    expect(result.count).toBe(2);
  });

  test("skips records without amount", () => {
    const records: TxRecord[] = [
      makeRecord({ token: "USDC" }), // no amount
      makeRecord({ amount: 0.01, token: "USDC" }),
    ];
    const result = calcSpend(records);
    expect(result.total).toBeCloseTo(0.01);
    expect(result.count).toBe(1);
  });

  test("ignores SOL trades in USDC spend", () => {
    const records: TxRecord[] = [
      makeRecord({ kind: "buy", amount: 2.0, token: "SOL" }),
      makeRecord({ kind: "sell", amount: 1.5, token: "SOL" }),
      makeRecord({ kind: "x402_inference", amount: 0.003, token: "USDC" }),
    ];
    const result = calcSpend(records);
    expect(result.total).toBeCloseTo(0.003);
    expect(result.count).toBe(1);
  });
});

// --- formatTxLine ---

describe("formatTxLine", () => {
  test("inference with Solana tx link", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T14:30:00Z").getTime(),
      tx: "abc123sig",
      amount: 0.005,
      token: "USDC",
      label: "kimi-k2.5",
    });
    const line = formatTxLine(r);
    expect(line).toContain("[14:30](https://solscan.io/tx/abc123sig)");
    expect(line).toContain("inference");
    expect(line).toContain("kimi-k2.5");
    expect(line).toContain("0.005 USDC");
  });

  test("x402_payment with amount", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T12:00:00Z").getTime(),
      kind: "x402_payment",
      tx: "pay456",
      amount: 0.01,
      token: "USDC",
      label: "weather-api.com",
    });
    const line = formatTxLine(r);
    expect(line).toContain("payment");
    expect(line).toContain("weather-api.com");
    expect(line).toContain("0.01 USDC");
  });

  test("failed record shows error prefix, no amount", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T10:00:00Z").getTime(),
      kind: "x402_payment",
      ok: false,
      error: "402_payment_rejected",
      label: "api.example.com",
    });
    const line = formatTxLine(r);
    expect(line).toContain("✗");
    expect(line).toContain("api.example.com");
    expect(line).not.toContain("USDC");
  });

  test("transfer shows label and amount", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T12:00:00Z").getTime(),
      kind: "transfer",
      tx: "sig789",
      amount: 5.0,
      token: "USDC",
      label: "7xKX...PsW3",
    });
    const line = formatTxLine(r);
    expect(line).toContain("transfer");
    expect(line).toContain("7xKX...PsW3");
    expect(line).toContain("5.00 USDC");
  });

  test("buy shows SOL amount", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T08:00:00Z").getTime(),
      kind: "buy",
      tx: "tradesig",
      amount: 0.5,
      token: "SOL",
      label: "DOGWIF",
    });
    const line = formatTxLine(r);
    expect(line).toContain("buy");
    expect(line).toContain("DOGWIF");
    expect(line).toContain("0.5 SOL");
  });

  test("sell shows percentage from meta", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T08:00:00Z").getTime(),
      kind: "sell",
      tx: "sellsig",
      label: "DOGWIF",
      meta: { pct: 50 },
    });
    const line = formatTxLine(r);
    expect(line).toContain("sell");
    expect(line).toContain("DOGWIF");
    expect(line).toContain("50%");
    expect(line).not.toContain("SOL");
  });

  test("no tx shows plain time without link", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T09:15:00Z").getTime(),
      ok: false,
      error: "rpc_timeout",
    });
    const line = formatTxLine(r);
    expect(line).toContain("09:15");
    expect(line).not.toContain("solscan.io");
  });

  test("EVM tx links to basescan", () => {
    const r = makeRecord({
      t: new Date("2026-03-05T11:00:00Z").getTime(),
      net: BASE_NET,
      kind: "x402_payment",
      tx: "0xabc123",
      amount: 0.01,
      token: "USDC",
      label: "api.example.com",
    });
    const line = formatTxLine(r);
    expect(line).toContain("basescan.org/tx/0xabc123");
  });

  test("USDC micro-amounts show enough precision", () => {
    const r = makeRecord({
      tx: "sig",
      amount: 0.000042,
      token: "USDC",
    });
    const line = formatTxLine(r);
    expect(line).toContain("0.0000");
    expect(line).not.toContain("0.00 USDC");
  });
});

// --- explorerUrl ---

describe("explorerUrl", () => {
  test("solana mainnet", () => {
    expect(explorerUrl(SOL_NET, "abc")).toBe("https://solscan.io/tx/abc");
  });

  test("base mainnet", () => {
    expect(explorerUrl(BASE_NET, "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });

  test("base sepolia", () => {
    expect(explorerUrl("eip155:84532", "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  test("ethereum mainnet", () => {
    expect(explorerUrl("eip155:1", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
  });
});

// --- resolveTokenSymbols ---

describe("resolveTokenSymbols", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("resolves symbols from API", async () => {
    const mint = "ResolveTest111111111111111111111111111111111";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ baseToken: { address: mint, symbol: "TST" } }])),
        ),
    );
    const result = await resolveTokenSymbols([mint]);
    expect(result.get(mint)).toBe("TST");
  });

  test("returns empty on API failure", async () => {
    const mint = "FailTest2222222222222222222222222222222222222";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("error", { status: 500 })));
    const result = await resolveTokenSymbols([mint]);
    expect(result.has(mint)).toBe(false);
  });

  test("returns empty on network error", async () => {
    const mint = "ErrorTest444444444444444444444444444444444444";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("timeout")));
    const result = await resolveTokenSymbols([mint]);
    expect(result.has(mint)).toBe(false);
  });
});
