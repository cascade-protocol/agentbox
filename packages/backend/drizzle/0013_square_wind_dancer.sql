-- Custom migration: integer PK -> UUID PK with server_id column
-- Existing rows get server_id = old integer id, new UUID generated

-- Step 1: Add new columns to instances
ALTER TABLE "instances" ADD COLUMN "server_id" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "primary_ip_id" integer;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "encrypted_mnemonic" text;--> statement-breakpoint

-- Step 2: Copy current integer id to server_id for existing rows
UPDATE "instances" SET "server_id" = "id";--> statement-breakpoint

-- Step 3: Drop the PK constraint, add a temporary UUID column, swap
ALTER TABLE "instances" DROP CONSTRAINT "instances_pkey";--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "new_id" uuid DEFAULT uuidv7();--> statement-breakpoint
UPDATE "instances" SET "new_id" = uuidv7() WHERE "new_id" IS NULL;--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "instances" RENAME COLUMN "new_id" TO "id";--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "instances" ADD PRIMARY KEY ("id");--> statement-breakpoint

-- Step 4: Make ip nullable
ALTER TABLE "instances" ALTER COLUMN "ip" DROP NOT NULL;--> statement-breakpoint

-- Step 5: Add instance_id FK + index to events
ALTER TABLE "events" ADD COLUMN "instance_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_instance_id_idx" ON "events" USING btree ("instance_id");--> statement-breakpoint

-- Step 6: Add server_id index
CREATE INDEX "instances_server_id_idx" ON "instances" USING btree ("server_id");
