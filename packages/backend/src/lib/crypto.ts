import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

const key = Buffer.from(env.ENCRYPTION_KEY, "hex");

/** AES-256-GCM encrypt. Returns `iv:tag:ciphertext` (all hex). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** AES-256-GCM decrypt. Expects `iv:tag:ciphertext` (all hex). */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Malformed ciphertext");
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(dataHex, "hex", "utf8") + decipher.final("utf8");
}
