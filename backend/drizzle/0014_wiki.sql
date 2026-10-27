ALTER TABLE "jobs" ADD COLUMN "discard_output" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "claude_session_id" uuid DEFAULT gen_random_uuid() NOT NULL;