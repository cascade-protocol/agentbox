/**
 * Wallet derivation from BIP-39 mnemonic.
 *
 * A single 24-word mnemonic is the root secret. Both Solana and EVM keypairs
 * are deterministically derived from it - one mnemonic, multiple chains.
 *
 * Solana: SLIP-10 Ed25519 at m/44'/501'/0'/0'
 * EVM: BIP-32 secp256k1 at m/44'/60'/0'/0/0
 *
 * Paths follow Phantom's "bip44Change" grouping (most common, default for new wallets).
 * https://help.phantom.com/hc/en-us/articles/12988493966227-Supported-derivation-paths-in-Phantom
 */

import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha512 } from "@noble/hashes/sha512";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

/**
 * SLIP-10 Ed25519 derivation at m/44'/501'/0'/0' (Phantom/Backpack compatible).
 * Returns 32-byte secret key, 32-byte public key, and base58 address.
 */
export function deriveSolanaKeypair(mnemonic: string): {
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

/**
 * BIP-32 secp256k1 derivation at m/44'/60'/0'/0/0.
 * Returns raw private key hex and EIP-55 checksummed address.
 */
export function deriveEvmKeypair(mnemonic: string): {
  privateKey: string;
  address: string;
} {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const derived = hdKey.derive("m/44'/60'/0'/0/0");
  if (!derived.privateKey) throw new Error("Failed to derive EVM private key");

  const privateKey = `0x${Buffer.from(derived.privateKey).toString("hex")}`;

  // Address from uncompressed public key
  const pubUncompressed = secp256k1.getPublicKey(derived.privateKey, false);
  const hash = keccak_256(pubUncompressed.slice(1)); // drop 0x04 prefix
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
