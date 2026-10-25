CREATE TABLE "git_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"private_key_ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repository" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "branch_name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "branch_url" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pull_request" jsonb;