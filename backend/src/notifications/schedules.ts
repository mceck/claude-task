import { sql } from 'drizzle-orm';
import type { NotificationKind } from '@claude-task/shared';
import type { Executor } from '../db/client';

/**
 * Records a Schedule event and plans one phone alert per device of the Schedule's creator, in the transaction
 * that reports it. Unlike Task alerts, these do not depend on following, muting or the Task being closed.
 */
export async function notifySchedule(
  db: Executor,
  event: { eventId: string; kind: Extract<NotificationKind, 'schedule.run_failed' | 'schedule.blocked'>; taskId: string | null; scheduleId: string; userId: string },
): Promise<void> {
  await db.execute(sql`insert into notification_events(id, task_id, schedule_id, kind)
    values (${event.eventId}, ${event.taskId}::uuid, ${event.scheduleId}::uuid, ${event.kind}) on conflict do nothing`);
  await db.execute(sql`insert into push_deliveries(event_id, user_id, device_id, token_hash)
    select ${event.eventId}, u.id, d.id, d.token_hash
    from users u join push_devices d on d.user_id = u.id join logins l on l.id = d.login_id
    where u.id = ${event.userId}::uuid and u.active and not u.must_change_password and l.expires_at > now()
    on conflict do nothing`);
}
