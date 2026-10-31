-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the column.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "project_skills" jsonb;
