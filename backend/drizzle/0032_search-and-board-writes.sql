ALTER TABLE "comments" ADD COLUMN "started_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "board_write_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_started_agent_id_agents_id_fk" FOREIGN KEY ("started_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;