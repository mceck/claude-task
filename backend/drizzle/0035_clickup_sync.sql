-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the label.
ALTER TYPE "public"."credential_kind" ADD VALUE IF NOT EXISTS 'clickup_token';--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "clickup_attachment_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "clickup" jsonb;--> statement-breakpoint
ALTER TABLE "statuses" ADD COLUMN IF NOT EXISTS "clickup_status_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_task_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_url" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_linked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_description" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "description_detached" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_seen_status" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_push_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "clickup_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_clickup_unique" ON "tasks" USING btree ("project_id","clickup_task_id");