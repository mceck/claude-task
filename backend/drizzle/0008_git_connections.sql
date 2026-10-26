CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_last4" text,
	"rotation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The single GitHub App settings row becomes the first Git Connection (Spec 05).
INSERT INTO "git_connections" ("provider", "name", "config", "secret_ciphertext", "updated_at")
SELECT 'github', 'GitHub', jsonb_build_object('appId', "app_id"), "private_key_ciphertext", "updated_at" FROM "git_settings" WHERE "id" = 'github';--> statement-breakpoint
-- Linked Repositories keep working: through the migrated connection, or the environment App.
UPDATE "projects" SET "repository" = "repository" || jsonb_build_object(
  'connectionId', coalesce((SELECT "id"::text FROM "git_connections" WHERE "provider" = 'github' ORDER BY "created_at" LIMIT 1), 'env-github')
) WHERE "repository" IS NOT NULL AND NOT ("repository" ? 'connectionId');--> statement-breakpoint
UPDATE "tasks" SET "pull_request" = "pull_request" || '{"provider":"github"}'::jsonb WHERE "pull_request" IS NOT NULL AND NOT ("pull_request" ? 'provider');
