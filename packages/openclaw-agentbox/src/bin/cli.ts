/**
 * Standalone CLI for openclaw-agentbox.
 *
 * Runs wallet generation without loading OpenClaw - just Node.js + crypto deps.
 * This is the bulletproof path used by agentbox-init.sh at VM boot time.
 *
 * Usage: openclaw-agentbox generate --output <dir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import { deriveEvmKeypair, deriveSolanaKeypair } from "../wallet.js";

const args = process.argv.slice(2);
const command = args[0];

if (command === "generate") {
  const outIdx = args.indexOf("--output");
  const outShort = args.indexOf("-o");
  const idx = outIdx !== -1 ? outIdx : outShort;
  const dir = idx !== -1 ? args[idx + 1] : undefined;

  if (!dir) {
    console.error("Usage: openclaw-agentbox generate --output <dir>");
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });

  const mnemonic = generateMnemonic(english, 256);
  const sol = deriveSolanaKeypair(mnemonic);
  const evm = deriveEvmKeypair(mnemonic);

  // wallet-sol.json: 64-byte array [32 secret + 32 public] (solana-keygen compatible)
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(sol.secretKey, 0);
  keypairBytes.set(sol.publicKey, 32);
  writeFileSync(join(dir, "wallet-sol.json"), `${JSON.stringify(Array.from(keypairBytes))}\n`, {
    mode: 0o600,
  });

  // wallet-evm.key: raw 0x... private key hex
  writeFileSync(join(dir, "wallet-evm.key"), `${evm.privateKey}\n`, { mode: 0o600 });

  // mnemonic: 24 words plaintext
  writeFileSync(join(dir, "mnemonic"), `${mnemonic}\n`, { mode: 0o600 });

  console.log(sol.address);
} else {
  console.error("Usage: openclaw-agentbox generate --output <dir>");
  process.exit(1);
}
