CREATE TABLE "agent_plugins" (
	"agent_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	CONSTRAINT "agent_plugins_agent_id_plugin_id_pk" PRIMARY KEY("agent_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_plugins" ADD CONSTRAINT "agent_plugins_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugins_source_name_idx" ON "plugins" USING btree ("source","name");