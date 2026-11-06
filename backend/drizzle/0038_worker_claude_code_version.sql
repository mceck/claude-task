-- IF NOT EXISTS keeps the upgrade replayable when a test or a partially applied schema already has the column.
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "claude_code_version" text DEFAULT '2.1.310' NOT NULL;
