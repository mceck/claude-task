ALTER TYPE "public"."delivery_state" ADD VALUE IF NOT EXISTS 'handled' BEFORE 'not_delivered';--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "delivery_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN IF NOT EXISTS "comment_id" uuid;--> statement-breakpoint
UPDATE "comments" SET "delivery_changed_at" = "updated_at" WHERE "delivery_state" <> 'none' AND "delivery_changed_at" IS NULL;--> statement-breakpoint
-- Every write path changes Delivery its own way; the database records when the state moved.
CREATE OR REPLACE FUNCTION record_delivery_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.delivery_state <> 'none' THEN NEW.delivery_changed_at := clock_timestamp(); END IF;
  ELSIF NEW.delivery_state IS DISTINCT FROM OLD.delivery_state THEN
    NEW.delivery_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS comment_delivery_change ON comments;--> statement-breakpoint
CREATE TRIGGER comment_delivery_change BEFORE INSERT OR UPDATE OF delivery_state ON comments FOR EACH ROW EXECUTE FUNCTION record_delivery_change();
