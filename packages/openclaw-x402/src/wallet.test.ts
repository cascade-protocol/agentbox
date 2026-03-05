import { describe, expect, test } from "vitest";
import { deriveEvmKeypair, deriveSolanaKeypair } from "./wallet.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("deriveSolanaKeypair", () => {
  test("returns 32-byte secret and public keys", () => {
    const { secretKey, publicKey } = deriveSolanaKeypair(TEST_MNEMONIC);
    expect(secretKey).toBeInstanceOf(Uint8Array);
    expect(publicKey).toBeInstanceOf(Uint8Array);
    expect(secretKey).toHaveLength(32);
    expect(publicKey).toHaveLength(32);
  });

  test("matches known test vector", () => {
    const { address } = deriveSolanaKeypair(TEST_MNEMONIC);
    expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(address).toBe("3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx");
  });

  test("is deterministic", () => {
    const a = deriveSolanaKeypair(TEST_MNEMONIC);
    const b = deriveSolanaKeypair(TEST_MNEMONIC);
    expect(b.address).toBe(a.address);
    expect(b.secretKey).toEqual(a.secretKey);
    expect(b.publicKey).toEqual(a.publicKey);
  });

  test("different mnemonic produces different keypair", () => {
    const other = deriveSolanaKeypair(
      "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    );
    expect(other.address).not.toBe(deriveSolanaKeypair(TEST_MNEMONIC).address);
  });
});

describe("deriveEvmKeypair", () => {
  test("returns 0x-prefixed hex private key", () => {
    const { privateKey } = deriveEvmKeypair(TEST_MNEMONIC);
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("matches known test vector", () => {
    const { address } = deriveEvmKeypair(TEST_MNEMONIC);
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).toBe("0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb");
  });

  test("is deterministic", () => {
    const a = deriveEvmKeypair(TEST_MNEMONIC);
    const b = deriveEvmKeypair(TEST_MNEMONIC);
    expect(b.address).toBe(a.address);
    expect(b.privateKey).toBe(a.privateKey);
  });

  test("different mnemonic produces different keypair", () => {
    const other = deriveEvmKeypair(
      "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    );
    expect(other.address).not.toBe(deriveEvmKeypair(TEST_MNEMONIC).address);
  });
});
