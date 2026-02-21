CREATE TABLE "instances" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"ip" text NOT NULL,
	"wallet_address" text,
	"gateway_token" text NOT NULL,
	"agent_id" text,
	"provisioning_step" text,
	"callback_token" text,
	"terminal_token" text,
	"root_password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "instances_user_id_idx" ON "instances" USING btree ("user_id");