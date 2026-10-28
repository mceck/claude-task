ALTER TABLE "tasks" ADD COLUMN "chat_title" text;--> statement-breakpoint
-- A Wiki's Agent now lives on its Project, so Chats created earlier keep the Agent they were created with.
UPDATE "projects" SET "default_agent_id" = t."agent_id" FROM "tasks" t
  WHERE t."project_id" = "projects"."id" AND t."number" = 1 AND t."agent_id" IS NOT NULL AND "projects"."kind" = 'wiki';
