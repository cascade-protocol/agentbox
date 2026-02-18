import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://agentbox:agentbox@localhost:5432/agentbox"),
  HETZNER_API_TOKEN: z.string().optional(),
  HETZNER_SNAPSHOT_ID: z.string().default("359464789"),
  HETZNER_LOCATION: z.string().default("nbg1"),
  HETZNER_SERVER_TYPE: z.string().default("cx23"),
  API_BASE_URL: z.string().default("http://localhost:8080"),
  OPERATOR_TOKEN: z.string().default("dev-token"),
  CALLBACK_SECRET: z.string().default("dev-secret"),
  PORT: z.string().default("8080").transform(Number),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
