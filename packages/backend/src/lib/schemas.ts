import { z } from "zod";

export const instanceStatusSchema = z.enum([
  "provisioning",
  "running",
  "stopped",
  "error",
  "deleting",
]);

export const instanceSchema = z.object({
  id: z.number(),
  name: z.string(),
  userId: z.string(),
  status: instanceStatusSchema,
  ip: z.string(),
  walletAddress: z.string().nullable(),
  gatewayToken: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const createInstanceInputSchema = z.object({});

export const authInputSchema = z.object({
  walletAddress: z.string(),
  signature: z.string(),
  timestamp: z.number(),
});

export const callbackInputSchema = z.object({
  serverId: z.number(),
  walletAddress: z.string(),
  gatewayToken: z.string(),
  secret: z.string(),
});

export const updateInstanceInputSchema = z.object({
  name: z.string().min(1).max(100),
});

export const instanceAccessSchema = instanceSchema.extend({
  ssh: z.string(),
  chatUrl: z.string(),
  terminalUrl: z.string(),
  rootPassword: z.string().nullable(),
});

export type InstanceStatus = z.infer<typeof instanceStatusSchema>;
export type Instance = z.infer<typeof instanceSchema>;
export type InstanceAccess = z.infer<typeof instanceAccessSchema>;
export type CreateInstanceInput = z.infer<typeof createInstanceInputSchema>;
export type CallbackInput = z.infer<typeof callbackInputSchema>;
export type AuthInput = z.infer<typeof authInputSchema>;
