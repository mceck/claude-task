CREATE TABLE "agent_profiles" (
	"worker_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"applied_revision" integer DEFAULT -1 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_worker_id_agent_id_pk" PRIMARY KEY("worker_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "worker_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"dockerfile" text NOT NULL,
	"base_version" text NOT NULL,
	"status" "build_status" DEFAULT 'building' NOT NULL,
	"image_tag" text,
	"log" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_containers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"runner_token_hash" text,
	"container_spec" text,
	"container_state" text DEFAULT 'missing' NOT NULL,
	"force_recreate" boolean DEFAULT false NOT NULL,
	"runner_connected_at" timestamp with time zone,
	"runner_disconnected_at" timestamp with time zone,
	"runner_version" text,
	"claude_version" text,
	"idle_since" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"dockerfile" text NOT NULL,
	"services" jsonb DEFAULT '["postgres","redis"]'::jsonb NOT NULL,
	"cpu_limit" double precision,
	"memory_mb" integer,
	"minimum" integer DEFAULT 0 NOT NULL,
	"cap" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"image_tag" text,
	"image_state" "image_state" DEFAULT 'none' NOT NULL,
	"image_base_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_builds" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "agent_builds" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_items" DROP CONSTRAINT "agent_items_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "queue_entries" DROP CONSTRAINT "queue_entries_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "rate_limit_observations" DROP CONSTRAINT "rate_limit_observations_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "queue_entries_agent_task_unique";--> statement-breakpoint
DROP INDEX "queue_entries_agent_position_idx";--> statement-breakpoint
DROP INDEX "sessions_task_agent_unique";--> statement-breakpoint
DROP INDEX "sessions_agent_idx";--> statement-breakpoint
ALTER TABLE "agent_items" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "agent_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "container_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "slot" integer;--> statement-breakpoint
UPDATE "jobs" SET "agent_name" = a."name" FROM "agents" a WHERE a."id" = "jobs"."agent_id";--> statement-breakpoint
-- Existing installations keep working on a minimal Worker; a fresh database starts without one.
INSERT INTO "workers" ("name", "dockerfile", "services", "minimum", "cap", "enabled")
SELECT 'Default', E'FROM claude-task/agent-base\nUSER agent\n', '["postgres","redis"]'::jsonb, 0, 1, true
WHERE EXISTS (SELECT 1 FROM "projects");--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
UPDATE "projects" SET "worker_id" = (SELECT "id" FROM "workers" WHERE "name" = 'Default' LIMIT 1);--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "worker_id" SET NOT NULL;--> statement-breakpoint
-- One Session per Task: keep the Task's current one (or its newest) and move the others' history onto it.
ALTER TABLE "sessions" ADD COLUMN "last_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_slot" integer;--> statement-breakpoint
UPDATE "sessions" SET "last_agent_id" = "agent_id";--> statement-breakpoint
CREATE TEMPORARY TABLE "kept_sessions" AS
SELECT DISTINCT ON (s."task_id") s."task_id", s."id"
FROM "sessions" s JOIN "tasks" t ON t."id" = s."task_id"
ORDER BY s."task_id", (s."id" = t."current_session_id") DESC, s."created_at" DESC;--> statement-breakpoint
UPDATE "jobs" SET "session_id" = k."id" FROM "kept_sessions" k WHERE k."task_id" = "jobs"."task_id" AND "jobs"."session_id" <> k."id";--> statement-breakpoint
UPDATE "agent_items" SET "session_id" = k."id" FROM "kept_sessions" k WHERE k."task_id" = "agent_items"."task_id" AND "agent_items"."session_id" <> k."id";--> statement-breakpoint
-- Queue Entries of the other Sessions: their Comments wait no more.
UPDATE "comments" SET "queue_entry_id" = NULL, "delivery_state" = 'not_delivered', "delivery_reason" = 'agent unassigned'
WHERE "queue_entry_id" IN (SELECT q."id" FROM "queue_entries" q JOIN "kept_sessions" k ON k."task_id" = q."task_id" WHERE q."session_id" <> k."id");--> statement-breakpoint
DELETE FROM "queue_entries" q USING "kept_sessions" k WHERE k."task_id" = q."task_id" AND q."session_id" <> k."id";--> statement-breakpoint
DELETE FROM "sessions" s USING "kept_sessions" k WHERE k."task_id" = s."task_id" AND s."id" <> k."id";--> statement-breakpoint
UPDATE "tasks" SET "current_session_id" = k."id" FROM "kept_sessions" k WHERE k."task_id" = "tasks"."id";--> statement-breakpoint
DROP TABLE "kept_sessions";--> statement-breakpoint
-- Transcripts stay on the old Agent Volumes: every Session starts a new conversation.
UPDATE "jobs" SET "state" = 'interrupted', "finished_at" = now() WHERE "state" IN ('dispatched', 'running', 'finishing');--> statement-breakpoint
UPDATE "sessions" SET "started" = false, "claude_session_id" = NULL, "state" = CASE
  WHEN "state" IN ('idle', 'running') THEN 'pending'::session_state
  WHEN "state" = 'paused' AND EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "sessions"."task_id" AND t."agent_id" IS NOT NULL) THEN 'pending'::session_state
  ELSE "state" END;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
UPDATE "queue_entries" SET "worker_id" = p."worker_id", "kind" = 'start' FROM "tasks" t JOIN "projects" p ON p."id" = t."project_id" WHERE t."id" = "queue_entries"."task_id";--> statement-breakpoint
ALTER TABLE "queue_entries" ALTER COLUMN "worker_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_builds" ADD CONSTRAINT "worker_builds_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_containers" ADD CONSTRAINT "worker_containers_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_builds_worker_idx" ON "worker_builds" USING btree ("worker_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_containers_slot_unique" ON "worker_containers" USING btree ("worker_id","slot");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_containers_token_unique" ON "worker_containers" USING btree ("runner_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "workers_name_unique" ON "workers" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "agent_items" ADD CONSTRAINT "agent_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_container_id_worker_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."worker_containers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ADD CONSTRAINT "rate_limit_observations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_last_agent_id_agents_id_fk" FOREIGN KEY ("last_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_worker_idx" ON "jobs" USING btree ("worker_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entries_task_unique" ON "queue_entries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "queue_entries_worker_position_idx" ON "queue_entries" USING btree ("worker_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_task_unique" ON "sessions" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "dockerfile";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "services";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "configured_extensions_revision";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "extensions_error";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "cpu_limit";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "memory_mb";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runner_token_hash";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "image_tag";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "image_state";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "image_base_version";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "container_spec";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "container_state";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "force_recreate";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runner_connected_at";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runner_disconnected_at";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "runner_version";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "claude_version";--> statement-breakpoint
ALTER TABLE "queue_entries" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "agent_id";