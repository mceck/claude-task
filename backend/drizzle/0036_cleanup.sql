-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has it.
CREATE TABLE IF NOT EXISTS "cleanups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"removed" jsonb NOT NULL,
	"reclaimed_bytes" bigint DEFAULT 0 NOT NULL,
	"volumes_pending" integer DEFAULT 0 NOT NULL,
	"errors" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "volume_cleanup_pending" uuid;--> statement-breakpoint
ALTER TABLE "cleanups" DROP CONSTRAINT IF EXISTS "cleanups_requested_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "cleanups" ADD CONSTRAINT "cleanups_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" DROP CONSTRAINT IF EXISTS "workers_volume_cleanup_pending_cleanups_id_fk";--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_volume_cleanup_pending_cleanups_id_fk" FOREIGN KEY ("volume_cleanup_pending") REFERENCES "public"."cleanups"("id") ON DELETE set null ON UPDATE no action;
