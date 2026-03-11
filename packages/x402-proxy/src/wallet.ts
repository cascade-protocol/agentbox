import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { type ClientEvmSigner, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Load a Solana keypair from a solana-keygen JSON file.
 * Format: JSON array of 64 numbers [32 secret bytes + 32 public bytes].
 */
export async function loadSvmWallet(keypairPath: string): Promise<KeyPairSigner> {
  const data = JSON.parse(readFileSync(keypairPath, "utf-8")) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(data));
}

/**
 * Load an EVM wallet from a hex private key file.
 * Format: 0x-prefixed hex string (66 chars) or raw hex (64 chars).
 */
export function loadEvmWallet(keyPath: string): ClientEvmSigner {
  let hex = readFileSync(keyPath, "utf-8").trim();
  if (!hex.startsWith("0x")) hex = `0x${hex}`;
  const account = privateKeyToAccount(hex as `0x${string}`);
  return toClientEvmSigner(account);
}
