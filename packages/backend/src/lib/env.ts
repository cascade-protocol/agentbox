import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://agentbox:agentbox@localhost:5432/agentbox"),
  HETZNER_API_TOKEN: z.string().optional(),
  API_BASE_URL: z.string().default("http://localhost:8080"),
  CORS_ORIGIN: z.string().default("*"),
  OPERATOR_TOKEN: z.string().min(1),
  OPERATOR_WALLET: z.string().min(32).max(44),
  JWT_SECRET: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "Must be 64 hex chars (openssl rand -hex 32)"),
  CF_API_TOKEN: z.string().optional(),
  SSH_PRIVATE_KEY: z.string().optional(),
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
  BAGS_API_KEY: z.string().optional(),
  PORT: z.string().default("8080").transform(Number),
  PRIVY_APP_SECRET: z.string().min(1),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
