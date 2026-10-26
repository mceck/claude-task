CREATE TABLE "notification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_deliveries" (
	"event_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "push_deliveries_event_id_user_id_device_id_pk" PRIMARY KEY("event_id","user_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"login_id" text NOT NULL,
	"platform" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_activity" (
	"position" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_activity_position_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"item_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_preferences" (
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"explicit_follow" boolean DEFAULT false NOT NULL,
	"read_position" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "task_preferences_user_id_task_id_pk" PRIMARY KEY("user_id","task_id")
);
--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_device_id_push_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_login_id_logins_id_fk" FOREIGN KEY ("login_id") REFERENCES "public"."logins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_preferences" ADD CONSTRAINT "task_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_preferences" ADD CONSTRAINT "task_preferences_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_deliveries_pending_idx" ON "push_deliveries" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_unique" ON "push_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_activity_item_unique" ON "task_activity" USING btree ("task_id","item_id");--> statement-breakpoint
-- The persisted Timeline is the read-position authority; receiving data never advances it.
CREATE FUNCTION record_task_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_activity(task_id, item_id) VALUES (NEW.task_id, NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER comment_activity AFTER INSERT ON comments FOR EACH ROW EXECUTE FUNCTION record_task_activity();
--> statement-breakpoint
CREATE TRIGGER revision_activity AFTER INSERT ON task_revisions FOR EACH ROW EXECUTE FUNCTION record_task_activity();
--> statement-breakpoint
CREATE TRIGGER agent_activity AFTER INSERT ON agent_items FOR EACH ROW EXECUTE FUNCTION record_task_activity();
--> statement-breakpoint
INSERT INTO task_activity(task_id, item_id)
SELECT task_id, id FROM (
  SELECT task_id, id, created_at FROM comments
  UNION ALL SELECT task_id, id, created_at FROM task_revisions
  UNION ALL SELECT task_id, id, created_at FROM agent_items
) AS timeline ORDER BY created_at, id;
--> statement-breakpoint
-- The outbox is written in the SAME transaction as the lifecycle event. No prose inference.
CREATE FUNCTION enqueue_task_notification(event_key text, task uuid, event_kind text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notification_events(id, task_id, kind) VALUES(event_key, task, event_kind) ON CONFLICT DO NOTHING;
  INSERT INTO push_deliveries(event_id, user_id, device_id, token_hash)
    SELECT event_key, p.user_id, d.id, d.token_hash
    FROM task_preferences p JOIN users u ON u.id = p.user_id
    JOIN push_devices d ON d.user_id = p.user_id JOIN logins l ON l.id = d.login_id
    WHERE p.task_id = task AND p.following AND NOT p.muted AND u.active
      AND NOT u.must_change_password AND l.expires_at > now()
    ON CONFLICT DO NOTHING;
END $$;
--> statement-breakpoint
CREATE FUNCTION notify_persisted_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_task_notification('turn:' || NEW.job_id || ':' || NEW.index, NEW.task_id,
    CASE WHEN NEW.is_error THEN 'turn.failed' ELSE 'turn.completed' END);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER turn_notification AFTER INSERT ON turns FOR EACH ROW EXECUTE FUNCTION notify_persisted_turn();
--> statement-breakpoint
CREATE FUNCTION notify_failed_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'failed' AND OLD.state IS DISTINCT FROM NEW.state
    AND NOT EXISTS (SELECT 1 FROM turns WHERE job_id = NEW.id AND is_error) THEN
    PERFORM enqueue_task_notification('job:' || NEW.id, NEW.task_id, 'session.intervention');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_notification AFTER UPDATE OF state ON jobs FOR EACH ROW EXECUTE FUNCTION notify_failed_job();

--> statement-breakpoint
-- Existing Users start with the same automatic-follow rules as newly created Tasks.
INSERT INTO task_preferences(user_id, task_id, following)
SELECT user_id, task_id, true FROM (
  SELECT created_by_id AS user_id, id AS task_id FROM tasks WHERE created_by_type = 'user'
  UNION SELECT user_id, task_id FROM task_assignees
  UNION SELECT author_id AS user_id, task_id FROM comments WHERE author_type = 'user'
) participants WHERE user_id IN (SELECT id FROM users) ON CONFLICT DO NOTHING;
