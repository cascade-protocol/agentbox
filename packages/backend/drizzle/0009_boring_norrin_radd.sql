DROP INDEX "instances_name_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "instances_name_active_idx" ON "instances" USING btree ("name") WHERE deleted_at IS NULL;