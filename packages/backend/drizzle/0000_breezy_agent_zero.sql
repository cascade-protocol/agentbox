CREATE TABLE "instances" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"ip" text NOT NULL,
	"wallet_address" text,
	"gateway_token" text NOT NULL,
	"root_password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
