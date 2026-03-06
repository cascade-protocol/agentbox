/**
 * Wallet generation and derivation from BIP-39 mnemonic.
 *
 * Ported from packages/openclaw-x402/src/wallet.ts + bin/cli.ts.
 * A single 24-word mnemonic is the root secret for both chains.
 *
 * Solana: SLIP-10 Ed25519 at m/44'/501'/0'/0' (Phantom compatible)
 * EVM: BIP-32 secp256k1 at m/44'/60'/0'/0/0
 */

import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha512 } from "@noble/hashes/sha512";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";

interface WalletData {
  mnemonic: string;
  solana: { address: string; keypairJson: string };
  evm: { address: string; privateKeyHex: string };
}

/** Generate a new 24-word mnemonic and derive both chain keypairs. */
export function generateWallet(): WalletData {
  const mnemonic = generateMnemonic(english, 256);
  return deriveWallet(mnemonic);
}

/** Derive both chain keypairs from an existing mnemonic. */
export function deriveWallet(mnemonic: string): WalletData {
  const sol = deriveSolanaKeypair(mnemonic);
  const evm = deriveEvmKeypair(mnemonic);

  // 64-byte array [32 secret + 32 public] (solana-keygen compatible)
  const keypairBytes = new Uint8Array(64);
  keypairBytes.set(sol.secretKey, 0);
  keypairBytes.set(sol.publicKey, 32);
  const keypairJson = JSON.stringify(Array.from(keypairBytes));

  return {
    mnemonic,
    solana: { address: sol.address, keypairJson },
    evm: { address: evm.address, privateKeyHex: evm.privateKey },
  };
}

/** SLIP-10 Ed25519 derivation at m/44'/501'/0'/0'. */
function deriveSolanaKeypair(mnemonic: string): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  const seed = mnemonicToSeedSync(mnemonic);

  let I = hmac(sha512, "ed25519 seed", seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  for (const index of [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  const secretKey = new Uint8Array(key);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, address: base58.encode(publicKey) };
}

/** BIP-32 secp256k1 derivation at m/44'/60'/0'/0/0. */
function deriveEvmKeypair(mnemonic: string): {
  privateKey: string;
  address: string;
} {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const derived = hdKey.derive("m/44'/60'/0'/0/0");
  if (!derived.privateKey) throw new Error("Failed to derive EVM private key");

  const privateKey = `0x${Buffer.from(derived.privateKey).toString("hex")}`;

  const pubUncompressed = secp256k1.getPublicKey(derived.privateKey, false);
  const hash = keccak_256(pubUncompressed.slice(1));
  const addrHex = Buffer.from(hash.slice(-20)).toString("hex");

  return { privateKey, address: checksumAddress(addrHex) };
}

/** EIP-55 mixed-case checksum encoding. */
function checksumAddress(addr: string): string {
  const hash = Buffer.from(keccak_256(addr)).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}
