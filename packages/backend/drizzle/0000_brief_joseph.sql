CREATE TABLE "instances" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_wallet" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"ip" text NOT NULL,
	"nft_mint" text,
	"vm_wallet" text,
	"gateway_token" text NOT NULL,
	"terminal_token" text,
	"callback_token" text,
	"root_password" text,
	"provisioning_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "instances_owner_wallet_idx" ON "instances" USING btree ("owner_wallet");--> statement-breakpoint
CREATE INDEX "instances_nft_mint_idx" ON "instances" USING btree ("nft_mint");