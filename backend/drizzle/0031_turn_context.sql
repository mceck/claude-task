-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the columns.
ALTER TABLE "turns" ADD COLUMN IF NOT EXISTS "context_tokens" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN IF NOT EXISTS "context_window" integer;
