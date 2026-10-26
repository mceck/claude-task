-- Positions must follow commit order per Task: a reader that saw position N must never miss an
-- item that commits later with a lower position. The transaction-scoped lock is taken before the
-- identity value is assigned and released at commit, which serializes activity inserts per Task.
CREATE OR REPLACE FUNCTION record_task_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('task_activity:' || NEW.task_id::text, 0));
  INSERT INTO task_activity(task_id, item_id) VALUES (NEW.task_id, NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
