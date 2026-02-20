import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const instances = pgTable(
  "instances",
  {
    id: integer().primaryKey(),
    name: text().notNull(),
    userId: text("user_id").notNull(),
    status: text().notNull().default("provisioning"),
    ip: text().notNull(),
    walletAddress: text("wallet_address"),
    gatewayToken: text("gateway_token").notNull(),
    rootPassword: text("root_password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("instances_user_id_idx").on(table.userId)],
);
