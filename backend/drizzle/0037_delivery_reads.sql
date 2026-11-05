-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the columns.
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "delivered_message_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "hurried" boolean DEFAULT false NOT NULL;
