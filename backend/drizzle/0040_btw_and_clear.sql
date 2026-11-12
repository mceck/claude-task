ALTER TYPE "public"."queue_entry_kind" ADD VALUE IF NOT EXISTS 'btw';--> statement-breakpoint
CREATE TABLE "btw_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"origin_session_id" uuid NOT NULL,
	"fork_session_id" text,
	"state" text DEFAULT 'working' NOT NULL,
	"working_comment_id" uuid,
	"working_job_id" uuid,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "queue_entries_task_unique";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "btw_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "btw_role" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "clear_marker" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN "btw_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "session_events" ADD COLUMN "btw_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "clear_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "clear_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "btw_threads" ADD CONSTRAINT "btw_threads_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "btw_threads" ADD CONSTRAINT "btw_threads_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_btw_thread_id_btw_threads_id_fk" FOREIGN KEY ("btw_thread_id") REFERENCES "public"."btw_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entries_btw_task_unique" ON "queue_entries" USING btree ("task_id") WHERE "queue_entries"."btw_comment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entries_task_unique" ON "queue_entries" USING btree ("task_id") WHERE "queue_entries"."btw_comment_id" is null;