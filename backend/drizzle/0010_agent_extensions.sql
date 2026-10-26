CREATE TABLE "agent_mcp_servers" (
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	CONSTRAINT "agent_mcp_servers_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"user_invocable" boolean DEFAULT true NOT NULL,
	"files" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "extensions_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "configured_extensions_revision" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "extensions_error" text;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;