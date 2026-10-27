ALTER TABLE "sessions" ALTER COLUMN "claude_session_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "claude_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "chat_generation" integer DEFAULT 0 NOT NULL;