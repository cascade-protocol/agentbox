import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://agentbox:agentbox@localhost:5432/agentbox"),
  HETZNER_API_TOKEN: z.string().optional(),
  HETZNER_SNAPSHOT_ID: z.string().default("360041394"),
  HETZNER_LOCATIONS: z.string().default("nbg1,fsn1"),
  HETZNER_SERVER_TYPE: z.string().default("cx33"),
  API_BASE_URL: z.string().default("http://localhost:8080"),
  OPERATOR_TOKEN: z.string().default("dev-token"),
  CALLBACK_SECRET: z.string().default("dev-secret"),
  JWT_SECRET: z.string().default("dev-jwt-secret"),
  PAY_TO_ADDRESS: z.string().default("EjWifpmNpdTJJLq9VgnrUdKELxZyDaQz2HjNbzPE9tFe"),
  FACILITATOR_URL: z.string().default("https://x402.dexter.cash"),
  INSTANCE_BASE_DOMAIN: z.string().default("agentbox.cascade.fyi"),
  CF_API_TOKEN: z.string().optional(),
  HETZNER_SSH_KEY_IDS: z.string().default("107690222"),
  CF_ZONE_ID: z.string().default("fc4f79a479eed4e1231ecd2f99c5f02a"),
  WILDCARD_CERT_PATH: z.string().optional(),
  WILDCARD_KEY_PATH: z.string().optional(),
  PORT: z.string().default("8080").transform(Number),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
