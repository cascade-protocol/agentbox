import { bigint, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index("events_timestamp_idx").on(table.timestamp),
    index("events_event_type_idx").on(table.eventType),
    index("events_entity_idx").on(table.entityType, table.entityId),
  ],
);
