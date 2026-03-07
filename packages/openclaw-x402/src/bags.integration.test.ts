import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { beforeAll, describe, expect, test } from "vitest";
import { BagsNoRouteError, getSolBalance, launchOnBags, SOL_MINT, swapViaBags } from "./solana.js";

/**
 * Integration tests for Bags.fm functions. Run against mainnet with real transactions.
 *
 * Requires env vars:
 *   WALLET_PATH  - path to Solana keypair JSON (default: ~/.claude/test-wallet.json)
 *   RPC_URL      - Solana mainnet RPC with WebSocket support
 *   BAGS_API_KEY - Bags.fm API key
 *
 * Run: WALLET_PATH=~/.claude/test-wallet.json RPC_URL=https://... BAGS_API_KEY=... pnpm vitest run src/bags.integration.test.ts
 */

const WALLET_PATH =
  process.env.WALLET_PATH?.replace("~", homedir()) || `${homedir()}/.claude/test-wallet.json`;
const RPC_URL = process.env.RPC_URL || "";
const BAGS_API_KEY = process.env.BAGS_API_KEY || "";

const canRun = RPC_URL !== "" && BAGS_API_KEY !== "";

describe.skipIf(!canRun)("bags.fm integration", { timeout: 60_000 }, () => {
  let signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
  let rpcUrl: string;

  beforeAll(async () => {
    const keypairData = JSON.parse(readFileSync(WALLET_PATH, "utf-8")) as number[];
    signer = await createKeyPairSignerFromBytes(new Uint8Array(keypairData));
    rpcUrl = RPC_URL;
    console.log(`Test wallet: ${signer.address}`);
    const sol = await getSolBalance(rpcUrl, signer.address);
    console.log(`SOL balance: ${sol}`);
  });

  test("getSolBalance returns a number string", async () => {
    const sol = await getSolBalance(rpcUrl, signer.address);
    expect(Number.parseFloat(sol)).toBeGreaterThan(0);
  });

  test("swapViaBags throws BagsNoRouteError for non-existent pair", async () => {
    // Use a fake mint that won't have a Bags pool
    const fakeMint = "11111111111111111111111111111111";
    await expect(
      swapViaBags(signer, rpcUrl, BAGS_API_KEY, SOL_MINT, fakeMint, "10000000", 250),
    ).rejects.toThrow(BagsNoRouteError);
  });

  test("launchOnBags creates a token", async () => {
    const sol = await getSolBalance(rpcUrl, signer.address);
    if (Number.parseFloat(sol) < 0.03) {
      console.log("Skipping launch test - insufficient SOL");
      return;
    }

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    const imageBlob = new Blob([png], { type: "image/png" });

    const result = await launchOnBags(signer, rpcUrl, BAGS_API_KEY, {
      name: `Test ${Date.now()}`,
      symbol: "TEST",
      description: "Integration test token",
      imageBlob,
      initialBuyLamports: 10_000_000, // 0.01 SOL
    });

    console.log(`Launched: mint=${result.mint} tx=${result.signature}`);
    expect(result.mint).toBeTruthy();
    expect(result.signature).toBeTruthy();
  });
});
