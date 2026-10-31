-- Idempotent, like the other upgrades that tests replay over a schema that already has them.
CREATE TABLE IF NOT EXISTS "limit_resume_offers" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"scheduled_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"cancel_reason" text,
	"comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_owner_check";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "scheduled_message_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "auto_resume" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_resume" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_resume_offers" DROP CONSTRAINT IF EXISTS "limit_resume_offers_comment_id_comments_id_fk";--> statement-breakpoint
ALTER TABLE "limit_resume_offers" ADD CONSTRAINT "limit_resume_offers_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_resume_offers" DROP CONSTRAINT IF EXISTS "limit_resume_offers_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "limit_resume_offers" ADD CONSTRAINT "limit_resume_offers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_resume_offers" DROP CONSTRAINT IF EXISTS "limit_resume_offers_decided_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "limit_resume_offers" ADD CONSTRAINT "limit_resume_offers_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_resume_offers" DROP CONSTRAINT IF EXISTS "limit_resume_offers_scheduled_message_id_scheduled_messages_id_fk";--> statement-breakpoint
ALTER TABLE "limit_resume_offers" ADD CONSTRAINT "limit_resume_offers_scheduled_message_id_scheduled_messages_id_fk" FOREIGN KEY ("scheduled_message_id") REFERENCES "public"."scheduled_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT IF EXISTS "scheduled_messages_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT IF EXISTS "scheduled_messages_author_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" DROP CONSTRAINT IF EXISTS "scheduled_messages_comment_id_comments_id_fk";--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_messages_task_idx" ON "scheduled_messages" USING btree ("task_id","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_messages_due_idx" ON "scheduled_messages" USING btree ("state","due_at");--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_scheduled_message_id_scheduled_messages_id_fk";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_scheduled_message_id_scheduled_messages_id_fk" FOREIGN KEY ("scheduled_message_id") REFERENCES "public"."scheduled_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_scheduled_message_idx" ON "attachments" USING btree ("scheduled_message_id");--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_owner_check";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_check" CHECK (("attachments"."comment_id" is not null)::int + ("attachments"."task_id" is not null)::int + ("attachments"."scheduled_message_id" is not null)::int = 1);