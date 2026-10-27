-- The original Wiki migration filled existing Sessions with random Claude ids.
-- Their transcripts still use the Session row's id; NULL restores that fallback.
-- This runs once, before any Reset Chat can create an intentional new identity.
UPDATE "sessions" SET "claude_session_id" = NULL
WHERE EXISTS (
  SELECT 1 FROM "drizzle"."__drizzle_migrations"
  WHERE "hash" = 'ab1884a99d4a0f6b79ea3b44125718e9d2613eb18b1d6748ec4039800ac590f7'
);
