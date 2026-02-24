DROP INDEX "instances_name_active_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "instances_name_idx" ON "instances" USING btree ("name");