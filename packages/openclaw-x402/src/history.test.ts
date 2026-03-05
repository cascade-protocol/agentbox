import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendHistory,
  calcSpend,
  formatTxLine,
  HISTORY_KEEP_LINES,
  HISTORY_MAX_LINES,
  type HistoryRecord,
  readHistory,
  resolveTokenSymbols,
} from "./history.js";

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

  test("counts only successful records", () => {
    const records: HistoryRecord[] = [
      { t: Date.now() - 1000, k: "inference", ok: true, c: 0.05 },
      { t: Date.now() - 2000, k: "inference", ok: false, c: 0.1 },
      { t: Date.now() - 3000, k: "x402", ok: true, c: 0.02 },
    ];
    const { total, count } = calcSpend(records);
    expect(total).toBeCloseTo(0.07);
    expect(count).toBe(2);
  });

  test("separates today from total spend", () => {
    const yesterday = new Date("2026-03-04T12:00:00Z").getTime();
    const today = new Date("2026-03-05T10:00:00Z").getTime();
    const records: HistoryRecord[] = [
      { t: yesterday, k: "inference", ok: true, c: 1.0 },
      { t: today, k: "inference", ok: true, c: 0.5 },
    ];
    const result = calcSpend(records);
    expect(result.total).toBeCloseTo(1.5);
    expect(result.today).toBeCloseTo(0.5);
    expect(result.count).toBe(2);
  });

  test("treats missing cost as zero", () => {
    const records: HistoryRecord[] = [{ t: Date.now(), k: "inference", ok: true }];
    const result = calcSpend(records);
    expect(result.total).toBe(0);
    expect(result.count).toBe(1);
  });
});

// --- formatTxLine ---

describe("formatTxLine", () => {
  test("inference with tx link", () => {
    const r: HistoryRecord = {
      t: new Date("2026-03-05T14:30:00Z").getTime(),
      k: "inference",
      ok: true,
      m: "provider/claude-sonnet-4",
      c: 0.005,
      tx: "abc123sig",
    };
    const line = formatTxLine(r);
    expect(line).toContain("[14:30](https://solscan.io/tx/abc123sig)");
    expect(line).toContain("inference");
    expect(line).toContain("claude-sonnet-4");
    expect(line).toContain("0.005 USDC");
  });

  test("failed record shows failure prefix without amount", () => {
    const r: HistoryRecord = {
      t: new Date("2026-03-05T10:00:00Z").getTime(),
      k: "x402",
      ok: false,
      u: "https://api.example.com/data",
    };
    const line = formatTxLine(r);
    expect(line).toContain("✗");
    expect(line).toContain("api.example.com");
    expect(line).not.toContain("USDC");
  });

  test("send truncates recipient address", () => {
    const r: HistoryRecord = {
      t: new Date("2026-03-05T12:00:00Z").getTime(),
      k: "send",
      ok: true,
      to: "7xKXtgWsLRmpwmCr1aG5Z4Hbz1a1qBMxr2fKyZhVPsW3",
      amt: 5.0,
    };
    const line = formatTxLine(r);
    expect(line).toContain("7xKX...PsW3");
    expect(line).toContain("5.00 USDC");
  });

  test("trade shows action and token prefix", () => {
    const r: HistoryRecord = {
      t: new Date("2026-03-05T08:00:00Z").getTime(),
      k: "trade",
      ok: true,
      act: "buy",
      token: "So11111111111111111111111111111111111111112",
      sol: 0.5,
    };
    const line = formatTxLine(r);
    expect(line).toContain("buy");
    expect(line).toContain("So111111");
    expect(line).toContain("0.5 SOL");
  });

  test("time without tx shows plain time", () => {
    const r: HistoryRecord = {
      t: new Date("2026-03-05T09:15:00Z").getTime(),
      k: "inference",
      ok: true,
      m: "gpt-4",
      c: 0.01,
    };
    const line = formatTxLine(r);
    expect(line).toContain("09:15");
    expect(line).not.toContain("solscan.io");
  });
});

// --- appendHistory / readHistory ---

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
    const record: HistoryRecord = { t: 1000, k: "inference", ok: true, c: 0.01 };
    appendHistory(historyPath, record);
    const records = readHistory(historyPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(record);
  });

  test("appends multiple records", () => {
    appendHistory(historyPath, { t: 1, k: "inference", ok: true });
    appendHistory(historyPath, { t: 2, k: "x402", ok: false });
    appendHistory(historyPath, { t: 3, k: "send", ok: true });
    expect(readHistory(historyPath)).toHaveLength(3);
  });

  test("read returns empty for nonexistent file", () => {
    expect(readHistory(join(tmpDir, "missing.jsonl"))).toEqual([]);
  });

  test("read skips malformed lines", () => {
    writeFileSync(
      historyPath,
      '{"t":1,"k":"inference","ok":true}\nNOT_JSON\n{"t":2,"k":"x402","ok":true}\n',
    );
    const records = readHistory(historyPath);
    expect(records).toHaveLength(2);
    expect(records[0].t).toBe(1);
    expect(records[1].t).toBe(2);
  });

  test("truncates when exceeding max lines", () => {
    // Each record ~130 bytes so total file size > HISTORY_MAX_LINES * 120
    const pad = "x".repeat(100);
    const lines: string[] = [];
    for (let i = 0; i < HISTORY_MAX_LINES + 50; i++) {
      lines.push(JSON.stringify({ t: i, k: "inference", ok: true, m: pad }));
    }
    writeFileSync(historyPath, `${lines.join("\n")}\n`);

    // Trigger truncation by appending one more
    appendHistory(historyPath, { t: 999999, k: "inference", ok: true, m: pad });

    const records = readHistory(historyPath);
    expect(records).toHaveLength(HISTORY_KEEP_LINES);
    expect(records[records.length - 1].t).toBe(999999);
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

  test("caches resolved symbols", async () => {
    const mint = "CacheTest33333333333333333333333333333333333";
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ baseToken: { address: mint, symbol: "CACHE" } }])),
      );
    vi.stubGlobal("fetch", mockFetch);

    await resolveTokenSymbols([mint]);
    expect(mockFetch).toHaveBeenCalledOnce();

    mockFetch.mockClear();
    const second = await resolveTokenSymbols([mint]);
    expect(second.get(mint)).toBe("CACHE");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns empty on network error", async () => {
    const mint = "ErrorTest444444444444444444444444444444444444";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("timeout")));
    const result = await resolveTokenSymbols([mint]);
    expect(result.has(mint)).toBe(false);
  });
});
