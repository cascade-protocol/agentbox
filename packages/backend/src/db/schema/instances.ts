import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const instances = pgTable(
  "instances",
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    serverId: integer("server_id"),
    primaryIpId: integer("primary_ip_id"),
    location: text(),
    name: text().notNull(),
    ownerWallet: text("owner_wallet").notNull(),
    status: text().notNull().default("provisioning"),
    ip: text(),
    nftMint: text("nft_mint"),
    vmWallet: text("vm_wallet"),
    gatewayToken: text("gateway_token").notNull(),
    terminalToken: text("terminal_token"),
    callbackToken: text("callback_token"),

    telegramBotToken: text("telegram_bot_token"),
    telegramBotUsername: text("telegram_bot_username"),
    arenaEnabled: boolean("arena_enabled").notNull().default(false),
    snapshotId: text("snapshot_id"),
    provisionConfig: jsonb("provision_config"),
    metadata: jsonb("metadata"),
    provisioningStep: text("provisioning_step"),
    encryptedMnemonic: text("encrypted_mnemonic"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("instances_name_idx").on(table.name),
    index("instances_owner_wallet_idx").on(table.ownerWallet),
    index("instances_nft_mint_idx").on(table.nftMint),
    index("instances_server_id_idx").on(table.serverId),
  ],
);
