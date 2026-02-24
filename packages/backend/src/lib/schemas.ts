import { z } from "zod";

export const instanceStatusSchema = z.enum([
  "provisioning",
  "minting",
  "running",
  "stopped",
  "error",
  "deleting",
  "deleted",
]);

export const provisioningStepSchema = z.string().min(1).max(64);

export const instanceSchema = z.object({
  id: z.number(),
  name: z.string(),
  ownerWallet: z.string(),
  status: instanceStatusSchema,
  ip: z.string(),
  nftMint: z.string().nullable().optional(),
  vmWallet: z.string().nullable().optional(),
  gatewayToken: z.string(),
  terminalToken: z.string().nullable().optional(),
  telegramBotUsername: z.string().nullable().optional(),
  snapshotId: z.string().nullable().optional(),
  provisioningStep: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

const telegramTokenSchema = z
  .string()
  .regex(/^\d+:[A-Za-z0-9_-]{35}$/, "Invalid Telegram bot token format");

/** DNS-safe name: lowercase alphanumeric + hyphens, 3-63 chars, no leading/trailing hyphen. */
export const instanceNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Must be lowercase letters, numbers, and hyphens");

export const createInstanceInputSchema = z.object({
  name: instanceNameSchema.optional(),
  telegramBotToken: telegramTokenSchema.optional(),
});

export const authInputSchema = z.object({
  solanaWalletAddress: z.string().min(32).max(44),
  signature: z.string().min(1).max(256),
  timestamp: z.number(),
});

export const callbackInputSchema = z.object({
  serverId: z.number(),
  solanaWalletAddress: z.string().min(32).max(44),
  gatewayToken: z.string().min(1).max(256),
  secret: z.string().min(1).max(256),
});

export const provisioningUpdateInputSchema = z.object({
  serverId: z.number(),
  secret: z.string().min(1).max(256),
  step: provisioningStepSchema,
});

export const instanceConfigQuerySchema = z.object({
  serverId: z.coerce.number(),
  secret: z.string().min(1).max(256),
});

export const updateInstanceInputSchema = z.object({
  name: z.string().min(1).max(100),
});

export const updateAgentMetadataInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
});

export const telegramSetupInputSchema = z.object({
  telegramBotToken: telegramTokenSchema,
});

export const withdrawInputSchema = z.object({
  token: z.enum(["SOL", "USDC"]),
  amount: z.string().regex(/^(\d+\.?\d*|ALL)$/, "Must be a number or ALL"),
});

export const instanceAccessSchema = instanceSchema.extend({
  chatUrl: z.string(),
  terminalUrl: z.string(),
});

export type InstanceStatus = z.infer<typeof instanceStatusSchema>;
export type Instance = z.infer<typeof instanceSchema>;
export type InstanceAccess = z.infer<typeof instanceAccessSchema>;
export type CreateInstanceInput = z.infer<typeof createInstanceInputSchema>;
export type CallbackInput = z.infer<typeof callbackInputSchema>;
export type ProvisioningUpdateInput = z.infer<typeof provisioningUpdateInputSchema>;
export type AuthInput = z.infer<typeof authInputSchema>;
