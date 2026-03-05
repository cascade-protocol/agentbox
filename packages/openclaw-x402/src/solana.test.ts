import { afterEach, describe, expect, test, vi } from "vitest";
import { getTokenDecimals, JupiterNoRouteError, SOL_MINT } from "./solana.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FAKE_RPC = "https://rpc.example.com";
const FAKE_MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

// --- getTokenDecimals ---

describe("getTokenDecimals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns 9 for SOL mint without RPC call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const decimals = await getTokenDecimals(FAKE_RPC, SOL_MINT);
    expect(decimals).toBe(9);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns 6 for USDC mint without RPC call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const decimals = await getTokenDecimals(FAKE_RPC, USDC_MINT);
    expect(decimals).toBe(6);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("queries RPC for unknown mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              value: {
                data: { parsed: { info: { decimals: 8 } } },
              },
            },
          }),
        ),
      ),
    );
    const decimals = await getTokenDecimals(FAKE_RPC, FAKE_MINT);
    expect(decimals).toBe(8);
  });

  test("throws for nonexistent mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { value: null },
          }),
        ),
      ),
    );
    await expect(getTokenDecimals(FAKE_RPC, FAKE_MINT)).rejects.toThrow("Token mint not found");
  });
});

// --- JupiterNoRouteError ---

describe("JupiterNoRouteError", () => {
  test("is an Error with correct name", () => {
    const err = new JupiterNoRouteError("No route found");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("JupiterNoRouteError");
    expect(err.message).toBe("No route found");
  });

  test("can be caught with instanceof", () => {
    try {
      throw new JupiterNoRouteError("test");
    } catch (e) {
      expect(e instanceof JupiterNoRouteError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });
});

// --- swapViaJupiter ---
// The full function depends on @solana/kit transaction signing which requires
// real keypairs and transaction bytes. We test the HTTP interaction and error
// handling here. Integration tests with real swaps are covered by smoke tests.

describe("swapViaJupiter fetch interactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("throws JupiterNoRouteError on quote 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Could not find any route" }), { status: 400 }),
        ),
    );

    // Import dynamically so the stubbed fetch is used
    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "FakeAddress11111111111111111111111111111111" } as never;

    await expect(
      swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "1000000000", 250),
    ).rejects.toThrow(JupiterNoRouteError);
  });

  test("throws JupiterNoRouteError when quote body has error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: "TOKEN_NOT_TRADABLE", inAmount: "0", outAmount: "0" }),
            { status: 200 },
          ),
        ),
    );

    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "FakeAddress11111111111111111111111111111111" } as never;

    await expect(
      swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "1000000000", 250),
    ).rejects.toThrow(JupiterNoRouteError);
  });

  test("throws regular error on swap endpoint failure", async () => {
    const mockFetch = vi.fn();
    // Quote succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ inAmount: "1000000000", outAmount: "150000000" }), {
        status: 200,
      }),
    );
    // Swap fails
    mockFetch.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    vi.stubGlobal("fetch", mockFetch);

    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "FakeAddress11111111111111111111111111111111" } as never;

    await expect(
      swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "1000000000", 250),
    ).rejects.toThrow("Jupiter swap tx failed: 500");
  });

  test("passes correct query params to Jupiter quote", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "test" }), { status: 400 }));
    vi.stubGlobal("fetch", mockFetch);

    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "FakeAddress11111111111111111111111111111111" } as never;

    await swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "500000000", 100).catch(
      () => {},
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/swap/v1/quote");
    expect(calledUrl.searchParams.get("inputMint")).toBe(SOL_MINT);
    expect(calledUrl.searchParams.get("outputMint")).toBe(USDC_MINT);
    expect(calledUrl.searchParams.get("amount")).toBe("500000000");
    expect(calledUrl.searchParams.get("slippageBps")).toBe("100");
    expect(calledUrl.searchParams.get("restrictIntermediateTokens")).toBe("true");
  });

  test("passes correct body to Jupiter swap endpoint", async () => {
    const quoteResponse = { inAmount: "1000000000", outAmount: "150000000" };
    const mockFetch = vi.fn();
    // Quote succeeds
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(quoteResponse), { status: 200 }));
    // Swap fails (we just want to verify the request body)
    mockFetch.mockResolvedValueOnce(new Response("fail", { status: 500 }));
    vi.stubGlobal("fetch", mockFetch);

    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "J5UHSLvEuFTEyrZZgjwkSHicZbLYCNz3J5ZhpJt7BLfT" } as never;

    await swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "1000000000", 250).catch(
      () => {},
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const swapCall = mockFetch.mock.calls[1];
    expect(swapCall[0]).toContain("/swap/v1/swap");
    const body = JSON.parse(swapCall[1].body as string);
    expect(body.quoteResponse).toEqual(quoteResponse);
    expect(body.userPublicKey).toBe("J5UHSLvEuFTEyrZZgjwkSHicZbLYCNz3J5ZhpJt7BLfT");
    expect(body.dynamicComputeUnitLimit).toBe(true);
    expect(body.prioritizationFeeLamports).toBe("auto");
  });

  test("throws JupiterNoRouteError on quote 429 rate limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("Rate limited", { status: 429 })),
    );

    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "FakeAddress11111111111111111111111111111111" } as never;

    await expect(
      swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "1000000000", 250),
    ).rejects.toThrow(JupiterNoRouteError);
  });

  test("handles non-JSON error response from quote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 })),
    );

    const { swapViaJupiter } = await import("./solana.js");
    const fakeSigner = { address: "FakeAddress11111111111111111111111111111111" } as never;

    await expect(
      swapViaJupiter(fakeSigner, FAKE_RPC, SOL_MINT, USDC_MINT, "1000000000", 250),
    ).rejects.toThrow(JupiterNoRouteError);
  });
});
