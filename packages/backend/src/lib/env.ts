import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://agentbox:agentbox@localhost:5432/agentbox"),
  HETZNER_API_TOKEN: z.string().optional(),
  HETZNER_SNAPSHOT_ID: z.string().default("360499553"),
  HETZNER_LOCATIONS: z.string().default("nbg1,fsn1"),
  HETZNER_SERVER_TYPE: z.string().default("cx33"),
  API_BASE_URL: z.string().default("http://localhost:8080"),
  CORS_ORIGIN: z.string().default("*"),
  OPERATOR_TOKEN: z.string().min(1),
  OPERATOR_WALLET: z.string().min(32).max(44),
  JWT_SECRET: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "Must be 64 hex chars (openssl rand -hex 32)"),
  PAY_TO_ADDRESS: z.string().default("EjWifpmNpdTJJLq9VgnrUdKELxZyDaQz2HjNbzPE9tFe"),
  FACILITATOR_URL: z.string().default("https://x402.dexter.cash"),
  INSTANCE_BASE_DOMAIN: z.string().default("agentbox.fyi"),
  CF_API_TOKEN: z.string().optional(),
  HETZNER_SSH_KEY_IDS: z.string().default("107690222"),
  CF_ZONE_ID: z.string().default("fda671fa572b4c2d26de8aedcbf94f6e"),
  WILDCARD_CERT_PATH: z.string().optional(),
  WILDCARD_KEY_PATH: z.string().optional(),
  SATI_HOT_WALLET_PRIVATE_KEY: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        const parsed = JSON.parse(value);
        return (
          Array.isArray(parsed) &&
          parsed.length === 64 &&
          parsed.every((item: unknown) => typeof item === "number" && item >= 0 && item <= 255)
        );
      } catch {
        return false;
      }
    }, "Must be a Solana CLI keypair JSON array (64 bytes, e.g. output of solana-keygen)")
    .optional(),
  SOLANA_RPC_URL: z.string().url().optional(),
  PORT: z.string().default("8080").transform(Number),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
