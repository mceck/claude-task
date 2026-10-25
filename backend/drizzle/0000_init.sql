CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('open', 'active', 'review', 'done', 'closed');--> statement-breakpoint
CREATE TYPE "public"."comment_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('urgent', 'high', 'normal', 'low', 'none');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"blob_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" "comment_kind" NOT NULL,
	"author_type" "actor_type" NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"archived_at" timestamp with time zone,
	"next_task_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"category" "category" NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_assignees" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "task_assignees_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "task_labels" (
	"task_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "task_labels_task_id_label_id_pk" PRIMARY KEY("task_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "task_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status_id" uuid NOT NULL,
	"priority" "priority" DEFAULT 'none' NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" ADD CONSTRAINT "logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_comment_idx" ON "attachments" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "comments_task_created_idx" ON "comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_name_unique" ON "labels" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "logins_user_idx" ON "logins" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_key_unique" ON "projects" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_name_unique" ON "statuses" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "task_assignees_user_idx" ON "task_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_labels_label_idx" ON "task_labels" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_revisions_version_unique" ON "task_revisions" USING btree ("task_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_number_unique" ON "tasks" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "tasks_status_position_idx" ON "tasks" USING btree ("status_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));