import { z } from "zod";

export const instanceStatusSchema = z.enum([
  "provisioning",
  "running",
  "stopped",
  "error",
  "deleting",
]);

export const provisioningStepSchema = z.string().min(1).max(64);

export const instanceSchema = z.object({
  id: z.number(),
  name: z.string(),
  userId: z.string(),
  status: instanceStatusSchema,
  ip: z.string(),
  solanaWalletAddress: z.string().nullable(),
  gatewayToken: z.string(),
  terminalToken: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  provisioningStep: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export const createInstanceInputSchema = z.object({});

export const authInputSchema = z.object({
  solanaWalletAddress: z.string().min(32).max(44),
  signature: z.string().min(1).max(256),
  timestamp: z.number(),
});

export const callbackInputSchema = z.object({
  serverId: z.number(),
  solanaWalletAddress: z.string().min(32).max(44),
  gatewayToken: z.string().min(1).max(256),
  agentId: z.string().max(256).optional(),
  provisioningStep: provisioningStepSchema.optional(),
  secret: z.string().min(1).max(256),
});

export const provisioningUpdateInputSchema = z.object({
  serverId: z.number(),
  secret: z.string().min(1).max(256),
  step: provisioningStepSchema,
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
export type ProvisioningUpdateInput = z.infer<typeof provisioningUpdateInputSchema>;
export type AuthInput = z.infer<typeof authInputSchema>;
