import { z } from "zod";
import { db } from "../db/connection";
import { events } from "../db/schema";
import { logger } from "../logger";

// --- Metadata schemas per event type ---

const empty = z.object({});

const eventMetaSchemas = {
  "instance.created": z.object({
    name: z.string(),
    ownerWallet: z.string(),
    ip: z.string(),
    expiresAt: z.string(),
  }),
  "instance.create_failed": z.object({ error: z.string() }),
  "instance.step_reported": z.object({ step: z.string() }),
  "instance.callback_received": z.object({
    vmWallet: z.string(),
    gatewayToken: z.string(),
  }),
  "instance.funded": z.object({
    asset: z.enum(["SOL", "USDC"]),
    amount: z.string(),
  }),
  "instance.funding_failed": z.object({
    asset: z.enum(["SOL", "USDC"]),
    error: z.string(),
  }),
  "instance.minted": z.object({ mint: z.string(), ownerWallet: z.string() }),
  "instance.mint_failed": z.object({ error: z.string() }),
  "instance.nft_transfer_failed": z.object({
    mint: z.string(),
    error: z.string(),
  }),
  "instance.running": empty,
  "instance.renamed": z.object({ newName: z.string() }),
  "instance.agent_updated": z.object({
    name: z.string().optional(),
    description: z.string().optional(),
  }),
  "instance.deletion_started": empty,
  "instance.deleted": empty,
  "instance.mint_retried": empty,
  "instance.restarted": empty,
  "instance.extended": z.object({ newExpiresAt: z.string() }),
  "instance.expired": empty,
  "instance.claimed": z.object({ previousOwner: z.string() }),
  "instance.recovered": z.object({ mint: z.string() }),
  "auth.signed_in": empty,
  "sync.requested": z.object({ claimed: z.number(), recovered: z.number() }),
  "payment.settled": z.object({ transaction: z.string() }),
} as const;

// --- Derived types ---

export type EventType = keyof typeof eventMetaSchemas;

type EventMeta<T extends EventType> = z.infer<(typeof eventMetaSchemas)[T]>;

// --- Record helper (fire-and-forget) ---

export function recordEvent<T extends EventType>(
  eventType: T,
  actor: { type: string; id: string },
  entity: { type: string; id: string } | null,
  metadata: EventMeta<T>,
): void {
  db.insert(events)
    .values({
      eventType,
      actorType: actor.type,
      actorId: actor.id,
      entityType: entity?.type ?? null,
      entityId: entity?.id ?? null,
      metadata: metadata as Record<string, unknown>,
    })
    .then(() => {})
    .catch((err: unknown) => {
      logger.warn(`Failed to record event ${eventType}: ${String(err)}`);
    });
}
