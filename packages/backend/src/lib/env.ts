import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgresql://agentbox:agentbox@localhost:5432/agentbox"),
  HETZNER_API_TOKEN: z.string().optional(),
  OPERATOR_TOKEN: z.string().default("dev-token"),
  CALLBACK_SECRET: z.string().default("dev-secret"),
  PORT: z.string().default("3000").transform(Number),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
