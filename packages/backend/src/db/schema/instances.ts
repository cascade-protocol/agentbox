import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const instances = pgTable(
  "instances",
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    ownerWallet: text("owner_wallet").notNull(),
    status: text().notNull().default("provisioning"),
    ip: text().notNull(),
    nftMint: text("nft_mint"),
    vmWallet: text("vm_wallet"),
    gatewayToken: text("gateway_token").notNull(),
    terminalToken: text("terminal_token"),
    callbackToken: text("callback_token"),
    rootPassword: text("root_password"),
    provisioningStep: text("provisioning_step"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("instances_name_idx").on(table.name),
    index("instances_owner_wallet_idx").on(table.ownerWallet),
    index("instances_nft_mint_idx").on(table.nftMint),
  ],
);
