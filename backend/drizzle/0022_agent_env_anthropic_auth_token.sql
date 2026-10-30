-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the label.
ALTER TYPE "public"."credential_kind" ADD VALUE IF NOT EXISTS 'anthropic_auth_token';--> statement-breakpoint
-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the column.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "env" jsonb DEFAULT '{}'::jsonb NOT NULL;