CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"token_hash" text,
	"backend_url_override" text,
	"allow_insecure" boolean DEFAULT false NOT NULL,
	"network" text,
	"reported_url" text,
	"controller_version" text,
	"protocol_version" integer,
	"docker_version" text,
	"os" text,
	"architecture" text,
	"cpus" integer,
	"memory_bytes" bigint,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"error" text,
	"cleanup_pending" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cleanups" ADD COLUMN "hosts_pending" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "hosts" ("kind", "name") VALUES ('local', 'Local');
--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "host_id" uuid;
--> statement-breakpoint
UPDATE "workers" SET "host_id" = (SELECT "id" FROM "hosts" WHERE "kind" = 'local');
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "host_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "hosts" ADD CONSTRAINT "hosts_cleanup_pending_cleanups_id_fk" FOREIGN KEY ("cleanup_pending") REFERENCES "public"."cleanups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_name_unique" ON "hosts" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_token_unique" ON "hosts" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_local_unique" ON "hosts" USING btree ("kind") WHERE "hosts"."kind" = 'local';--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE restrict ON UPDATE no action;