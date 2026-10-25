CREATE TYPE "public"."agent_item_kind" AS ENUM('thinking', 'activity', 'turn_summary', 'notice');--> statement-breakpoint
CREATE TYPE "public"."build_status" AS ENUM('building', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('claude_oauth_token', 'anthropic_api_key');--> statement-breakpoint
CREATE TYPE "public"."delivery_state" AS ENUM('none', 'queued', 'delivered', 'not_delivered');--> statement-breakpoint
CREATE TYPE "public"."effort" AS ENUM('low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
CREATE TYPE "public"."image_state" AS ENUM('none', 'building', 'built', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('dispatched', 'running', 'finishing', 'finished', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."permission_mode" AS ENUM('bypassPermissions', 'auto', 'acceptEdits', 'dontAsk');--> statement-breakpoint
CREATE TYPE "public"."queue_entry_kind" AS ENUM('start', 'messages', 'resume_interrupted');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('pending', 'idle', 'running', 'paused', 'closed');--> statement-breakpoint
CREATE TABLE "agent_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"dockerfile" text NOT NULL,
	"base_version" text NOT NULL,
	"status" "build_status" DEFAULT 'building' NOT NULL,
	"image_tag" text,
	"log" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "agent_item_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"avatar_emoji" text NOT NULL,
	"avatar_color" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"dockerfile" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"model" text,
	"effort" "effort",
	"permission_mode" "permission_mode" DEFAULT 'bypassPermissions' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"cpu_limit" double precision,
	"memory_mb" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"runner_token_hash" text,
	"image_tag" text,
	"image_state" "image_state" DEFAULT 'none' NOT NULL,
	"image_base_version" text,
	"container_spec" text,
	"container_state" text DEFAULT 'missing' NOT NULL,
	"force_recreate" boolean DEFAULT false NOT NULL,
	"runner_connected_at" timestamp with time zone,
	"runner_disconnected_at" timestamp with time zone,
	"runner_version" text,
	"claude_version" text,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" "queue_entry_kind" NOT NULL,
	"state" "job_state" DEFAULT 'dispatched' NOT NULL,
	"token_hash" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"projection" jsonb,
	"claude_version" text,
	"mcp_servers" jsonb,
	"setup_output" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"exit_code" integer,
	"signal" text,
	"failure_stage" text,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret" boolean NOT NULL,
	"value" text,
	"value_ciphertext" text,
	"last4" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" "queue_entry_kind" NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"held" boolean DEFAULT false NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_observations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rate_limit_observations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"credential_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "session_events_job_id_seq_pk" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" "session_state" DEFAULT 'pending' NOT NULL,
	"worktree_path" text NOT NULL,
	"started" boolean DEFAULT false NOT NULL,
	"last_seen_task_version" integer DEFAULT 0 NOT NULL,
	"last_job_at" timestamp with time zone,
	"worktree_removal_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"result_subtype" text NOT NULL,
	"is_error" boolean NOT NULL,
	"stop_reason" text,
	"duration_ms" integer NOT NULL,
	"num_tool_calls" integer NOT NULL,
	"cost_usd" double precision,
	"usage" jsonb
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "delivery_state" "delivery_state" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "delivery_reason" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "delivered_in_job_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "queue_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "notice_task_version" integer;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "notice_message" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "setup_script" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "agent_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "current_session_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_builds" ADD CONSTRAINT "agent_builds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_items" ADD CONSTRAINT "agent_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_items" ADD CONSTRAINT "agent_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_items" ADD CONSTRAINT "agent_items_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_items" ADD CONSTRAINT "agent_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_env_vars" ADD CONSTRAINT "project_env_vars_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_entries" ADD CONSTRAINT "queue_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ADD CONSTRAINT "rate_limit_observations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ADD CONSTRAINT "rate_limit_observations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_builds_agent_idx" ON "agent_builds" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_items_task_created_idx" ON "agent_items" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_unique" ON "agents" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_name_unique" ON "credentials" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "jobs_agent_idx" ON "jobs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_session_idx" ON "jobs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_token_unique" ON "jobs" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_vars_name_unique" ON "project_env_vars" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entries_agent_task_unique" ON "queue_entries" USING btree ("agent_id","task_id");--> statement-breakpoint
CREATE INDEX "queue_entries_agent_position_idx" ON "queue_entries" USING btree ("agent_id","position");--> statement-breakpoint
CREATE INDEX "rate_limit_observations_credential_idx" ON "rate_limit_observations" USING btree ("credential_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_task_agent_unique" ON "sessions" USING btree ("task_id","agent_id");--> statement-breakpoint
CREATE INDEX "sessions_agent_idx" ON "sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_job_index_unique" ON "turns" USING btree ("job_id","index");--> statement-breakpoint
CREATE INDEX "turns_agent_idx" ON "turns" USING btree ("agent_id","finished_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_queue_entry_idx" ON "comments" USING btree ("queue_entry_id");