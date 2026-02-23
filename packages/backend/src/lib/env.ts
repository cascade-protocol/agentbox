import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://agentbox:agentbox@localhost:5432/agentbox"),
  HETZNER_API_TOKEN: z.string().optional(),
  HETZNER_SNAPSHOT_ID: z.string().default("361024044"),
  HETZNER_LOCATIONS: z.string().default("nbg1,fsn1"),
  HETZNER_SERVER_TYPE: z.string().default("cx33"),
  API_BASE_URL: z.string().default("http://localhost:8080"),
  CORS_ORIGIN: z.string().default("*"),
  OPERATOR_TOKEN: z.string().min(1),
  OPERATOR_WALLET: z.string().min(32).max(44),
  JWT_SECRET: z.string().min(1),
  PAY_TO_ADDRESS: z.string().default("7NetKx8TuRMBpqYFKZCVetkNuvWCPTrgekmGrsJwTmfN"),
  FACILITATOR_URL: z.string().default("https://facilitator.payai.network"),
  INSTANCE_BASE_DOMAIN: z.string().default("agentbox.fyi"),
  CF_API_TOKEN: z.string().optional(),
  HETZNER_SSH_KEY_IDS: z.string().default("107690222"),
  CF_ZONE_ID: z.string().default("fda671fa572b4c2d26de8aedcbf94f6e"),
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
  LLM_PROVIDER_URL: z.string().url().default("https://sol.blockrun.ai"),
  LLM_PROVIDER_NAME: z.string().default("blockrun"),
  LLM_DEFAULT_MODEL: z.string().default("nvidia/gpt-oss-120b"),
  PORT: z.string().default("8080").transform(Number),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
